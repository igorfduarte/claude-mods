import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'agent-deck'
const STEP = 'mcp__agent-deck__step'

const band = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }
const pane = { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

const TWO: [string, string][] = [
  ['Review the parser', 'general-purpose'],
  ['Map the tests', 'Explore'],
]
const THREE_ALIKE: [string, string][] = [
  ['Count the files', 'general-purpose'],
  ['Read the README', 'general-purpose'],
  ['List the hooks', 'general-purpose'],
]

// Subagents start; the engine beneath answers each spawn with its id.
async function twoAgents($: Engine, on: On, agents = TWO) {
  mock.clock(on, { now: Date.parse('2026-10-22T12:00:00Z') })
  const prompts: string[] = []
  const opened: string[] = []
  let n = 0
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    n += 1
    return { model: 'claude-opus-5-5', agentId: `a${n}` }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  // Stands for the engine's own drawing of a site the mod leaves alone.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const spawn = (description: string, subagentType: string) =>
    $.agent.spawn({
      tool_use_id: `t-${description}`,
      prompt: `Do ${description}.`,
      description,
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    } as never)

  for (const [description, type] of agents) await spawn(description, type)
  return { prompts, opened }
}

// The color of each row's type label in the panel, top to bottom.
async function typeColors($: Engine, surface: 'terminal' | 'desktop'): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'agent-deck', props: pane })
  const colors =
    surface === 'desktop'
      ? (await ui.findAll({ type: 'Svg' })).flatMap(el => [...String(el.props.source).matchAll(/<tspan fill="(#[0-9a-f]{6})" font-weight="600">/gi)].map(m => m[1] ?? ''))
      : (await ui.findAll({ type: 'Text', text: /^general-purpose$/ })).map(el => String(el.props.color))
  await ui.unmount()
  return colors
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band and the panel follow two subagents`, async ($, on) => {
    const { prompts, opened } = await twoAgents($, on)

    // Each brief asks for step reports, and the panel opened once for the batch.
    expect(prompts.every(p => p.includes(STEP))).toBe(true)
    expect(opened).toEqual(['agent-deck'])

    const bar = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await bar.find({ key: 'deck-agents' }))?.props.label).toBe('×2')
    await bar.unmount()

    // The first reports its plan; a call from the main loop changes nothing.
    expect(await $.tool.call({ tool: STEP, agentId: 'a1', done: 1, total: 4, note: 'reading the code' } as never)).toMatchObject({ result: 'ok' })
    expect(await $.tool.call({ tool: STEP, done: 3 } as never)).toMatchObject({ result: 'ignored: only subagents report steps' })

    // The second finishes.
    await $.turn.complete({ agentId: 'a2', reason: 'answer', answer: 'pronto', turnId: 'x' } as never)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'agent-deck', props: pane })
    expect((await ui.find({ key: 'deck-done' }))?.props.label).toBe('▾ Finished · 1')
    if (surface === 'desktop') {
      // Header plus one row per run, each one Svg.
      const drawn = await ui.findAll({ type: 'Svg' })
      expect(drawn.length).toBe(3)
      const sources = drawn.map(el => String(el.props.source)).join('')
      expect(sources).toContain('Review the parser')
      expect(sources).toContain('1/4')
      expect(sources).not.toContain('undefined')
      expect(sources).not.toContain('NaN')
    } else {
      expect(await ui.find({ type: 'Text', text: /Review the parser/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /reading the code/ })).toBeDefined()
    }
    await ui.unmount()
  })

  test(`${surface}: the band says a run failed, and its own ✕ hides it`, async ($, on) => {
    await twoAgents($, on)
    await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: '', turnId: 'x' } as never)
    await $.turn.complete({ agentId: 'a2', reason: 'error', answer: '', turnId: 'y' } as never)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    // A plain Button the surface always draws, not the desktop's native close.
    expect((await ui.find({ key: 'deck-dismiss' }))?.props.role).toBeUndefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /1 failed/ })).toBeDefined()
    else expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('1 failed')
    await ui.press({ key: 'deck-dismiss' })
    await ui.unmount()

    const after = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await after.find({ key: 'deck-agents' })).toBeUndefined()
    await after.unmount()
  })

  test(`${surface}: subagents of one type each wear their own color`, async ($, on) => {
    await twoAgents($, on, THREE_ALIKE)
    const colors = await typeColors($, surface)
    expect(colors.length).toBe(3)
    expect(new Set(colors).size).toBe(3)
  })

  test(`${surface}: with colors set to type, one type shares a color`, { options: { colors: 'type' } }, async ($, on) => {
    await twoAgents($, on, THREE_ALIKE)
    const colors = await typeColors($, surface)
    expect(colors.length).toBe(3)
    expect(new Set(colors).size).toBe(1)
  })

  test(`${surface}: a narrow band still fits its row`, async ($, on) => {
    await twoAgents($, on)
    const narrow = { ...band, bodyColumns: 44 }
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: narrow })
    expect(await ui.find({ key: 'deck-dismiss' })).toBeDefined()
    if (surface === 'terminal') {
      // The label gives way before the bar and the buttons do.
      expect(await ui.find({ type: 'Text', text: /\d\/\d done/ })).toBeUndefined()
    }
    await ui.unmount()
  })

  test(`${surface}: a finished batch leaves the band at the next prompt`, async ($, on) => {
    await twoAgents($, on)
    await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: '', turnId: 'x' } as never)
    await $.turn.complete({ agentId: 'a2', reason: 'error', answer: '', turnId: 'y' } as never)

    const done = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await done.find({ key: 'deck-agents' })).toBeDefined()
    await done.unmount()

    await $.prompt.submit({ text: 'thanks' } as never)
    const after = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await after.find({ key: 'deck-agents' })).toBeUndefined()
    await after.unmount()
  })
}
