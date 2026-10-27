import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionMessage } from 'claude-code'

const phase = atom({ plugin: 'context-handoff', key: 'phase' } as const, 'idle')
const cycle = atom({ plugin: 'context-handoff', key: 'cycle' } as const, 0)
const requestedAt = atom({ plugin: 'context-handoff', key: 'requestedAt' } as const, 0)
const pendingPath = atom({ plugin: 'context-handoff', key: 'pendingPath' } as const, null)
const written = atom({ plugin: 'context-handoff', key: 'written' } as const, null)
const lastWritten = atom({ plugin: 'context-handoff', key: 'lastWritten' } as const, null)
const isHeld = atom({ plugin: 'context-handoff', key: 'isHeld' } as const, false)

// Prompts no person typed carry the handoff only when `carryOrigins` names their origin; the desktop app's own
// origin varies by host, so the rest do. The handoff needs a turn whose message the agent handles to its end.
const NOT_PERSON = new Set([
  'plugin',
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
])
// Never carried: the mod's own and other plugins' prompts (the re-entry rule), an observer's traffic, which reaches
// another agent's loop, and the engine's follow-up to a UI action, which is read as queued.
const NEVER_CARRY = new Set(['plugin', 'observer', 'observer-activity', 'auto-continuation'])
const COMPACT_TRIES = 30
// The engine reads a context block past 100,000 characters as a head and a path, and 200,000 in all.
const MAX_BLOCK_CHARS = 95_000
// The inventory's received messages, newest kept first; the agent reads the file in pages.
const MAX_MESSAGES_CHARS = 150_000
const FILE_KEYS = ['file_path', 'notebook_path']
// The mod's own blocks ride in the rows they were attached to; the inventory leaves them out.
const OWN_BLOCKS = /\[context-handoff\] The context window|This session was just (?:compacted|cleared) by the context-handoff mod/

type Paths = { handoff: string; inventory: string; lastTurn: string }
type AfterHandoff = 'compact' | 'clear'

const kTokens = (n: number) => `${Math.round(n / 1000)}k`

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text)

// A list option arrives as a string from the config menu, or as a list from settings written by hand.
const listOption = (value: PluginOptions[string] | undefined) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : []).map(s => String(s).trim()).filter(Boolean)

const handoffsRoot = async ($: EngineInterface) => {
  const home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
  return `${home}/.claude/handoffs`
}

const sessionDir = async ($: EngineInterface) => `${await handoffsRoot($)}/${await $.session.id()}`

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000

// Removes the folders of other sessions whose newest file is older than the retention. A folder is kept while its
// session may still need it: the next cycle carries the previous handoff over, and a resumed session re-reads it.
const pruneOld = async ($: EngineInterface, days: number) => {
  if (days <= 0) return
  const root = await handoffsRoot($)
  if (!(await $.fs.exists(root))) return
  const current = await $.session.id()
  const cutoff = (await $.clock.now()) - days * DAY_MS
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  for (const entry of await $.fs.list(root)) {
    if (entry.kind !== 'dir' || entry.isLink || entry.name === current || !SESSION_ID.test(entry.name)) continue
    const dir = `${root}/${entry.name}`
    const newest = Math.max(0, ...(await $.fs.list(dir)).map(f => f.mtimeMs))
    if (newest >= cutoff) continue
    const argv = isWindows ? ['cmd', '/c', 'rmdir', '/s', '/q', dir.replace(/\//g, '\\')] : ['rm', '-rf', dir]
    await $.process.run(argv).catch(() => undefined)
  }
}

const pathsOf = async ($: EngineInterface, n: number): Promise<Paths> => {
  const dir = await sessionDir($)
  return { handoff: `${dir}/handoff-${n}.md`, inventory: `${dir}/inventory-${n}.md`, lastTurn: `${dir}/last-turn-${n}.md` }
}

// The handoff's path names the cycle's other files; a /clear leaves them under the session id that wrote them.
const pathsFromHandoff = (handoff: string): Paths => ({
  handoff,
  inventory: handoff.replace(/handoff-(\d+)\.md$/, 'inventory-$1.md'),
  lastTurn: handoff.replace(/handoff-(\d+)\.md$/, 'last-turn-$1.md'),
})

// Where a received message came from, read off its text: the engine frames what no person typed.
const sourceOf = (m: SessionMessage, text: string) => {
  if (/^<task-notification>/.test(text)) return 'task notification'
  if (/\[Subagent hand-back\]/.test(text)) return 'subagent report'
  if (/^(?:<side-sessions-event>|<teammate-message|<cross-session-message|Another Claude session)/.test(text)) return 'another session'
  if (/^This session is being continued from a previous conversation/.test(text)) return 'compaction summary'
  if (m.toolResults?.length) return 'delivered mid-turn'
  return 'user'
}

// A user row's own words: the engine's notes and the mod's blocks left out, a slash command kept as its name alone.
const receivedText = (m: SessionMessage) => {
  let text = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  const own = OWN_BLOCKS.exec(text)
  if (own) text = text.slice(0, own.index).trim()
  const command = /^<command-name>\s*(\S+?)\s*<\/command-name>/.exec(text)
  return command ? `(ran ${command[1]})` : text
}

const describeUse = (use: SessionMessage['toolUses'][number]) => {
  const input = use.input
  const what = [input.command, input.file_path, input.notebook_path, input.pattern, input.description, input.url].find(v => typeof v === 'string')
  return `${use.isError ? '✗' : '✓'} [${use.tool}]${typeof what === 'string' ? ` ${clip(what.replace(/\s+/g, ' '), 300)}` : ''}`
}

// A mechanical record of the turn that wrote the handoff, from the message that started it to the reply that ended
// it, so the agent knows exactly where it stopped after a /clear. The handoff's own reads and writes are left out.
const buildLastTurn = (messages: readonly SessionMessage[], dir: string, at: string) => {
  let start = -1
  messages.forEach((m, i) => {
    if (m.role === 'user' && !m.toolResults?.length && receivedText(m)) start = i
  })
  if (start < 0) return null
  const first = messages[start]!
  const steps: string[] = []
  const delivered: string[] = []
  let reply = ''
  for (const m of messages.slice(start + 1)) {
    if (m.role === 'user') {
      const text = receivedText(m)
      if (text) delivered.push(`### ${sourceOf(m, text)}\n\n${clip(text, 6000)}\n`)
      continue
    }
    if (m.text.trim()) reply = m.text.trim()
    for (const use of m.toolUses) {
      const path = use.input.file_path
      if (typeof path === 'string' && path.replace(/\\/g, '/').startsWith(`${dir}/`)) continue
      steps.push(describeUse(use))
    }
  }
  const firstText = receivedText(first)
  return [
    '# Last turn before the clear',
    '',
    `Recorded from the transcript when the turn ended (${at}).`,
    '',
    `## The message the turn handled (${sourceOf(first, firstText)})`,
    '',
    clip(firstText, 20_000),
    '',
    `## What was done (${steps.length} tool calls)`,
    '',
    ...(steps.length ? [...(steps.length > 150 ? [`(${steps.length - 150} earlier calls left out)`] : []), ...steps.slice(-150).map(s => `- ${s}`)] : ['(none)']),
    '',
    ...(delivered.length ? ['## Messages delivered during the turn', '', ...delivered, ''] : []),
    '## The final reply',
    '',
    clip(reply || '(none)', 20_000),
    '',
  ].join('\n')
}

// A mechanical record of the conversation, so the handoff can be checked against what actually happened.
const buildInventory = (messages: readonly SessionMessage[], header: string[]) => {
  const received: { source: string; text: string }[] = []
  const files = new Map<string, Map<string, number>>()
  const tools = new Map<string, number>()
  const commands: string[] = []
  const searches: string[] = []
  const agents: string[] = []
  const errors: string[] = []

  for (const m of messages) {
    if (m.role === 'user') {
      const text = receivedText(m)
      if (text) received.push({ source: text.startsWith('(ran ') ? 'user' : sourceOf(m, text), text })
      continue
    }
    for (const use of m.toolUses) {
      const input = use.input
      tools.set(use.tool, (tools.get(use.tool) ?? 0) + 1)
      for (const key of FILE_KEYS) {
        const path = input[key]
        if (typeof path !== 'string') continue
        const ops = files.get(path) ?? new Map<string, number>()
        ops.set(use.tool, (ops.get(use.tool) ?? 0) + 1)
        files.set(path, ops)
      }
      if (typeof input.command === 'string') commands.push(`${use.isError ? '✗' : '✓'} [${use.tool}] ${clip(input.command, 400)}`)
      if (typeof input.pattern === 'string') searches.push(`[${use.tool}] ${clip(input.pattern, 200)}${typeof input.path === 'string' ? ` in ${input.path}` : ''}`)
      if (use.tool === 'Agent') {
        agents.push(`${String(input.subagent_type ?? 'general-purpose')}: ${String(input.description ?? '')}${use.agentId ? ` (agent ${use.agentId})` : ''}`)
      }
      if (use.isError) errors.push(`${use.tool}: ${clip((use.text ?? '').replace(/\s+/g, ' '), 300)}`)
    }
  }

  const list = (items: string[], last: number) =>
    items.length === 0 ? ['(none)'] : [...(items.length > last ? [`(${items.length - last} earlier entries left out)`] : []), ...items.slice(-last).map(i => `- ${i}`)]

  // The newest messages matter most; the earlier ones past the budget are counted, not kept.
  const blocks: string[] = []
  let chars = 0
  for (const [i, { source, text }] of [...received.entries()].reverse()) {
    const block = `### ${i + 1} · ${source}\n\n${clip(text, 6000)}\n`
    if (blocks.length > 0 && chars + block.length > MAX_MESSAGES_CHARS) break
    blocks.unshift(block)
    chars += block.length
  }
  const leftOut = received.length - blocks.length

  return [
    '# Conversation inventory',
    '',
    ...header,
    '',
    `## Messages received, verbatim (${received.length})`,
    '',
    'Each is headed by where it came from: the user, another session, a subagent report, a task notification, a compaction summary.',
    '',
    ...(leftOut > 0 ? [`(${leftOut} earlier messages left out)`, ''] : []),
    ...(blocks.length ? blocks : ['(none)']),
    '',
    `## Files touched (${files.size})`,
    '',
    ...list([...files].map(([path, ops]) => `${path}: ${[...ops].map(([tool, n]) => `${tool}×${n}`).join(', ')}`), 500),
    '',
    '## Tools used',
    '',
    ...list([...tools].sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${tool}: ${n}`), 200),
    '',
    `## Shell commands (${commands.length}, ✗ = errored)`,
    '',
    ...list(commands, 300),
    '',
    `## Searches (${searches.length})`,
    '',
    ...list(searches, 100),
    '',
    `## Subagents launched (${agents.length})`,
    '',
    ...list(agents, 100),
    '',
    `## Tool errors (${errors.length})`,
    '',
    ...list(errors, 50),
    '',
  ].join('\n')
}

const handoffPrompt = (paths: Paths, previous: string | null, tokens: number, threshold: number, maxWords: number, after: AfterHandoff) => {
  const steps = [
    'Go through the WHOLE conversation from its first message, not just the recent turns, including any compaction summary and earlier handoff in it.',
    `Read the inventory at \`${paths.inventory}\` with the Read tool, ALL of it: one Read returns about 2000 lines, so if it goes on, keep reading with \`offset\` and \`limit\` until its end. It lists the messages received verbatim, every file touched, every command, search, subagent and tool error. Use it as a checklist so nothing that still matters is left out.`,
    ...(previous
      ? [`Read the previous handoff at \`${previous}\` and consolidate it into the new one: merge what still matters into the sections below and drop what is done or obsolete. Do not append it as it stands; the handoff must not grow with every cycle.`]
      : []),
    'If the working directory is a git repository, run `git status` and `git diff --stat` and record the uncommitted state and the branch.',
    [
      `Write the handoff at \`${paths.handoff}\` with the Write tool, with these sections:`,
      '   - Goal and current state: what is wanted overall and exactly where the work stands.',
      "   - The user's instructions and preferences: quote them verbatim where the wording matters.",
      '   - Decisions and their reasons, and approaches tried or rejected and why.',
      '   - Files: for each relevant file, its path, its role, what changed and why, and its state (done, partial, untested). Name files by path; never copy their content.',
      '   - Tools, commands and environment: build/test/run commands that work, MCP servers and tools used, skills invoked, subagents and other sessions and what they returned, environment quirks. Name where credentials live, never their values.',
      '   - Work log: done, in progress, and the next steps in order, each concrete enough to act on.',
      '   - Open questions, risks, known bugs, failing tests, and error messages verbatim.',
      '   - Files to re-read after compaction: the few most important ones, each with why.',
      '   - Anything else needed to continue seamlessly.',
      '   - Last turn and next step, as the final section: the message this turn handles (who sent it and what it asks), what you did for it and how it ended, and the exact next step you will take, concrete enough to start on without asking.',
    ].join('\n'),
  ]
  return [
    `[context-handoff] The context window is at ${kTokens(tokens)} tokens (threshold ${kTokens(threshold)}). The session will be ${after === 'clear' ? 'cleared' : 'compacted'} right after this turn, and the handoff you write now is how you will keep the context.`,
    `Be complete on decisions, state and next steps; refer to files by path instead of copying their content${maxWords > 0 ? `; keep the handoff under ${maxWords} words` : ''}.`,
    '',
    'Before handling the message above, whether it came from the user, another session or a background task, do this, in order:',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    'Write it in the language of this conversation.',
    ...(after === 'clear'
      ? ['', 'After the clear nothing of this conversation remains but this handoff and a mechanical record of this turn: the last section is what you will resume from, so it must say exactly where you stopped and what comes next.']
      : []),
    '',
    `Only then handle the message above as usual. Before ending this turn, update the handoff's work log and its "Last turn and next step" section with what you did for that message, how it ended, and the exact next step. The session is ${after === 'clear' ? 'cleared' : 'compacted'} right after this turn.`,
  ].join('\n')
}

// The handoff is the source of truth; a long summary beside it would only be context paid for twice.
const compactInstructions = (paths: Paths) =>
  `A handoff was written at ${paths.handoff} and is handed back in full after compaction: it is the source of truth. Keep this summary minimal: name that file and the immediate next step, nothing else.`

// After a /clear the handoff is all that is left, so the record of the turn that wrote it goes back with it.
const restoreBlocks = (paths: Paths, handoff: string, how: 'compacted' | 'cleared', lastTurn: string | null) => [
  [
    `This session was just ${how} by the context-handoff mod. Before that you wrote the handoff below to keep the important context.`,
    ...(how === 'cleared'
      ? [`Nothing else of the conversation is left. Resume from the next step under the handoff's "Last turn and next step", checked against the record of that turn ${lastTurn ? 'that follows the handoff' : `at ${paths.lastTurn}, if it was written`}.`]
      : []),
    `Before answering the message above, re-read the files the handoff lists under "Files to re-read after compaction". The handoff is at ${paths.handoff}; the inventory it was checked against is at ${paths.inventory}, to read only if the handoff leaves something out.`,
    '',
    clip(handoff, MAX_BLOCK_CHARS),
  ].join('\n'),
  ...(how === 'cleared' && lastTurn ? [`The last turn before the clear (${paths.lastTurn}):\n\n${clip(lastTurn, MAX_BLOCK_CHARS)}`] : []),
]

// A turn of the mod's own does not start in every host (the desktop app runs none), so the handoff rides on the
// next message that may carry it: armed at the threshold, asked for in that message's turn, compacted after it.
const arm = async ($: EngineInterface, why: string) => {
  await update($, phase, () => 'armed')
  $.ui.toast(`${why}: the handoff is written with the next message, then the session compacts`)
}

// Writes the inventory and returns the instructions to attach to the prompt.
const prepareHandoff = async ($: EngineInterface, tokens: number, threshold: number, maxWords: number, after: AfterHandoff) => {
  await update($, phase, () => 'writing')
  const n = await update($, cycle, c => c + 1)
  const paths = await pathsOf($, n)
  // The last handoff confirmed written, not the cycle before: a failed cycle wrote none.
  const last = await read($, lastWritten)
  const previous = last !== null && last !== paths.handoff && (await $.fs.exists(last)) ? last : null

  const header = [
    `- Session: ${await $.session.id()}`,
    `- Working directory: ${await $.session.cwd()}`,
    `- Model: ${await $.session.model()}`,
    `- Context: ${kTokens(tokens)} tokens`,
    `- Written: ${new Date(await $.clock.now()).toISOString()}`,
    ...(previous ? [`- Previous handoff: ${previous}`, `- Previous inventory: ${pathsFromHandoff(previous).inventory}`] : []),
  ]
  await $.fs.write(paths.inventory, buildInventory(await $.session.messages(), header))

  const at = await $.clock.now()
  await update($, requestedAt, () => at)
  return handoffPrompt(paths, previous, tokens, threshold, maxWords, after)
}

const giveUp = async ($: EngineInterface, why: string) => {
  await update($, phase, () => 'idle')
  await update($, isHeld, () => true)
  $.ui.toast(`context-handoff: ${why}. No automatic retry until the session compacts; /context-handoff arms it again.`)
}

// The handoff is written but the session did not compact by itself: a /compact by the person still hands it back.
const askForCompact = async ($: EngineInterface, why: string) => {
  await update($, phase, () => 'idle')
  $.ui.log(`context-handoff: automatic compaction failed: ${why}`, { to: 'debug' })
  $.ui.toast(`context-handoff: the handoff is written but the session could not compact by itself (${why}). Run /compact; the handoff comes back with the next message.`)
}

const handBack = async ($: EngineInterface, handoff: string, what: string) => {
  await update($, written, () => null)
  await update($, pendingPath, () => handoff)
  await update($, phase, () => 'idle')
  $.ui.toast(`Session ${what}: the handoff goes with the next message`)
}

// The mod's own session.compact hook does not run for a /compact it raised (the re-entry rule), so it hands the
// handoff back here too.
const compactByCommand = async ($: EngineInterface, n: number, paths: Paths) => {
  try {
    await $.command.run({ command: 'compact', args: compactInstructions(paths) })
    if ((await read($, written)) !== n) return
    await handBack($, paths.handoff, 'compacted')
  } catch (error) {
    await askForCompact($, error instanceof Error ? error.message : String(error))
  }
}

// Compacting rejects while a turn runs; the handoff turn is still closing when its turn.complete fires.
const compactWhenIdle = ($: EngineInterface, n: number, paths: Paths, attempt: number) => {
  $.clock.after(1000, () => {
    void $.session.compact({ instructions: compactInstructions(paths) }).then(
      async result => {
        if (result.skip !== undefined) return askForCompact($, `skipped: ${result.skip}`)
        await handBack($, paths.handoff, 'compacted')
      },
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error)
        $.ui.log(`context-handoff: compact attempt ${attempt} rejected: ${why}`, { to: 'debug' })
        // An SDK host (the desktop app, -p) compacts only inside a turn: run /compact as a command there instead.
        if (/not available in a headless/i.test(why)) return compactByCommand($, n, paths)
        return attempt < COMPACT_TRIES ? compactWhenIdle($, n, paths, attempt + 1) : askForCompact($, why)
      },
    )
  })
}

// A /clear drops the conversation outright, so nothing is summarized beside the handoff. The process goes on under
// a new session id and may start the state over, so what the next message needs is written after it. Where the
// host refuses the command, the session compacts instead.
const clearWhenIdle = ($: EngineInterface, n: number, paths: Paths) => {
  $.clock.after(1000, () => {
    void $.command.run({ command: 'clear' }).then(
      async () => {
        await update($, lastWritten, () => paths.handoff)
        await update($, isHeld, () => false)
        await handBack($, paths.handoff, 'cleared')
      },
      (error: unknown) => {
        $.ui.log(`context-handoff: /clear rejected, compacting instead: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
        compactWhenIdle($, n, paths, 1)
      },
    )
  })
}

export const register: Register = (on, options) => {
  const threshold = Math.max(50, Number(options.thresholdK) || 300) * 1000
  const retentionDays = Math.max(0, Number(options.retentionDays ?? 2))
  const maxWords = Math.max(0, Number(options.handoffMaxWords ?? 0) || 0)
  const after: AfterHandoff = options.afterHandoff === 'clear' ? 'clear' : 'compact'
  const carry = new Set(listOption(options.carryOrigins).filter(kind => !NEVER_CARRY.has(kind)))

  on('session.start', async ($, e, next) => {
    void pruneOld($, retentionDays).catch(() => undefined)
    await $.command.register({
      name: 'context-handoff',
      description: 'Arm a handoff: written with the next message, then the session compacts and gets it back',
      argumentHint: '[status]',
    })
    return next(e)
  })

  on('command.run', { command: 'context-handoff' }, async ($, e) => {
    if (e.args.trim() === 'status') {
      const { context } = await $.session.usage()
      return {
        text: [
          `Phase: ${await read($, phase)}${(await read($, isHeld)) ? ' (held after a failed cycle)' : ''}`,
          `Context: ${kTokens(context.tokens ?? 0)} of a ${kTokens(threshold)} threshold`,
          `Carries on: ${carry.size ? [...carry].join(', ') : 'messages a person typed only'}`,
          `After the handoff: ${after}`,
          `Last handoff: ${(await read($, lastWritten)) ?? '(none)'}`,
          `Waiting to go back: ${(await read($, pendingPath)) ?? '(none)'}`,
        ].join('\n'),
      }
    }
    const now = await read($, phase)
    if (now === 'armed') return { text: 'Already armed: the handoff is written with the next message.' }
    if (now !== 'idle') return { text: 'A handoff is already under way.' }
    await update($, isHeld, () => false)
    await arm($, 'Handoff armed')
    return { text: 'Handoff armed: with the next message the agent writes the handoff first, then the session compacts.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const now = await read($, phase)
    if (now === 'writing') {
      if (e.reason !== 'answer') {
        await giveUp($, 'the handoff turn did not finish')
        return result
      }
      const n = await read($, cycle)
      const paths = await pathsOf($, n)
      const since = await read($, requestedAt)
      const stat = await $.fs.stat(paths.handoff).catch(() => undefined)
      if (!stat || stat.mtimeMs < since - 2000) {
        await giveUp($, `no handoff was written at ${paths.handoff}`)
        return result
      }
      const record = buildLastTurn(await $.session.messages(), await sessionDir($), new Date(await $.clock.now()).toISOString())
      if (record) await $.fs.write(paths.lastTurn, record).catch(() => undefined)
      await update($, lastWritten, () => paths.handoff)
      await update($, written, () => n)
      await update($, phase, () => 'compacting')
      if (after === 'clear') clearWhenIdle($, n, paths)
      else compactWhenIdle($, n, paths, 1)
      return result
    }

    if (now !== 'idle' || e.reason !== 'answer' || (await read($, isHeld))) return result
    const { context } = await $.session.usage()
    if ((context.tokens ?? 0) >= threshold) await arm($, `Context at ${kTokens(context.tokens ?? 0)}`)
    return result
  })

  // Any compaction of the main conversation re-arms the watch, /compact typed by the person included, and hands
  // back a handoff that was written and still waits for one.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await update($, isHeld, () => false)
      const n = await read($, written)
      if (n !== null) {
        const { handoff } = await pathsOf($, n)
        await update($, written, () => null)
        await update($, pendingPath, () => handoff)
        await update($, phase, () => 'idle')
      }
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    $.ui.log(`context-handoff: prompt.submit origin=${kind} isMeta=${e.isMeta === true} turnId=${e.turnId ?? '-'} command=${e.command?.name ?? '-'}`, {
      to: 'debug',
    })
    const isPerson = !e.command && !e.isMeta && e.turnId === undefined && !NOT_PERSON.has(kind)
    // The engine queues another session's message and a task's notification isMeta, so a carried origin may be.
    const isCarried = !e.command && e.turnId === undefined && carry.has(kind)
    if (!isPerson && !isCarried) return next(e)

    if ((await read($, phase)) === 'armed') {
      const { context } = await $.session.usage()
      const ask = await prepareHandoff($, context.tokens ?? 0, threshold, maxWords, after)
      return next({ ...e, context: [...(e.context ?? []), ask] })
    }

    const handoffPath = await read($, pendingPath)
    if (handoffPath === null) return next(e)
    await update($, pendingPath, () => null)
    const handoff = await $.fs.read(handoffPath).catch(() => null)
    if (!handoff) return next(e)
    const paths = pathsFromHandoff(handoffPath)
    const how = handoffPath.startsWith(`${await sessionDir($)}/`) ? 'compacted' : 'cleared'
    const lastTurn = how === 'cleared' ? await $.fs.read(paths.lastTurn).catch(() => null) : null
    return next({ ...e, context: [...(e.context ?? []), ...restoreBlocks(paths, handoff, how, lastTurn)] })
  })
}
