// agent-deck: a side panel of the session's subagents and a progress bar above
// the prompt. Inspired by savvy-progress by JohnnyVizz (MIT):
// https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deck, Run, RunStatus } from '../types'

const runs = atom({ plugin: 'agent-deck', key: 'runs' } as const, [])
const deck = atom({ plugin: 'agent-deck', key: 'deck' } as const, {
  hiddenBatch: 0,
  isDoneCollapsed: false,
  autoOpenedBatch: 0,
})
const now = atom({ plugin: 'agent-deck', key: 'now' } as const, 0)

const PANE = 'agent-deck'
const STEP_TOOL = 'mcp__agent-deck__step'
const MAX_RUNS = 200
const MAX_NOTE = 80
// A running row the engine's agent list no longer names, and that made no
// request for this long, is taken as ended.
const GONE_AFTER_MS = 120_000

// Appended to each subagent's brief: a request in the brief is followed far
// more reliably than one in the tool's description.
const STEP_BRIEF = `

---
Progress reporting (only if the \`${STEP_TOOL}\` tool is available to you): before other work, call it with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` each time a step finishes. It only draws a progress bar in the user's panel; it is not your answer.`

// ---------------------------------------------------------------------------
// Words


const STRINGS = {
  pane: 'Agents',
  band: 'Subagents',
  running: 'Running',
  finished: 'Finished',
  agents: 'Running / total',
  output: 'Tokens out',
  time: 'Time',
  empty: 'No subagents yet. They show up here as soon as they start.',
  clear: 'Clear finished',
  background: 'background',
  starting: 'starting…',
  thinking: 'thinking…',
  answering: 'writing its answer…',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  ready: (done: number, total: number) => `${done}/${total} done`,
  busy: (n: number) => `${n} running`,
  allDone: 'All done',
  withErrors: (n: number) => `${n} failed`,
  opened: 'Agents panel opened.',
  closed: 'Agents panel closed.',
  command: 'Show or hide the subagents panel (/subagents open only opens it)',
} as const

type Strings = typeof STRINGS

// ---------------------------------------------------------------------------
// Formatting

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${Math.round(n)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// "claude-opus-5-5" → "Opus 5.5"; anything else shows as it came.
const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)(?:-(\d)(?!\d)(?:-(\d{1,2})(?!\d))?)?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  const [, family = '', major, minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}${major ? ' ' + major : ''}${minor ? '.' + minor : ''}`
}

const modelLabel = (r: Run): string => (r.effort ? `${modelName(r.model)} · ${r.effort}` : modelName(r.model))

// `general-purpose`, or `plugin:agent` shown as `agent`.
const bareType = (type: string): string => type.replace(/^[^:]*:/, '')

const KNOWN_COLOR: Record<string, string> = {
  'general-purpose': '#7C6CF2',
  Explore: '#16A37F',
  Plan: '#E07B39',
  fork: '#D4537E',
  'claude-code-guide': '#2E9BD6',
}
// Neighbours differ most, and nothing reads as the failed red or the stopped grey.
const PALETTE = ['#7C6CF2', '#E07B39', '#2E9BD6', '#D4537E', '#16A37F', '#C29A1C', '#A35BD6', '#3FA8A0', '#5B8DEF', '#7F9F2E']
const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)
const colorOf = (type: string): string => KNOWN_COLOR[bareType(type)] ?? PALETTE[hash(type) % PALETTE.length] ?? '#7C6CF2'

// A run's own color, given when it started; runs from before colors were per
// run, or with `colors: type`, wear their type's.
const runColor = (r: Run): string => r.color ?? colorOf(r.type)

// The color for a new run: one no running run wears, the one worn longest ago
// first, so runs side by side never share one while the palette lasts.
const pickColor = (list: readonly Run[]): string => {
  const worn = new Set(list.filter(isRunning).map(runColor))
  const lastWorn = (c: string): number => list.reduce((at, r, i) => (runColor(r) === c ? i : at), -1)
  const free = PALETTE.filter(c => !worn.has(c))
  return [...(free.length ? free : PALETTE)].sort((a, b) => lastWorn(a) - lastWorn(b))[0] ?? '#7C6CF2'
}

const FAILED = '#D9534F'
const STOPPED = '#9A9AA0'
const GOOD = '#3B9C5F'
const ACCENT = '#7C6CF2'
const fillOf = (r: Run): string => (r.status === 'failed' ? FAILED : r.status === 'stopped' ? STOPPED : runColor(r))

// Shifts a #rrggbb color toward black (amount < 0) or white (amount > 0).
const shade = (hex: string, amount: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

// ---------------------------------------------------------------------------
// What a run is doing, read off the tool calls of its last request

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const hostOf = (url: string): string => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url

const activityOf = (use: { name: string; input: unknown }): string => {
  const input = (use.input ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof input[k] === 'string' ? oneLine(input[k] as string) : '')
  const name = use.name.startsWith('mcp__') ? use.name.split('__').slice(2).join('__') || use.name : use.name
  const arg =
    (str('file_path') && baseName(str('file_path'))) ||
    (str('notebook_path') && baseName(str('notebook_path'))) ||
    str('description') ||
    str('pattern') ||
    str('query') ||
    (str('url') && hostOf(str('url'))) ||
    str('command') ||
    str('skill')
  return clip(arg ? `${name} · ${arg}` : name, 70)
}

// ---------------------------------------------------------------------------
// Runs and batches

const isRunning = (r: Run): boolean => r.status === 'running'
const latestBatch = (list: readonly Run[]): number => list.reduce((m, r) => Math.max(m, r.batch), 0)
const batchOf = (list: readonly Run[], batch: number): Run[] => list.filter(r => r.batch === batch)

// A run joins the batch in progress; once every run of it has ended the next one
// starts a new batch, numbered by its start time so a number is never reused.
const batchFor = (list: readonly Run[], at: number): number => {
  const current = batchOf(list, latestBatch(list))
  return current.some(isRunning) ? latestBatch(list) : at
}

// The run's own progress from 0 to 1, or null when only time tells.
const progressOf = (r: Run): number | null => {
  if (!isRunning(r)) return 1
  if (r.stepTotal) return Math.min(1, (r.stepDone ?? 0) / r.stepTotal)
  return null
}

const ratioOf = (list: readonly Run[]): number =>
  list.length ? list.reduce((s, r) => s + (progressOf(r) ?? 0), 0) / list.length : 0

const elapsed = (r: Run, at: number): number => (r.endedAt ?? Math.max(at, r.startedAt)) - r.startedAt

const spanOf = (list: readonly Run[], at: number): number => {
  if (!list.length) return 0
  const start = Math.min(...list.map(r => r.startedAt))
  const end = Math.max(...list.map(r => r.endedAt ?? Math.max(at, r.startedAt)))
  return end - start
}

// ---------------------------------------------------------------------------
// Desktop drawings: each row is one SVG

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u
const em = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[ilj.,:;'|!()[\]\s]/.test(ch) ? 0.3 : /[A-ZÀ-ÝmwMW@%]/.test(ch) ? 0.74 : 0.57
const widthOf = (s: string, size: number): number => [...s].reduce((w, ch) => w + em(ch) * size, 0)

// Cuts `s` to `max` pixels, with an ellipsis where it cut.
const fit = (s: string, size: number, max: number): string => {
  if (widthOf(s, size) <= max) return s
  let out = ''
  for (const ch of s) {
    if (widthOf(out + ch + '…', size) > max) break
    out += ch
  }
  return out + '…'
}

const CSS = `<style>
.t{fill:#1d1d1f}.s{fill:#6b6b70}.m{fill:#a1a1a6}.k{fill:#ebebef}.ln{stroke:#e6e6ea}.tile{fill:#f5f5f7}
@media (prefers-color-scheme: dark){.t{fill:#f2f2f4}.s{fill:#a8a8ad}.m{fill:#74747a}.k{fill:#2c2c31}.ln{stroke:#323237}.tile{fill:#222226}}
.pulse{animation:pulse 1s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}
.run .bd{animation:bob .5s steps(1) infinite}
.run .la{animation:step .5s steps(1) infinite}.run .lb{animation:step .5s steps(1) infinite -.25s}
.run .eye{animation:look 1s steps(1) infinite}
.run .ant,.run .core{animation:blink .5s steps(1) infinite}.run .core{animation-delay:-.25s}
@keyframes bob{50%{transform:translateY(1px)}}@keyframes step{50%{transform:translateY(-1px)}}
@keyframes look{25%{transform:translateX(1px)}50%{transform:none}75%{transform:translateX(-1px)}}
@keyframes blink{50%{opacity:.2}}
@media (prefers-reduced-motion: reduce){.pulse,.sweep,.run *{animation:none!important}}
</style>`

const svg = (W: number, H: number, body: string, extraCss = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${extraCss}${body}</svg>`

// A 16×16 pixel robot in the run's color. Running, it bobs, steps,
// looks around and blinks; finished, it smiles; failed, its eyes go red.
const bot = (x: number, y: number, color: string, status: RunStatus, scale = 2): string => {
  const groups: Record<'bd' | 'la' | 'lb', string[]> = { bd: [], la: [], lb: [] }
  const px = (gx: number, gy: number, w: number, h: number, fill: string, cls = '', group: keyof typeof groups = 'bd') =>
    groups[group].push(`<rect${cls ? ` class="${cls}"` : ''} x="${gx}" y="${gy}" width="${w}" height="${h}" fill="${fill}"/>`)
  const body = shade(color, -0.3)
  const metal = '#8E929A'
  const eye = status === 'failed' ? '#FF6B6B' : status === 'stopped' ? '#8E929A' : '#9FF3FF'
  const isRun = status === 'running'

  px(7, 0, 2, 1, isRun ? '#FFD84D' : metal, 'ant')
  px(7, 1, 2, 1, metal)
  px(3, 2, 10, 1, color)
  px(2, 3, 12, 6, color)
  px(3, 9, 10, 1, color)
  px(1, 5, 1, 2, metal)
  px(14, 5, 1, 2, metal)
  px(3, 3, 10, 5, '#22252B')
  if (status === 'done') {
    // Happy eyes: ^ ^
    px(5, 4, 2, 1, eye)
    px(9, 4, 2, 1, eye)
    px(4, 5, 1, 1, eye)
    px(7, 5, 1, 1, eye)
    px(8, 5, 1, 1, eye)
    px(11, 5, 1, 1, eye)
  } else {
    px(5, 4, 2, 2, eye, 'eye')
    px(9, 4, 2, 2, eye, 'eye')
  }
  px(6, 7, 4, 1, status === 'failed' ? '#FF6B6B' : shade(color, 0.45))
  px(6, 10, 4, 1, body)
  px(4, 11, 8, 3, body)
  px(7, 12, 2, 1, isRun ? '#FFD84D' : metal, 'core')
  px(2, 11, 2, 2, color)
  px(12, 11, 2, 2, color)
  px(5, 14, 2, 2, '#4A4D55', '', 'la')
  px(9, 14, 2, 2, '#4A4D55', '', 'lb')

  const g = (k: keyof typeof groups) => `<g class="${k}">${groups[k].join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="${isRun ? 'run' : ''}">${g('bd')}${g('la')}${g('lb')}</g></g>`
}

const statusMark = (x: number, y: number, r: Run): string => {
  if (r.status === 'running') return `<circle class="pulse" cx="${x}" cy="${y}" r="3.5" fill="${runColor(r)}"/>`
  if (r.status === 'done')
    return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${GOOD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (r.status === 'failed')
    return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="${FAILED}" stroke-width="1.8" stroke-linecap="round"/>`
  return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5" fill="${STOPPED}"/>`
}

const headerSvg = (W: number, list: readonly Run[], at: number, s: Strings): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const running = list.filter(isRunning).length
  const out = list.reduce((sum, r) => sum + r.outputTokens, 0)
  const tile = (i: number, label: string, value: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="44" rx="8"/>
<text class="s" x="${i * (tw + gap) + 10}" y="17" font-family="${FONT}" font-size="11">${xml(fit(label, 11, tw - 16))}</text>
<text class="t" x="${i * (tw + gap) + 10}" y="36" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${xml(value)}</text>`
  return svg(W, 44, tile(0, s.agents, `${running} / ${list.length}`) + tile(1, s.output, fmtTokens(out)) + tile(2, s.time, fmtTime(spanOf(list, at))))
}

const ROW_H = 70

const rowSvg = (W: number, r: Run, at: number, s: Strings): string => {
  const color = runColor(r)
  const X = 46
  const textW = W - X - 22
  const steps = r.stepTotal ? `${Math.min(r.stepDone ?? 0, r.stepTotal)}/${r.stepTotal}` : ''
  const doing =
    r.status === 'running'
      ? r.stepNote || r.activity || (r.steps ? s.thinking : s.starting)
      : r.status === 'done'
        ? s.done
        : r.status === 'failed'
          ? s.failed
          : s.stopped
  const stats = `ctx ${fmtTokens(r.contextTokens)} · ↑${fmtTokens(r.outputTokens)} · ${fmtTime(elapsed(r, at))}`
  const statsW = widthOf(stats, 11)
  const stepsW = steps ? widthOf(steps, 11) + 6 : 0
  const doingW = Math.max(0, textW - statsW - stepsW - 12)
  const meta = [modelLabel(r), r.isBackground ? s.background : ''].filter(Boolean).join('  ·  ')

  const p = progressOf(r)
  const barY = 58
  const fillColor = fillOf(r)
  const bar =
    p !== null
      ? `<rect class="k" x="${X}" y="${barY}" width="${textW}" height="5" rx="2.5"/><rect x="${X}" y="${barY}" width="${Math.max(p > 0 ? 5 : 0, Math.round(textW * p))}" height="5" rx="2.5" fill="${fillColor}"/>`
      : // Nothing reported: a segment sweeps the track while the run works.
        `<defs><clipPath id="c"><rect x="${X}" y="${barY}" width="${textW}" height="5" rx="2.5"/></clipPath></defs>
<rect class="k" x="${X}" y="${barY}" width="${textW}" height="5" rx="2.5"/>
<g clip-path="url(#c)"><rect class="sweep" x="${X - Math.round(textW * 0.3)}" y="${barY}" width="${Math.round(textW * 0.3)}" height="5" rx="2.5" fill="${color}"/></g>`
  const sweepCss = `<style>.sweep{animation:sw 1s linear infinite}@keyframes sw{to{transform:translateX(${textW + Math.round(textW * 0.3)}px)}}</style>`

  return svg(
    W,
    ROW_H,
    `${bot(2, 10, color, r.status)}
<text class="t" x="${X}" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fit(r.description || bareType(r.type), 13, textW))}</text>
<text x="${X}" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}" font-weight="600">${xml(bareType(r.type))}</tspan><tspan class="s">  ·  ${xml(fit(meta, 11, Math.max(20, textW - widthOf(bareType(r.type), 11) - 20)))}</tspan></text>
${steps ? `<text x="${X}" y="50" font-family="${FONT}" font-size="11" font-weight="600" font-variant-numeric="tabular-nums" fill="${color}">${steps}</text>` : ''}
${doingW > 24 ? `<text class="s" x="${X + stepsW}" y="50" font-family="${FONT}" font-size="11">${xml(fit(doing, 11, doingW))}</text>` : ''}
<text class="m" x="${X + textW}" y="50" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(stats)}</text>
${bar}
${statusMark(W - 9, 14, r)}
<line class="ln" x1="0" y1="${ROW_H - 0.5}" x2="${W}" y2="${ROW_H - 0.5}"/>`,
    p === null ? sweepCss : '',
  )
}

// The band's row: robot, title, count, and a bar with one segment per run of the batch.
const BAND_H = 18
// Pixels left on the band's row for another mod drawn beside it.
const SIDE_ROOM = 200

const bandSvg = (W: number, batch: readonly Run[], at: number, s: Strings): string => {
  const working = batch.some(isRunning)
  const title = s.band
  const label = bandLabel(batch, s)
  const percent = `${Math.round(ratioOf(batch) * 100)}%`
  const time = fmtTime(spanOf(batch, at))
  const tail = `${percent} · ${time}`
  const tailW = widthOf(tail, 11) + 8
  const titleX = 22
  const labelX = titleX + widthOf(title, 12) + 8
  let barX = labelX + widthOf(label, 11) + 10
  const showLabel = W - barX - tailW >= 40
  if (!showLabel) barX = labelX
  const barW = Math.max(40, W - barX - tailW)
  const barY = 5
  const barH = 8

  const parts: string[] = []
  const n = batch.length
  if (n <= 40) {
    const gap = n > 1 ? 3 : 0
    const segW = (barW - gap * (n - 1)) / n
    batch.forEach((r, i) => {
      const x = barX + i * (segW + gap)
      const p = progressOf(r)
      const color = fillOf(r)
      parts.push(`<rect class="k" x="${x}" y="${barY}" width="${segW}" height="${barH}" rx="3"/>`)
      if (p === null) {
        parts.push(`<rect class="pulse" x="${x}" y="${barY}" width="${segW}" height="${barH}" rx="3" fill="${color}" opacity=".45"/>`)
      } else {
        if (isRunning(r) && p < 1)
          parts.push(`<rect class="pulse" x="${x}" y="${barY}" width="${segW}" height="${barH}" rx="3" fill="${color}" opacity=".25"/>`)
        if (p > 0) parts.push(`<rect x="${x}" y="${barY}" width="${Math.max(4, segW * p)}" height="${barH}" rx="3" fill="${color}"/>`)
      }
    })
  } else {
    const ratio = ratioOf(batch)
    parts.push(`<rect class="k" x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5"/>`)
    parts.push(`<rect x="${barX}" y="${barY}" width="${Math.round(barW * ratio)}" height="${barH}" rx="5" fill="${working ? ACCENT : GOOD}"/>`)
  }

  return svg(
    W,
    BAND_H,
    `${bot(0, 1, working ? ACCENT : GOOD, working ? 'running' : 'done', 1)}
<text class="t" x="${titleX}" y="13" font-family="${FONT}" font-size="12" font-weight="600">${xml(title)}</text>
${showLabel ? `<text class="s" x="${labelX}" y="13" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(label)}</text>` : ''}
${parts.join('')}
<text class="s" x="${W - 2}" y="13" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(tail)}</text>`,
  )
}

// ---------------------------------------------------------------------------
// Terminal drawings

const GLYPH: Record<RunStatus, string> = { running: '●', done: '✓', failed: '✗', stopped: '■' }

const runBar = (r: Run, width: number, at: number): string => {
  const p = progressOf(r)
  if (p !== null) {
    const filled = Math.round(width * p)
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
  }
  // Nothing reported: a block walks the track once a second.
  const head = Math.floor(at / 1000) % width
  return [...Array(width)].map((_, i) => (Math.abs(i - head) <= 1 ? '▓' : '░')).join('')
}

// The batch's bar in cells: finished, failed and stopped runs, then the running
// ones' share split into what they reported done and what is left. Every run is
// running or not, so the parts always add up to `width`.
type BatchCells = { done: number; failed: number; stopped: number; runFilled: number; runLeft: number }

const batchCells = (batch: readonly Run[], width: number): BatchCells => {
  const n = batch.length || 1
  const of = (status: RunStatus) => batch.filter(r => r.status === status).length
  const running = batch.filter(isRunning)
  const settledW = Math.round((width * (n - running.length)) / n)
  const failed = Math.round((width * of('failed')) / n)
  const stopped = Math.min(settledW - failed, Math.round((width * of('stopped')) / n))
  const runW = width - settledW
  const partial = running.length ? running.reduce((s, r) => s + (progressOf(r) ?? 0), 0) / running.length : 0
  const runFilled = Math.round(runW * partial)
  return { done: Math.max(0, settledW - failed - stopped), failed, stopped, runFilled, runLeft: runW - runFilled }
}

// What the band says of its batch, on every surface.
const bandLabel = (batch: readonly Run[], s: Strings): string => {
  const settled = batch.filter(r => !isRunning(r)).length
  const failed = batch.filter(r => r.status === 'failed').length
  return batch.some(isRunning)
    ? `${s.ready(settled, batch.length)} · ${s.busy(batch.length - settled)}`
    : `${s.allDone} · ${batch.length}/${batch.length}${failed ? ` · ${s.withErrors(failed)}` : ''}`
}

// ---------------------------------------------------------------------------

type StepInput = { done?: unknown; total?: unknown; note?: unknown }

const count = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1000, Math.round(v))) : fallback

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

async function openPane($: EngineInterface, title: string): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title })
}

// Opens the panel, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface, title: string): Promise<boolean> {
  if (await isPaneOpen($)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($, title)
  return true
}

// Rows whose end no event reported: the engine's own list says how they ended.
async function reconcile($: EngineInterface): Promise<void> {
  const listed = new Map((await $.agent.list()).map(a => [a.id, a.status] as const))
  const at = await $.clock.now()
  await update($, runs, list =>
    list.map((r): Run => {
      if (!isRunning(r) || !r.agentId || r.isWorkflow) return r
      const st = listed.get(r.agentId)
      const ended: RunStatus | null =
        st === 'completed'
          ? 'done'
          : st === 'failed'
            ? 'failed'
            : st === 'killed'
              ? 'stopped'
              : st === undefined && at - r.lastSeenAt > GONE_AFTER_MS
                ? 'stopped'
                : null
      return ended ? { ...r, status: ended, endedAt: r.endedAt ?? at, activity: undefined } : r
    }),
  )
}

export const register: Register = (on, options) => {
  const s = STRINGS
  const stepReports = options.stepReports !== 'off'
  const autoOpen = options.autoOpen !== 'off'
  const colorPerRun = options.colors !== 'type'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'subagents', description: s.command })
    if (stepReports) {
      await $.tool.register({
        name: 'step',
        description:
          'For subagents: report progress on your own task to the user\'s agents panel. ' +
          'Right after reading your brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
          'call it again with `done` and a short `note` as each step finishes. Cheap and silent: it only draws a bar.',
        inputSchema: {
          type: 'object',
          properties: {
            done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
            total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
            note: { type: 'string', description: 'The step in progress, a few words.' },
          },
          required: ['done'],
        },
        // In every agent's tool list from the start: workers do not go looking for it.
        isDeferred: false,
      })
    }

    // Ticks the clocks of running rows once a second, and every 5s asks the
    // engine about rows that may have ended unseen. Quiet when nothing runs.
    let ticks = 0
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, runs)
        if (!list.some(isRunning)) return
        const at = await $.clock.now()
        await update($, now, () => at)
        ticks += 1
        if (ticks % 5 === 0) await reconcile($)
      })()
    })
    return started
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'open') {
      await openPane($, s.pane)
      return { text: s.opened }
    }
    return { text: (await togglePane($, s.pane)) ? s.opened : s.closed }
  })

  // A subagent's own steps: the call runs in its loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    const input = e as unknown as StepInput
    let matched = false
    await update($, runs, list =>
      list.map((r): Run => {
        if (r.agentId !== agentId) return r
        matched = true
        const total = count(input.total, r.stepTotal ?? 0)
        const done = count(input.done, r.stepDone ?? 0)
        const note = typeof input.note === 'string' ? clip(oneLine(input.note), MAX_NOTE) : ''
        return { ...r, stepTotal: total || undefined, stepDone: total ? Math.min(total, done) : done, stepNote: note || undefined }
      }),
    )
    return { result: matched ? 'ok' : 'ignored: this agent has no row in the panel' }
  }).catch(() => ({ result: 'ignored' }))

  on('agent.spawn', async ($, e, next) => {
    const wantsBrief = stepReports && !e.resume && !e.workflow && !e.prompt.includes(STEP_TOOL)
    const started = await next(wantsBrief ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const id = started.agentId ?? e.resume?.agentId ?? `${e.tool_use_id}:${e.workflow?.agentIndex ?? ''}`
    let batch = at
    await update($, runs, list => {
      batch = batchFor(list, at)
      const prev = list.find(r => r.id === id)
      const run: Run = prev
        ? { ...prev, status: 'running', batch, endedAt: undefined, lastSeenAt: at, activity: undefined }
        : {
            id,
            agentId: started.agentId,
            type: e.subagentType,
            color: colorPerRun ? pickColor(list) : undefined,
            description: oneLine(e.description),
            model: started.model,
            isBackground: e.background,
            isWorkflow: e.workflow !== undefined,
            status: 'running',
            batch,
            startedAt: at,
            lastSeenAt: at,
            contextTokens: 0,
            outputTokens: 0,
            steps: 0,
          }
      return [...list.filter(r => r.id !== id), run].slice(-MAX_RUNS)
    })
    await update($, now, () => at)

    const d: Deck = await read($, deck)
    const isNewBatch = d.autoOpenedBatch !== batch
    await update($, deck, p => ({
      ...p,
      hiddenBatch: p.hiddenBatch === batch ? 0 : p.hiddenBatch,
      autoOpenedBatch: batch,
    }))
    if (autoOpen && isNewBatch && !(await isPaneOpen($))) void $.ui.open({ id: PANE, title: s.pane })
    return started
    // The panel never stands in a spawn's way: a failure here lets it go on as asked.
  }).catch(($, e, next) => next(e))

  // Each model request of a subagent: context, output, and what it does next.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    if (!agentId) return result

    const at = await $.clock.now()
    const usage = result.usage
    const uses = result.toolUses.filter(u => u.name !== STEP_TOOL)
    const first = uses[0]
    const activity = first
      ? activityOf(first) + (uses.length > 1 ? ` +${uses.length - 1}` : '')
      : result.answer
        ? s.answering
        : undefined
    await update($, runs, list =>
      list.map((r): Run =>
        r.agentId !== agentId
          ? r
          : {
              ...r,
              status: 'running',
              endedAt: undefined,
              lastSeenAt: at,
              model: usage?.model || r.model,
              effort: typeof e.effort === 'string' ? e.effort : r.effort,
              steps: r.steps + 1,
              activity: activity ?? r.activity,
              ...(usage
                ? {
                    contextTokens:
                      (usage.input_tokens || 0) +
                      (usage.cache_read_input_tokens || 0) +
                      (usage.cache_creation_input_tokens || 0) +
                      (usage.output_tokens || 0),
                    outputTokens: r.outputTokens + (usage.output_tokens || 0),
                  }
                : {}),
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      const status: RunStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, runs, list =>
        list.map((r): Run => {
          if (r.agentId !== agentId) return r
          // A run whose requests went unseen still gets the turn's own sum.
          const fallback = r.steps === 0 && e.usage ? { outputTokens: e.usage.output_tokens || 0 } : {}
          return { ...r, ...fallback, status, endedAt: at, activity: undefined }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  // Once a batch has ended and the person sends their next prompt, the band steps aside.
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) {
      const list = await read($, runs)
      const latest = latestBatch(list)
      const batch = batchOf(list, latest)
      if (batch.length && !batch.some(isRunning)) await update($, deck, p => ({ ...p, hiddenBatch: latest }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const d = await read($, deck)
    const at = Math.max(await read($, now), ...list.map(r => r.startedAt), 0)

    const running = list.filter(isRunning).reverse()
    const finished = list.filter(r => !isRunning(r)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

    const toggleDone = (
      <Button
        key="deck-done"
        label={`${d.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, deck, p => ({ ...p, isDoneCollapsed: !p.isDoneCollapsed }))}
      />
    )
    const clear = (
      <Button key="deck-clear" label={s.clear} plain onPress={() => update($, runs, l => l.filter(isRunning))} />
    )

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, list, at, s)} alt={`${running.length} / ${list.length}`} width={W} height={44} />
          {list.length === 0 && <Text dimColor>{s.empty}</Text>}
          {running.length > 0 && (
            <Text dimColor>
              {s.running} · {running.length}
            </Text>
          )}
          {running.map(r => (
            <Svg key={r.id} source={rowSvg(W, r, at, s)} alt={`${r.description}: ${r.activity ?? s.thinking}`} width={W} height={ROW_H} />
          ))}
          {finished.length > 0 && (
            <Box flexDirection="row" gap={2}>
              {toggleDone}
              {clear}
            </Box>
          )}
          {!d.isDoneCollapsed &&
            finished.map(r => (
              <Svg key={r.id} source={rowSvg(W, r, at, s)} alt={`${r.description}: ${s[r.status as 'done' | 'failed' | 'stopped']}`} width={W} height={ROW_H} />
            ))}
        </Box>
      )
    }

    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(24, cols - 30))
    const row = (r: Run) => {
      const color = runColor(r)
      const steps = r.stepTotal ? `${Math.min(r.stepDone ?? 0, r.stepTotal)}/${r.stepTotal} ` : ''
      const doing = isRunning(r) ? r.stepNote || r.activity || (r.steps ? s.thinking : s.starting) : s[r.status as 'done' | 'failed' | 'stopped']
      return (
        <Box key={r.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={r.status === 'done' ? GOOD : r.status === 'running' ? color : fillOf(r)}>{GLYPH[r.status]}</Text>
            <Text bold wrap="truncate-end">
              {r.description || bareType(r.type)}
            </Text>
          </Box>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={color}>{bareType(r.type)}</Text>
            <Text dimColor>
              {' · '}
              {modelLabel(r)}
              {r.isBackground ? ` · ${s.background}` : ''}
            </Text>
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={fillOf(r)}>{runBar(r, barW, at)}</Text>
            <Text dimColor>
              {' '}
              {steps}
              {doing}
            </Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {'  '}ctx {fmtTokens(r.contextTokens)} · ↑{fmtTokens(r.outputTokens)} · {fmtTime(elapsed(r, at))}
          </Text>
        </Box>
      )
    }

    // A finished run needs no bar: its name, then what it came to.
    const doneRow = (r: Run) => (
      <Box key={r.id} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={r.status === 'done' ? GOOD : fillOf(r)}>{GLYPH[r.status]}</Text>
          <Text bold wrap="truncate-end">
            {r.description || bareType(r.type)}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {bareType(r.type)} · {modelName(r.model)} · {s[r.status as 'done' | 'failed' | 'stopped']} · ↑{fmtTokens(r.outputTokens)} ·{' '}
          {fmtTime(elapsed(r, at))}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {s.running} {running.length}/{list.length} · ↑{fmtTokens(list.reduce((sum, r) => sum + r.outputTokens, 0))} · {fmtTime(spanOf(list, at))}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {list.length === 0 && <Text dimColor>{s.empty}</Text>}
          {running.map(row)}
          {finished.length > 0 && (
            <Box flexDirection="row" gap={2}>
              {toggleDone}
              {clear}
            </Box>
          )}
          {!d.isDoneCollapsed && finished.map(doneRow)}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, runs)
    const d = await read($, deck)
    const latest = latestBatch(list)
    const batch = batchOf(list, latest)
    if (!batch.length || d.hiddenBatch === latest) return next(e)

    // Drawn above the other mods' bands; Claude Code's own placeholder
    // ({ type: 'engine' }) is never nested, as the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const at = Math.max(await read($, now), ...batch.map(r => r.startedAt))
    const working = batch.some(isRunning)
    const crew = <Button key="deck-agents" label={`×${batch.length}`} plain onPress={() => void togglePane($, s.pane)} />
    // A Button of its own, not the desktop's native close (`role="dismiss"`),
    // which was not to be seen on the band.
    const dismiss = (
      <Button key="deck-dismiss" label="✕" plain onPress={() => update($, deck, p => ({ ...p, hiddenBatch: latest }))} />
    )
    const label = bandLabel(batch, s)
    const percent = `${Math.round(ratioOf(batch) * 100)}%`
    const tail = `${percent} · ${fmtTime(spanOf(batch, at))}`
    const hasFailures = batch.some(r => r.status === 'failed')
    const mark = working ? ACCENT : hasFailures ? FAILED : GOOD

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // Pixels per column vary with the app's font: the drawing errs narrow so
      // the buttons keep their room, and wrap below it rather than leave the row.
      // It also leaves SIDE_ROOM for another mod's item on the same row (cache-clock's pill).
      const W = Math.max(160, Math.min(720, (e.props.bodyColumns || 100) * 7 - 140 - SIDE_ROOM))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
            <Svg source={bandSvg(W, batch, at, s)} alt={`${s.band}: ${label}, ${percent}`} width={W} height={BAND_H} />
            <Box flexDirection="row" flexShrink={0} gap={1}>
              {crew}
              {dismiss}
            </Box>
          </Box>
          {below}
        </Box>
      )
    }

    // The row in cells: the bar takes what the words and buttons leave, the label
    // goes first when that is too little, then the percent and time.
    const cols = e.props.bodyColumns || 100
    const buttons = `[×${batch.length}] [✕]`.length + 2
    const fixed = 2 + s.band.length + 1 + buttons
    const room = (words: number) => cols - fixed - words
    const showLabel = room(label.length + 1 + tail.length + 1) >= 10
    const showTail = showLabel || room(tail.length + 1) >= 8
    const barW = Math.max(4, Math.min(40, room((showLabel ? label.length + 1 : 0) + (showTail ? tail.length + 1 : 0))))
    const cells = batchCells(batch, barW)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={mark}>◆</Text>
          <Text bold>{s.band}</Text>
          <Text>
            <Text color={working ? ACCENT : GOOD}>{'█'.repeat(cells.done)}</Text>
            <Text color={FAILED}>{'█'.repeat(cells.failed)}</Text>
            <Text color={STOPPED}>{'█'.repeat(cells.stopped)}</Text>
            <Text color={ACCENT}>{'▓'.repeat(cells.runFilled)}</Text>
            <Text dimColor>{'▒'.repeat(cells.runLeft)}</Text>
          </Text>
          {showLabel && (
            <Text bold wrap="truncate-end">
              {label}
            </Text>
          )}
          {showTail && <Text dimColor>{tail}</Text>}
          {crew}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
