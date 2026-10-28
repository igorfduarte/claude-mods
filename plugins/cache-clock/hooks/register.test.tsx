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

const band = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

test('cold before any request, on every surface that draws the band', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /cold/ })).toBeDefined()
    expect(await ui.find({ key: 'cache-ping' })).toBeDefined()
    await ui.unmount()
  }
})

test('warm counts down from the last hit', async ($, on) => {
  world(on)
  on('state.get', (_$, e) =>
    e.key === 'heat' ? { value: { value: { lastHitAt: NOW - 90_000, isPinging: false }, version: 1 } } : { value: { value: 0, version: 1 } },
  )
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Text', text: /warm/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\d+:\d\d$/ }))?.text).toBe('58:30')
  await ui.unmount()
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
  expect(await after.find({ type: 'Text', text: /warm/ })).toBeDefined()
  expect((await after.find({ type: 'Text', text: /^\d+:\d\d$/ }))?.text).toBe('60:00')
  await after.unmount()
})

test('no ping button while a turn runs', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { ...band, isWorking: true } })
  expect(await ui.find({ key: 'cache-ping' })).toBeUndefined()
  await ui.unmount()
})

test('the pill is rounded on the desktop, borderless on the terminal', async ($, on) => {
  world(on)
  const desk = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  expect((await desk.find({ key: 'cache-pill' }))?.props.borderStyle).toBe('round')
  await desk.unmount()
  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await term.find({ key: 'cache-pill' }))?.props.borderStyle).toBeUndefined()
  await term.unmount()
})
