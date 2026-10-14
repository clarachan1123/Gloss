// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import SettingsPanel, { ReaderTypographyControls } from "./SettingsPanel";
import { DEFAULT_READER_TYPOGRAPHY as defaults } from "@/lib/reader-typography";
afterEach(() => { vi.unstubAllGlobals(); });
it("desktop disclosure is initially collapsed and opens in the list", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SettingsPanel, { glossShape: "inline", onGlossShapeChange: vi.fn(), typography: { ...defaults }, onTypographyChange: vi.fn() })));
    const toggle = host.querySelector<HTMLButtonElement>(".settings-typography-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(host.querySelector("input[type=range]")).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.textContent).toContain("▾"); expect(host.querySelectorAll("input[type=range]")).toHaveLength(3);
    expect([...host.querySelectorAll(".settings-skeleton > li")].map(li => li.textContent)).toContain("呈现模式");
    await act(async () => toggle.click()); expect(host.querySelector("input[type=range]")).toBeNull();
  } finally { await act(async () => root.unmount()); }
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
