// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { READER_THEME_BOOTSTRAP, READER_THEME_KEY, READER_THEMES, readReaderTheme, setReaderTheme, validateReaderTheme } from "./reader-theme";
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); document.documentElement.removeAttribute("data-theme-transition"); });
it.each(READER_THEMES)("reads, writes and restores %s", theme => {
  expect(setReaderTheme(theme)).toBe(theme); expect(readReaderTheme()).toBe(theme);
  expect(document.documentElement.dataset.theme).toBe(theme);
  document.documentElement.dataset.theme = "parchment";
  new Function(READER_THEME_BOOTSTRAP)(); expect(document.documentElement.dataset.theme).toBe(theme);
});
it.each([null, "", "night", "{", '"moon-white"', 1, {}])("rejects %j without coercion", value => {
  expect(validateReaderTheme(value)).toBe("parchment");
});
it("missing values and read/write exceptions fall back to parchment", () => {
  expect(readReaderTheme()).toBe("parchment");
  vi.stubGlobal("localStorage", { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("full"); } });
  expect(readReaderTheme()).toBe("parchment"); expect(setReaderTheme("eye-green")).toBe("parchment");
  document.documentElement.dataset.theme = "moon-white";new Function(READER_THEME_BOOTSTRAP)();
  expect(document.documentElement.dataset.theme).toBe("parchment");
});
it("bootstrap never enables initial transitions and does not touch typography", () => {
  localStorage.setItem(READER_THEME_KEY, "moon-white");localStorage.setItem("gloss:settings:reader-typography", "keep");
  new Function(READER_THEME_BOOTSTRAP)(); expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
  expect(localStorage.getItem("gloss:settings:reader-typography")).toBe("keep");
});
it("a failed write removes a previous choice when deletion is available", () => {
  let stored: string | null = "moon-white";
  vi.stubGlobal("localStorage", { getItem: () => stored, setItem: () => { throw Error("quota"); }, removeItem: () => { stored = null; }, clear: () => {} });
  expect(setReaderTheme("eye-green")).toBe("parchment"); expect(stored).toBeNull(); expect(readReaderTheme()).toBe("parchment");
});
