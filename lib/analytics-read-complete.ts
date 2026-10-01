/** A read-only clock for one first expansion. Times use performance.now() milliseconds. */
export class ReadCompleteClock {
  firstTextAt: number | null = null;
  bottomSeen = false;
  private visibleFrom: number | null = null;
  private accrued = 0;
  private done = false;
  private glossChars = 0;
  private reported = false;

  sample(now: number, hasText: boolean, complete: boolean, chars: number, rect: DOMRect | null, viewportHeight: number, hidden: boolean):
    { firstText: boolean; readComplete: boolean; visibleMs: number; glossChars: number } {
    const firstText = this.firstTextAt === null && hasText;
    if (firstText) this.firstTextAt = now;
    const visible = this.firstTextAt !== null && !hidden && rect !== null && rect.bottom > 0 && rect.top < viewportHeight;
    if (this.visibleFrom !== null) {
      this.accrued += Math.max(0, now - this.visibleFrom);
      this.visibleFrom = null;
    }
    if (visible) this.visibleFrom = now;
    if (this.firstTextAt !== null && rect !== null && rect.bottom >= 0 && rect.bottom <= viewportHeight && !hidden) {
      this.bottomSeen = true;
    }
    if (complete) { this.done = true; this.glossChars = chars; }
    const threshold = Math.max(2_000, this.glossChars / 8 * 1_000);
    const readComplete = !this.reported && this.done && this.bottomSeen && this.accrued >= threshold;
    if (readComplete) this.reported = true;
    return { firstText, readComplete, visibleMs: this.accrued, glossChars: this.glossChars };
  }

  /** Visible time accrued up to the latest sample() or stop(). */
  get visibleMs(): number {
    return this.accrued;
  }

  get readReported(): boolean {
    return this.reported;
  }

  stop(now: number): void {
    if (this.visibleFrom !== null) this.accrued += Math.max(0, now - this.visibleFrom);
    this.visibleFrom = null;
  }
}
