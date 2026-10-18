// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { READER_THEME_BOOTSTRAP, READER_THEME_KEY, READER_THEMES, readReaderTheme, setReaderTheme, validateReaderTheme, startReaderThemeSync, READER_APPEARANCE_KEY, readReaderAppearance, setReaderAppearance, validateReaderAppearance, resolveReaderTheme } from "./reader-theme";
let stop: () => void;
beforeEach(() => { localStorage.clear(); vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); stop = startReaderThemeSync(); });
afterEach(() => { stop(); vi.unstubAllGlobals(); localStorage.clear(); document.documentElement.removeAttribute("data-theme-transition"); });
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

it.each([null, "", "night", 1, {}, "SYSTEM"])("外观非法值 %j 回跟随系统", value => {
  expect(validateReaderAppearance(value)).toBe("system");
});
it.each(["system", "light", "dark"] as const)("外观 %s 与底色独立保存", appearance => {
  setReaderTheme("eye-green"); setReaderAppearance(appearance);
  expect(readReaderAppearance()).toBe(appearance);
  expect(localStorage.getItem(READER_APPEARANCE_KEY)).toBe(appearance);
  expect(readReaderTheme()).toBe("eye-green");
  for (const systemDark of [false, true]) {
    expect(resolveReaderTheme(appearance, "eye-green", systemDark)).toBe(appearance === "dark" || appearance === "system" && systemDark ? "dark" : "eye-green");
  }
});
it.each([READER_THEME_KEY, READER_APPEARANCE_KEY])("首屏单键 %s 读取失败仍跟随系统深色", denied => {
  vi.stubGlobal("localStorage", { getItem: (key: string) => { if (key === denied) throw Error("denied"); return key === READER_THEME_KEY ? "moon-white" : "system"; } });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  new Function(READER_THEME_BOOTSTRAP)();
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it.each(["system", "light", "dark"] as const)("首屏 %s 在两种系统下与状态模型一致", appearance => {
  localStorage.setItem(READER_APPEARANCE_KEY, appearance); localStorage.setItem(READER_THEME_KEY, "moon-white");
  for (const systemDark of [false, true]) {
    vi.stubGlobal("matchMedia", () => ({ matches: systemDark })); new Function(READER_THEME_BOOTSTRAP)();
    expect(document.documentElement.dataset.theme).toBe(resolveReaderTheme(appearance, "moon-white", systemDark));
  }
});
it("外观写失败回跟随系统，不移除底色", () => {
  const values = new Map([[READER_THEME_KEY, "eye-green"], [READER_APPEARANCE_KEY, "light"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: () => { throw Error("full"); }, removeItem: (key: string) => values.delete(key) });
  expect(setReaderAppearance("dark")).toBe("system"); expect(readReaderTheme()).toBe("eye-green");
});
