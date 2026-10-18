// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startReaderThemeSync, setReaderAppearance } from "@/lib/reader-theme";
import SettingsPanel, { ReaderTypographyControls } from "./SettingsPanel";
import { DEFAULT_READER_TYPOGRAPHY as defaults } from "@/lib/reader-typography";
let stop: () => void;
beforeEach(() => { localStorage.clear(); stop = startReaderThemeSync(); });
afterEach(() => { stop(); vi.unstubAllGlobals(); });
it("桌面工具轨顺序、轮换、底色隐藏及 portal 焦点交接", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host), shape = vi.fn(); document.body.append(host);
  try {
    await act(async () => root.render(createElement(SettingsPanel, { glossShape: "inline", onGlossShapeChange: shape, typography: { ...defaults }, onTypographyChange: vi.fn() })));
    const rail = host.querySelector(".reader-tool-rail")!;
    expect([...rail.children].map(el => el.getAttribute("aria-label"))).toEqual(["阅读排版", "外观：跟随系统，点击切换", "底色", "白话显示形态：小字，点击切换"]);
    const cycle = host.querySelector<HTMLButtonElement>(".reader-appearance-cycle")!;
    for (const name of ["浅色", "深色", "跟随系统"]) { await act(async () => cycle.click()); expect(cycle.getAttribute("aria-label")).toBe(`外观：${name}，点击切换`); }
    await act(async () => setReaderAppearance("dark")); expect(host.querySelector<HTMLElement>(".reader-paper-options")!.hidden).toBe(true);
    await act(async () => setReaderAppearance("light")); expect(host.querySelector<HTMLElement>(".reader-paper-options")!.hidden).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-reader-theme="moon-white"]')!.click());
    expect(host.querySelector('[data-reader-theme="moon-white"]')!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>(".reader-shape-cycle")!.click()); expect(shape).toHaveBeenCalledWith("bubble");
    const toggle = host.querySelector<HTMLButtonElement>(".settings-typography-toggle")!;
    for (const method of ["escape", "outside", "toggle"]) {
      await act(async () => toggle.click());
      const panel = document.querySelector(".reader-typography-popover")!;
      expect(host.contains(panel)).toBe(false); expect(panel.querySelectorAll("input[type=range]")).toHaveLength(3);
      expect(document.activeElement).toBe(panel.querySelector("h2")); expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await act(async () => { if (method === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else if (method === "outside") document.body.click(); else toggle.click(); });
      expect(document.querySelector(".reader-typography-popover")).toBeNull(); expect(document.activeElement).toBe(toggle);
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("mobile omits lineChars, but reset restores that field too", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host), onChange = vi.fn();
  try {
    await act(async () => root.render(createElement(ReaderTypographyControls, { value: { ...defaults, lineChars: 20 }, onChange, mobile: true })));
    expect(host.querySelector('[data-typography="lineChars"]')).toBeNull();
    expect(host.querySelectorAll("input[type=radio]")).toHaveLength(4);
    await act(async () => host.querySelector<HTMLButtonElement>(".reader-typography-reset")!.click());
    expect(onChange).toHaveBeenCalledWith(defaults, true);
  } finally { await act(async () => root.unmount()); }
});
it("bands are independent siblings after each track, without numeric ticks", () => {
  const host = document.createElement("div"); host.innerHTML = renderToString(createElement(ReaderTypographyControls, { value: { ...defaults }, onChange: vi.fn() }));
  for (const input of host.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const band = input.nextElementSibling!;
    expect(band.className).toBe("reader-recommended-band"); expect(band.textContent).toBe("");
    expect(band.getAttribute("aria-hidden")).toBe("true");
  }
  expect([...host.querySelectorAll("output")].map(o => o.textContent)).toEqual(["17.5px", "1.75", "32字"]);
  const ranges = [...host.querySelectorAll<HTMLInputElement>('input[type="range"]')].map(i => [i.min, i.max, i.step]);
  expect(ranges).toEqual([["15", "21", "0.5"], ["1.5", "2.1", "0.05"], ["20", "45", "1"]]);
});
it("pointerdown and pointerup/cancel expose gesture boundaries; radio choices are discrete", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host), start = vi.fn(), end = vi.fn(), change = vi.fn();
  try {
    await act(async () => root.render(createElement(ReaderTypographyControls, { value: { ...defaults }, onChange: change, onGestureStart: start, onGestureEnd: end })));
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.setPointerCapture = vi.fn();
    await act(async () => { range.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      range.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2 }));
      range.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 2 })); });
    expect(start).toHaveBeenCalledTimes(2); expect(end).toHaveBeenCalledTimes(2);
    await act(async () => host.querySelector<HTMLInputElement>('[data-typography="bodyFont"][value="serif"]')!.click());
    expect(change).toHaveBeenCalledWith({ ...defaults, bodyFont: "serif" }, true);
  } finally { await act(async () => root.unmount()); }
});

it("桌面恢复推荐值不改底色，窗口缩到手机时关闭浮层", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host), change = vi.fn(); document.body.append(host);
  const oldWidth = window.innerWidth;
  try {
    await act(async () => root.render(createElement(SettingsPanel, { glossShape: "inline", onGlossShapeChange: vi.fn(), typography: { ...defaults }, onTypographyChange: change })));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-reader-theme="moon-white"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".settings-typography-toggle")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".reader-typography-popover .reader-typography-reset")!.click());
    expect(change).toHaveBeenCalledWith(defaults, true); expect(document.documentElement.dataset.theme).toBe("moon-white");
    await act(async () => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 }); window.dispatchEvent(new Event("resize")); });
    expect(document.querySelector(".reader-typography-popover")).toBeNull();
  } finally { Object.defineProperty(window, "innerWidth", { configurable: true, value: oldWidth }); await act(async () => root.unmount()); host.remove(); }
});

it("外观切换保留浮层、三套底色及选中值", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(createElement(SettingsPanel, { glossShape: "inline", onGlossShapeChange: vi.fn(), typography: { ...defaults }, onTypographyChange: vi.fn() })));
    const toggle = host.querySelector<HTMLButtonElement>(".settings-typography-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(document.querySelector(".reader-typography-popover")).toBeNull();
    expect([...host.querySelectorAll(".reader-tool-swatch")].map(el => el.getAttribute("aria-label"))).toEqual(["羊皮纸", "月白", "护眼绿"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-reader-theme="moon-white"]')!.click());
    await act(async () => toggle.click());
    for (const value of ["dark", "light"] as const) {
      await act(async () => setReaderAppearance(value));
      expect(host.querySelector<HTMLElement>(".reader-paper-options")!.hidden).toBe(value === "dark");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelectorAll(".reader-typography-popover input[type=range]")).toHaveLength(3);
      expect(host.querySelector('[data-reader-theme="moon-white"]')!.getAttribute("aria-pressed")).toBe("true");
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});
