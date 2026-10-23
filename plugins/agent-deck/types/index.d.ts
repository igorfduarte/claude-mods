export type RunStatus = 'running' | 'done' | 'failed' | 'stopped'

export type Run = {
  /** The agent's id, or the spawning call's when the engine gave none. */
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  isBackground: boolean
  isWorkflow: boolean
  status: RunStatus
  /** Runs started while others still ran share a batch: the band's bar is one batch. */
  batch: number
  startedAt: number
  endedAt?: number
  /** The last time a model request of the run was seen. */
  lastSeenAt: number
  contextTokens: number
  outputTokens: number
  steps: number
  /** What the run is doing now, from its last request's tool calls. */
  activity?: string
  /** Self-reported through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Deck = {
  /** The batch whose band was dismissed. */
  hiddenBatch: number
  isDoneCollapsed: boolean
  autoOpenedBatch: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      runs: Run[]
      deck: Deck
      now: number
    }
  }
}
