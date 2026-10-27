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
      /** The handoff that goes with the next prompt, once the session compacted or cleared. */
      pendingPath: string | null
      /** The cycle whose handoff is written and waits for a compaction, the mod's own or a /compact. */
      written: number | null
      /** The last handoff confirmed written; the next cycle consolidates it. A failed cycle leaves it as it was. */
      lastWritten: string | null
      /** True after a failed or interrupted cycle: no automatic retry until a compaction. */
      isHeld: boolean
    }
  }
}
