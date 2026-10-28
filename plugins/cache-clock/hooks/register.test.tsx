import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'cache-clock'
const NOW = Date.parse('2026-10-28T12:00:00Z')
// The engine beneath: its clock, and its own drawing of the band.
function world(on: On) {
  mock.clock(on, { now: NOW })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

// What the pill says: the desktop's drawing by its alt, the terminal's by its texts.
const said = async (ui: { find: (q: never) => Promise<{ text?: string; props: Record<string, unknown> } | undefined> }, surface: string) =>
  surface === 'terminal'
    ? [(await ui.find({ type: 'Text', text: /warm|cold/ } as never))?.text, (await ui.find({ type: 'Text', text: /^\d+:\d\d$/ } as never))?.text]
        .filter(Boolean)
        .join(' ')
    : String((await ui.find({ type: 'Svg' } as never))?.props.alt)

const band = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

test('cold before any request, on every surface that draws the band', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await said(ui, surface)).toContain('cold')
    expect(await ui.find({ key: 'cache-ping' })).toBeDefined()
    await ui.unmount()
  }
})

test('warm counts down from the last hit', async ($, on) => {
  world(on)
  on('state.get', (_$, e) =>
    e.key === 'heat' ? { value: { value: { lastHitAt: NOW - 90_000, isPinging: false }, version: 1 } } : { value: { value: 0, version: 1 } },
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await said(ui, surface)).toBe(surface === 'terminal' ? '♨ warm 58:30' : 'cache warm, 58:30 left')
    await ui.unmount()
  }
})

test('a ping that reads the cache turns it warm', async ($, on) => {
  world(on)
  const asked: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', (_$, e) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: 'pong',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  await ui.press({ key: 'cache-ping' })
  await ui.unmount()

  expect(asked.length).toBe(1)
  expect(toasts).toEqual(['cache-clock: pong · cache hit, 40.0k tokens read from the cache (TTL renewed)'])
  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(await said(after, 'desktop')).toBe('cache warm, 60:00 left')
  await after.unmount()
})

test('no ping button while a turn runs', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { ...band, isWorking: true } })
  expect(await ui.find({ key: 'cache-ping' })).toBeUndefined()
  await ui.unmount()
})

test("the desktop pill is a rounded drawing as tall as agent-deck's band", async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const pill = await ui.find({ type: 'Svg' })
  expect(pill?.props.height).toBe(18)
  expect(String(pill?.props.source)).toContain('rx="9"')
  await ui.unmount()
})
