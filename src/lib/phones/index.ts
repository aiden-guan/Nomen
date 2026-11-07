// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Nomen's worker calls advancePhones() and
// nothing else in this folder, so everything behind it can change freely.

/**
 * Called by the background worker on every tick (every few seconds). Start due warm-up sessions,
 * poll running Mobilerun tasks, record results. Must be idempotent and must not throw for long.
 */
export async function advancePhones(): Promise<void> {}
