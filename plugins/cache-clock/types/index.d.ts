export type Heat = {
  /** When the main thread's prefix was last sent (a turn's request or a ping), in `$.clock.now()` ms; null: cold from the start. */
  lastHitAt: number | null
  /** A ping is out. */
  isPinging: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': { heat: Heat; now: number }
  }
}
