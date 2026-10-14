// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READER_TYPOGRAPHY as defaults, READER_TYPOGRAPHY_KEY as key, readReaderTypography, writeReaderTypography, validateReaderTypography } from "./reader-typography";
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
describe("G-19 browser-wide typography", () => {
  it("missing settings use the recommendation; valid settings survive reading", () => {
    expect(readReaderTypography()).toEqual(defaults);
    const value = { ...defaults, fontSize: 21, lineHeight: 2.1, lineChars: 45, bodyFont: "serif" as const, glossFont: "sans" as const };
    writeReaderTypography(value); expect(readReaderTypography()).toEqual(value);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(value);
  });
  it.each([null, [], {}, { ...defaults, version: 2 }, { ...defaults, fontSize: "18" },
    { ...defaults, fontSize: 14.5 }, { ...defaults, fontSize: 21.5 }, { ...defaults, fontSize: 17.25 },
    { ...defaults, lineHeight: 1.74 }, { ...defaults, lineHeight: Infinity }, { ...defaults, lineChars: 32.5 },
    { ...defaults, bodyFont: "other" }, { ...defaults, glossFont: null }, { ...defaults, lineHeight: undefined }])("rejects the whole invalid record %j", value => {
    expect(validateReaderTypography(value)).toEqual(defaults);
  });
  it.each(["{", '"18"', "", "null"])("invalid stored JSON %s", raw => {
    localStorage.setItem(key, raw); expect(readReaderTypography()).toEqual(defaults);
  });
  it("read/write failures do not throw or invent a stored value", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("denied"); });
    expect(readReaderTypography()).toEqual(defaults);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("full"); });
    expect(() => writeReaderTypography({ ...defaults })).not.toThrow();
  });
  it("every legal floating point step is accepted", () => {
    for (let i = 0; i <= 12; i++) { const value = { ...defaults, lineHeight: Number((1.5 + i * .05).toFixed(2)) };
      expect(validateReaderTypography(value)).toEqual(value); }
  });
});
