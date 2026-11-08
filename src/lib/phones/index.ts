// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Nomen's worker calls advancePhones() and
// nothing else in this folder, so everything behind it can change freely.
import { tick } from "./engine";

/**
 * Called by the background worker on every tick (every few seconds). Queues today's scheduled
 * warm-up sessions, starts due ones, polls running Mobilerun tasks and records results. Idempotent:
 * each step claims its session first, and an overlapping call returns the tick already in flight.
 * Does nothing without a Mobilerun key.
 */
export async function advancePhones(): Promise<void> {
  await tick();
}
