import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const phase = atom({ plugin: 'context-handoff', key: 'phase' } as const, 'idle')
const cycle = atom({ plugin: 'context-handoff', key: 'cycle' } as const, 0)
const requestedAt = atom({ plugin: 'context-handoff', key: 'requestedAt' } as const, 0)
const pending = atom({ plugin: 'context-handoff', key: 'pending' } as const, null)
const written = atom({ plugin: 'context-handoff', key: 'written' } as const, null)
const isHeld = atom({ plugin: 'context-handoff', key: 'isHeld' } as const, false)

// Prompts no person typed never carry the handoff; the desktop app's own origin varies by host, so the rest do.
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
const COMPACT_TRIES = 30
// The engine reads a context block past 100,000 characters as a head and a path, and 200,000 in all.
const MAX_BLOCK_CHARS = 95_000
const FILE_KEYS = ['file_path', 'notebook_path']

type Paths = { handoff: string; inventory: string }

const kTokens = (n: number) => `${Math.round(n / 1000)}k`

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text)

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
  return { handoff: `${dir}/handoff-${n}.md`, inventory: `${dir}/inventory-${n}.md` }
}

// A mechanical record of the conversation, so the handoff can be checked against what actually happened.
const buildInventory = (messages: readonly SessionMessage[], header: string[]) => {
  const prompts: string[] = []
  const files = new Map<string, Map<string, number>>()
  const tools = new Map<string, number>()
  const commands: string[] = []
  const searches: string[] = []
  const agents: string[] = []
  const errors: string[] = []

  for (const m of messages) {
    if (m.role === 'user') {
      // The engine's own notes ride in the user's rows; a slash command is kept as its name alone.
      const text = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      const command = /^<command-name>\s*(\S+?)\s*<\/command-name>/.exec(text)
      if (command) prompts.push(`(ran ${command[1]})`)
      else if (text) prompts.push(text)
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

  return [
    '# Conversation inventory',
    '',
    ...header,
    '',
    `## The user's messages, verbatim (${prompts.length})`,
    '',
    ...(prompts.length ? prompts.map((p, i) => `### ${i + 1}\n\n${clip(p, 6000)}\n`) : ['(none)']),
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

const handoffPrompt = (paths: Paths, previous: Paths | null, tokens: number, threshold: number) =>
  [
    `[context-handoff] The context window is at ${kTokens(tokens)} tokens (threshold ${kTokens(threshold)}). The session will be compacted right after this turn, and the handoff you write now is how you will keep the context. Completeness matters more than brevity or tokens.`,
    '',
    "Before handling the user's message above, do this, in order:",
    '1. Go through the WHOLE conversation from its first message, not just the recent turns, including any compaction summary and earlier handoff in it.',
    `2. Read the inventory at \`${paths.inventory}\` with the Read tool: the user's messages verbatim, every file touched, every command, search, subagent and tool error. Use it as a checklist so nothing that still matters is left out.`,
    ...(previous ? [`3. Read the previous handoff at \`${previous.handoff}\` and carry over everything in it that is still relevant.`] : []),
    `${previous ? 4 : 3}. If the working directory is a git repository, run \`git status\` and \`git diff --stat\` and record the uncommitted state and the branch.`,
    `${previous ? 5 : 4}. Write the handoff at \`${paths.handoff}\` with the Write tool, with these sections:`,
    '   - Goal and current state: what the user wants overall and exactly where the work stands.',
    "   - The user's instructions and preferences: quote them verbatim where the wording matters.",
    '   - Decisions and their reasons, and approaches tried or rejected and why.',
    '   - Files: for each relevant file, its path, its role, what changed and why, and its state (done, partial, untested).',
    '   - Tools, commands and environment: build/test/run commands that work, MCP servers and tools used, skills invoked, subagents and what they returned, environment quirks. Name where credentials live, never their values.',
    '   - Work log: done, in progress, and the next steps in order, each concrete enough to act on.',
    '   - Open questions, risks, known bugs, failing tests, and error messages verbatim.',
    '   - Files to re-read after compaction: the few most important ones, each with why.',
    '   - Anything else needed to continue seamlessly.',
    '',
    'Write it in the language of this conversation.',
    '',
    "Only then handle the user's message above as usual. Before ending this turn, add to the handoff's work log what you did for that message. The session is compacted right after this turn.",
  ].join('\n')

const compactInstructions = (paths: Paths) =>
  `A detailed handoff (${paths.handoff}) and a conversation inventory (${paths.inventory}) were written and will be handed back after compaction. Name both files in the summary and stress the current task, its next step, and the user's latest instructions.`

const restoreBlocks = (paths: Paths, handoff: string, inventory: string | null) => [
  [
    'This session was just compacted by the context-handoff mod. Before compaction you wrote the handoff below to keep the important context.',
    `Before answering the message above, re-read the files the handoff lists under "Files to re-read after compaction"; the full handoff is at ${paths.handoff} and the inventory at ${paths.inventory}.`,
    '',
    clip(handoff, MAX_BLOCK_CHARS),
  ].join('\n'),
  ...(inventory ? [`The conversation inventory written before compaction (${paths.inventory}):\n\n${clip(inventory, MAX_BLOCK_CHARS)}`] : []),
]

// A turn of the mod's own does not start in every host (the desktop app runs none), so the handoff rides on the
// person's next message: armed at the threshold, asked for in that message's turn, compacted after it.
const arm = async ($: EngineInterface, why: string) => {
  await update($, phase, () => 'armed')
  $.ui.toast(`${why}: the handoff is written with your next message, then the session compacts`)
}

// Writes the inventory and returns the instructions to attach to the person's prompt.
const prepareHandoff = async ($: EngineInterface, tokens: number, threshold: number) => {
  await update($, phase, () => 'writing')
  const n = await update($, cycle, c => c + 1)
  const paths = await pathsOf($, n)
  const previous = n > 1 ? await pathsOf($, n - 1) : null
  const hasPrevious = previous !== null && (await $.fs.exists(previous.handoff))

  const header = [
    `- Session: ${await $.session.id()}`,
    `- Working directory: ${await $.session.cwd()}`,
    `- Model: ${await $.session.model()}`,
    `- Context: ${kTokens(tokens)} tokens`,
    `- Written: ${new Date(await $.clock.now()).toISOString()}`,
    ...(hasPrevious && previous ? [`- Previous handoff: ${previous.handoff}`, `- Previous inventory: ${previous.inventory}`] : []),
  ]
  await $.fs.write(paths.inventory, buildInventory(await $.session.messages(), header))

  const at = await $.clock.now()
  await update($, requestedAt, () => at)
  return handoffPrompt(paths, hasPrevious ? previous : null, tokens, threshold)
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
  $.ui.toast(`context-handoff: the handoff is written but the session could not compact by itself (${why}). Run /compact; the handoff comes back with your next message.`)
}

// The mod's own session.compact hook does not run for a /compact it raised (the re-entry rule), so it hands the
// handoff back here too.
const compactByCommand = async ($: EngineInterface, n: number, paths: Paths) => {
  try {
    await $.command.run({ command: 'compact', args: compactInstructions(paths) })
    if ((await read($, written)) !== n) return
    await update($, written, () => null)
    await update($, pending, () => n)
    await update($, phase, () => 'idle')
    $.ui.toast('Session compacted: the handoff goes with your next message')
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
        await update($, written, () => null)
        await update($, pending, () => n)
        await update($, phase, () => 'idle')
        $.ui.toast('Session compacted: the handoff goes with your next message')
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

export const register: Register = (on, options) => {
  const threshold = Math.max(50, Number(options.thresholdK) || 300) * 1000
  const retentionDays = Math.max(0, Number(options.retentionDays ?? 2))

  on('session.start', async ($, e, next) => {
    void pruneOld($, retentionDays).catch(() => undefined)
    await $.command.register({
      name: 'context-handoff',
      description: 'Arm a handoff: written with your next message, then the session compacts and gets it back',
    })
    return next(e)
  })

  on('command.run', { command: 'context-handoff' }, async $ => {
    const now = await read($, phase)
    if (now === 'armed') return { text: 'Already armed: the handoff is written with your next message.' }
    if (now !== 'idle') return { text: 'A handoff is already under way.' }
    await update($, isHeld, () => false)
    await arm($, 'Handoff armed')
    return { text: 'Handoff armed: send your next message; the agent writes the handoff first, then the session compacts.' }
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
      await update($, written, () => n)
      await update($, phase, () => 'compacting')
      compactWhenIdle($, n, paths, 1)
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
        await update($, written, () => null)
        await update($, pending, () => n)
        await update($, phase, () => 'idle')
      }
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson = !e.command && !e.isMeta && e.turnId === undefined && !NOT_PERSON.has(e.origin.kind)
    if (!isPerson) return next(e)

    if ((await read($, phase)) === 'armed') {
      const { context } = await $.session.usage()
      const ask = await prepareHandoff($, context.tokens ?? 0, threshold)
      return next({ ...e, context: [...(e.context ?? []), ask] })
    }

    const n = await read($, pending)
    if (n === null) return next(e)
    await update($, pending, () => null)
    const paths = await pathsOf($, n)
    const handoff = await $.fs.read(paths.handoff).catch(() => null)
    if (!handoff) return next(e)
    const inventory = await $.fs.read(paths.inventory).catch(() => null)
    return next({ ...e, context: [...(e.context ?? []), ...restoreBlocks(paths, handoff, inventory)] })
  })
}
