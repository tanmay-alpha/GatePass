/** A code that stays in view is not re-submitted until it has been out of view this long. */
export const REPEAT_SUPPRESS_MS = 12_000;

/**
 * Decides which camera detections become submissions. A QR held under the
 * camera is read on every frame; it is submitted once and then ignored until
 * a different code is seen or it has not been seen for {@link REPEAT_SUPPRESS_MS}.
 * Each sighting of the held code restarts that window, so a phone resting on a
 * counter never triggers a second "Already used".
 */
export class RepeatFilter {
  private last: { code: string; at: number } | null = null;

  constructor(private readonly windowMs = REPEAT_SUPPRESS_MS) {}

  /** Call for every decoded code; true when it should be submitted. */
  accept(code: string, now: number): boolean {
    const held = this.last !== null && this.last.code === code && now - this.last.at < this.windowMs;
    this.last = { code, at: now };
    return !held;
  }

  /** Forget the last code, e.g. after "Not verified", so presenting it again is checked again. */
  reset(): void {
    this.last = null;
  }
}
