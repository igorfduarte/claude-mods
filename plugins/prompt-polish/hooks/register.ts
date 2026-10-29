import type { Register } from 'claude-code'

// Jev (TypeSafe) decides; Claude rewrites. The rewrite goes back into the
// prompt box, so nothing is sent until you press Enter again.
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const JEV_MODEL = 'jev-1.14.0'
// Shorter prompts ("ok", "Sim. Pode") pass unchecked: under either limit.
const MIN_CHARS = 25
const MIN_WORDS = 5
const SKIP_PREFIX = '##' // "## texto" sends as-is, without the prefix
const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' } as const

const REWRITE_SYSTEM = `You rewrite a message a person is about to send to an AI coding agent, so the agent understands it better.
Keep the person's language, voice, intent and every fact, file name, number and constraint.
Work on its structure: the goal first, then what it refers to, the constraints and the expected result; separate mixed requests into ordered items; remove ambiguity. Keep it as short as the content allows.
Do not polish spelling, capitalization or punctuation for its own sake. Do not add requirements, guesses or pleasantries. Do not answer or carry out the message.
Output only the rewritten message.`

export const register: Register = (on, options) => {
  const threshold = Math.min(1, Math.max(0, Number(options.threshold ?? 0.8)))
  const model = options.rewriteModel === 'sonnet' ? MODELS.sonnet : MODELS.haiku

  // The text this mod put in the box: its next submit goes through unchecked.
  let filled: string | undefined

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.attachments) return next(e)
    // Only what a person typed: notifications and peers' messages pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)

    if (e.text.startsWith(SKIP_PREFIX)) {
      return next({ ...e, text: e.text.slice(SKIP_PREFIX.length).trimStart() })
    }

    if (filled !== undefined) {
      filled = undefined
      return next(e)
    }

    const draft = e.text.trim()
    if (draft.length < MIN_CHARS || draft.split(/\s+/).length < MIN_WORDS) {
      $.ui.log(`prompt-polish: short (${draft.length} chars), sent unchecked`, { to: 'debug' })
      return next(e)
    }

    const key = await $.env.get('JEV_API_KEY')
    if (!key) {
      $.ui.log('prompt-polish: JEV_API_KEY is not set; prompt sent unchecked', { to: 'debug' })
      return next(e)
    }

    const jev = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: e.text,
        questions: {
          better: {
            type: 'noul',
            instructions:
              'This is a message a person is about to send to an AI coding agent, in the middle of a conversation with it. ' +
              'Judge only its structure as instructions, never its writing: spelling, accents, grammar, capitalization, ' +
              'punctuation and informal tone never count. ' +
              'Could it be restructured so the agent understands it clearly better? Look at whether the goal or expected result is stated, ' +
              'whether constraints that matter are stated, and whether several requests are separated and ordered instead of mixed together. ' +
              'A reference to something earlier in the conversation (that file, the bug, option 2) is clear. ' +
              'Answer false when the agent could act on it correctly as written, even if short, informal or misspelled.',
          },
        },
      }),
    })
    if (!jev.ok) {
      $.ui.toast(`prompt-polish: Jev answered ${jev.status}; sent unchecked`)
      return next(e)
    }
    const p = Number(JSON.parse(jev.text)?.answers?.better?.noul)
    if (!(p >= threshold)) return next(e)

    $.ui.toast(`Jev: ${Math.round(p * 100)}% could be better. Rewriting…`)
    const r = await $.model.complete({
      model,
      effort: 'low',
      system: REWRITE_SYSTEM,
      prompt: e.text,
      maxTokens: 4000,
      timeoutMs: 30000,
    })
    const rewritten = r.isAnswered ? r.text.trim() : ''
    if (!rewritten || rewritten === e.text.trim()) return next(e)

    const box = await $.prompt.fill({ text: rewritten })
    if (!box.isFilled) return next(e)
    filled = rewritten
    $.ui.log(`prompt-polish: original kept here:\n${e.text}`)
    return { drop: `Jev ${Math.round(p * 100)}%: rewritten in the box. Enter sends it; "${SKIP_PREFIX} " sends any text unchecked.` }
  })
}
