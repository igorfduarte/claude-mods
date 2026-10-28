import type { RunStatus } from '../types'

// Shifts a #rrggbb color toward black (amount < 0) or white (amount > 0).
export const shade = (hex: string, amount: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

// ---------------------------------------------------------------------------
// Roles: what a run is there to do, read off its type and description

export type Role = 'inspector' | 'tester' | 'architect' | 'explorer' | 'scholar' | 'builder' | 'none'

// First match wins, so a "review the fix" run is an inspector, not a builder.
// English and Portuguese, as people brief subagents in either.
const ROLE_RULES: [Role, RegExp, RegExp][] = [
  ['inspector', /review|audit|verif|critic|security/i, /\b(review|audit|verif|inspect|check|critiq|revis|confer|valid)/i],
  ['tester', /test|qa\b/i, /\b(test|qa\b|benchmark|reproduc|reproduz)/i],
  ['architect', /^plan$|architect|design/i, /\b(plan|design|architect|planej|projet|arquitet)/i],
  ['explorer', /^explore$|search|finder/i, /\b(explor|search|find|locat|map|scan|survey|busc|procur|encontr|mape|localiz)/i],
  ['scholar', /guide|research|docs/i, /\b(research|docs?\b|investigat|learn|study|read|pesquis|document|estud|investig)/i],
  ['builder', /build|implement|coder|engineer/i, /\b(implement|fix|build|writ|edit|refactor|add|creat|migrat|updat|port|install|corrig|cri[ae]|escrev|ajust|constru|adicion|atualiz)/i],
]

export const roleOf = (type: string, description: string): Role => {
  const bare = type.replace(/^[^:]*:/, '')
  for (const [role, byType] of ROLE_RULES) if (byType.test(bare)) return role
  for (const [role, , byTask] of ROLE_RULES) if (byTask.test(description)) return role
  return 'none'
}

// ---------------------------------------------------------------------------
// The robot

type Px = (gx: number, gy: number, w: number, h: number, fill: string) => void

// What each role wears, drawn over the robot on its 16×16 grid; rows above 0
// rise over the head (the panel's row leaves the room), and the hat hides the antenna.
const OUTFIT: Record<Exclude<Role, 'none'>, { hat: boolean; draw: (px: Px) => void }> = {
  // Sherlock: a checked deerstalker with its ear flaps down, and reading glasses.
  inspector: {
    hat: true,
    draw: px => {
      const [T, TD, G] = ['#B07D4F', '#7A5232', '#E8C35A']
      px(7, -2, 2, 1, TD)
      px(5, -1, 6, 1, T)
      px(4, 0, 8, 1, T)
      px(3, 1, 10, 1, T)
      px(3, 2, 10, 1, TD)
      for (const [x, y] of [[6, -1], [9, -1], [5, 0], [8, 0], [11, 0], [4, 1], [7, 1], [10, 1]] as const) px(x, y, 1, 1, TD)
      px(1, 2, 2, 3, TD)
      px(13, 2, 2, 3, TD)
      // Round rims: the corners left out.
      for (const x of [4, 8]) {
        px(x + 1, 3, 2, 1, G)
        px(x + 1, 6, 2, 1, G)
        px(x, 4, 1, 2, G)
        px(x + 3, 4, 1, 2, G)
      }
    },
  },
  // Lab goggles strapped round the head.
  tester: {
    hat: false,
    draw: px => {
      const [F, S] = ['#3FA8A0', '#2B2D33']
      px(1, 4, 3, 1, S)
      px(12, 4, 3, 1, S)
      for (const x of [3, 8]) {
        px(x, 3, 5, 1, F)
        px(x, 6, 5, 1, F)
        px(x, 4, 1, 2, F)
        px(x + 4, 4, 1, 2, F)
      }
    },
  },
  // A navy beret with a pencil tucked beside it.
  architect: {
    hat: true,
    draw: px => {
      const [B, BD, P, PT] = ['#2F4A8A', '#1F3263', '#F2B705', '#E58FA0']
      px(8, -1, 1, 1, BD)
      px(4, 0, 8, 1, B)
      px(2, 1, 11, 1, B)
      px(3, 2, 10, 1, BD)
      px(14, 0, 1, 1, PT)
      px(14, 1, 1, 3, P)
      px(14, 4, 1, 1, '#22252B')
    },
  },
  // A khaki pith helmet with a dark band.
  explorer: {
    hat: true,
    draw: px => {
      const [K, KD, BAND] = ['#D9C48F', '#A88F55', '#6B4F2A']
      px(6, -2, 4, 1, K)
      px(5, -1, 6, 1, K)
      px(4, 0, 8, 1, K)
      px(4, 1, 8, 1, BAND)
      px(1, 2, 14, 1, KD)
    },
  },
  // A mortarboard with a gold tassel.
  scholar: {
    hat: true,
    draw: px => {
      const [D, DL, G] = ['#2B2D33', '#454953', '#E8C35A']
      px(4, -1, 8, 1, DL)
      px(1, 0, 14, 1, D)
      px(4, 1, 8, 1, D)
      px(3, 2, 10, 1, D)
      px(7, -1, 2, 1, G)
      px(14, 1, 1, 3, G)
    },
  },
  // A yellow hard hat with a brim.
  builder: {
    hat: true,
    draw: px => {
      const [Y, YL, YD] = ['#F2B705', '#FFD84D', '#C48F00']
      px(5, -1, 6, 1, Y)
      px(4, 0, 8, 1, Y)
      px(3, 1, 10, 1, Y)
      px(7, -1, 2, 3, YL)
      px(1, 2, 14, 1, YD)
    },
  },
}

// A 16×16 pixel robot in the run's color, dressed for its role. Running, it
// bobs, steps, looks around and blinks; finished, it smiles; failed, its eyes go red.
export const bot = (x: number, y: number, color: string, status: RunStatus, scale = 2, role: Role = 'none'): string => {
  const groups: Record<'bd' | 'la' | 'lb', string[]> = { bd: [], la: [], lb: [] }
  const px = (gx: number, gy: number, w: number, h: number, fill: string, cls = '', group: keyof typeof groups = 'bd') =>
    groups[group].push(`<rect${cls ? ` class="${cls}"` : ''} x="${gx}" y="${gy}" width="${w}" height="${h}" fill="${fill}"/>`)
  const body = shade(color, -0.3)
  const metal = '#8E929A'
  const eye = status === 'failed' ? '#FF6B6B' : status === 'stopped' ? '#8E929A' : '#9FF3FF'
  const isRun = status === 'running'
  const outfit = role === 'none' ? undefined : OUTFIT[role]

  if (!outfit?.hat) {
    px(7, 0, 2, 1, isRun ? '#FFD84D' : metal, 'ant')
    px(7, 1, 2, 1, metal)
  }
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
  outfit?.draw((gx, gy, w, h, fill) => px(gx, gy, w, h, fill))

  const g = (k: keyof typeof groups) => `<g class="${k}">${groups[k].join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="${isRun ? 'run' : ''}">${g('bd')}${g('la')}${g('lb')}</g></g>`
}
