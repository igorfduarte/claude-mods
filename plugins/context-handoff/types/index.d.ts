/** Where the handoff cycle stands: waiting, armed for the next message, the agent writing the file, or compacting. */
export type Phase = 'idle' | 'armed' | 'writing' | 'compacting'

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': {
      phase: Phase
      /** The handoff cycles this session has started; names each cycle's files. */
      cycle: number
      /** When the current handoff was asked for, in ms; the file must be newer than this. */
      requestedAt: number
      /** The cycle whose files go with the next prompt, once the session compacted. */
      pending: number | null
      /** True after a failed or interrupted cycle: no automatic retry until a compaction. */
      isHeld: boolean
    }
  }
}
