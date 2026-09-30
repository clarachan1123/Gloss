import { describe, expect, it } from "vitest";
import { ReadCompleteClock } from "./analytics-read-complete";

const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;

describe("read complete clock", () => {
  it("starts at displayed text, pauses while hidden, and requires bottom seen", () => {
    const clock = new ReadCompleteClock();
    expect(clock.sample(0, false, false, 0, rect(0, 200), 700, false).firstText).toBe(false);
    expect(clock.sample(100, true, false, 24, rect(0, 900), 700, false).firstText).toBe(true);
    clock.sample(1_100, true, true, 24, rect(0, 900), 700, true);
    expect(clock.sample(5_100, true, true, 24, rect(0, 900), 700, true).readComplete).toBe(false);
    clock.sample(5_200, true, true, 24, rect(0, 650), 700, false);
    expect(clock.sample(7_300, true, true, 24, rect(0, 650), 700, false).readComplete).toBe(true);
    expect(clock.sample(8_000, true, true, 24, rect(0, 650), 700, false).readComplete).toBe(false);
  });
});
