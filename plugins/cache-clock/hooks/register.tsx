import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Heat } from '../types'

const heat = atom({ plugin: 'cache-clock', key: 'heat' } as const, { lastHitAt: null, isPinging: false } as Heat)
const now = atom({ plugin: 'cache-clock', key: 'now' } as const, 0)

const TTL_MS = { '1h': 60 * 60 * 1000, '5m': 5 * 60 * 1000 } as const
const PING_PROMPT = 'Reply with the single word "pong" and nothing else.'

// Warm runs from red-orange (just refreshed) to amber (about to lapse); cold is blue.
const HOT = [0xc2, 0x41, 0x0c]
const COOLING = [0xa1, 0x62, 0x07]
const COLD = '#1d4ed8'

const hex = (rgb: number[]) => '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')
const warmColor = (left: number) => hex(HOT.map((c, i) => (COOLING[i] ?? c) + (c - (COOLING[i] ?? c)) * left))

const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)
}

async function ping($: EngineInterface) {
  const cur = await read($, heat)
  if (cur.isPinging) return
  await update($, heat, p => ({ ...p, isPinging: true }))
  const sentAt = await $.clock.now()
  const r = await $.model.fork({ prompt: PING_PROMPT })
  if (!r.isAnswered) {
    await update($, heat, p => ({ ...p, isPinging: false }))
    $.ui.toast(r.reason === 'nothing-to-fork' ? 'cache-clock: nothing cached yet, send a message first' : `cache-clock: ping failed (${r.reason})`)
    return tick($)
  }
  // The API's own usage figures are the proof: tokens read from the cache renew its TTL.
  const { cache_read_input_tokens: hit, cache_creation_input_tokens: written } = r.usage
  if (hit + written > 0) {
    await update($, heat, () => ({ lastHitAt: sentAt, isPinging: false }))
    $.ui.toast(
      hit >= written
        ? `cache-clock: pong · cache hit, ${fmtTokens(hit)} tokens read from the cache (TTL renewed)`
        : `cache-clock: pong · cache was cold, ${fmtTokens(written)} tokens written to it again`,
    )
  } else {
    await update($, heat, p => ({ ...p, isPinging: false }))
    $.ui.toast('cache-clock: pong · the API reported no cache use; the timer was not reset')
  }
  await tick($)
}

export const register: Register = (on, options) => {
  const ttl = options.ttl === '5m' ? TTL_MS['5m'] : TTL_MS['1h']

  const remaining = (heatNow: Heat, at: number) => (heatNow.lastHitAt === null ? 0 : heatNow.lastHitAt + ttl - at)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await tick($)
    // Ticks while warm, and once more as it lapses, so the pill turns cold on time.
    $.clock.every(1000, () => {
      void (async () => {
        const cur = await read($, heat)
        const at = await $.clock.now()
        if (cur.lastHitAt !== null && remaining(cur, at) > -1000) await update($, now, () => at)
      })()
    })
    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (result.usage) {
      await update($, heat, p => ({ ...p, lastHitAt: sentAt }))
      await tick($)
    }
    return result
  })

  // A compacted conversation is a new prefix: nothing of it is cached yet.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await update($, heat, p => ({ ...p, lastHitAt: null }))
      await tick($)
    }
    return result
    // The pill is a convenience: a hook that fails never fails the compaction.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // Beside the other mods' bands; Claude Code's own placeholder
    // ({ type: 'engine' }) is never nested, as the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const { Box, Text, Button } = $.ui.resolve(e)
    const cur = await read($, heat)
    const at = Math.max(await read($, now), await $.clock.now())
    const left = remaining(cur, at)
    const isWarm = left > 0
    const background = isWarm ? warmColor(Math.min(1, left / ttl)) : COLD
    const canPing = !e.props.isWorking && !cur.isPinging
    // On the graphical surfaces a round border in the pill's own color rounds its corners;
    // the terminal would spend two rows on it.
    const corners = e.surface === 'terminal' ? {} : { borderStyle: 'round', borderColor: background }

    const pill = (
      <Box key="cache-pill" flexDirection="row" flexShrink={0} alignItems="center" gap={1} paddingX={1} backgroundColor={background} {...corners}>
        <Text color="white" bold>
          {isWarm ? '♨ warm' : '❄ cold'}
        </Text>
        {isWarm && <Text color="white">{fmtLeft(left)}</Text>}
        {canPing ? (
          <Button key="cache-ping" label="ping" plain onPress={() => void ping($)} />
        ) : (
          <Text color="white" dimColor>
            {cur.isPinging ? 'pinging…' : '·'}
          </Text>
        )}
      </Box>
    )

    if (!below) {
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          {pill}
        </Box>
      )
    }
    // Shares the row of the bands beneath (agent-deck's bar) instead of a row of its own.
    return (
      <Box flexDirection="row" alignItems="flex-start" gap={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          {below}
        </Box>
        {pill}
      </Box>
    )
  })
}
