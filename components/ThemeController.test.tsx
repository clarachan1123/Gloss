// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ThemeController from "./ThemeController";
import { READER_THEME_KEY, READER_APPEARANCE_KEY, setReaderTheme, setReaderAppearance, subscribeReaderTheme } from "@/lib/reader-theme";

it("全站同步器处理系统、同页、跨页与 clear；卸载清理所有监听", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  const added = vi.spyOn(window, "addEventListener"), removed = vi.spyOn(window, "removeEventListener");
  const mediaAdded = vi.spyOn(media, "addEventListener"), mediaRemoved = vi.spyOn(media, "removeEventListener");
  const notified = vi.fn(), stop = subscribeReaderTheme(notified);
  expect(added.mock.calls).toHaveLength(0); expect(mediaAdded.mock.calls).toHaveLength(0);
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ThemeController)));
    expect(mediaAdded.mock.calls.filter(c => c[0] === "change")).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe("parchment");
    expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
    setReaderTheme("eye-green"); expect(document.documentElement.dataset.theme).toBe("eye-green");
    media.matches = true; media.dispatchEvent(new Event("change")); expect(document.documentElement.dataset.theme).toBe("dark");
    setReaderAppearance("light"); expect(document.documentElement.dataset.theme).toBe("eye-green");
    media.matches = false; media.dispatchEvent(new Event("change")); expect(document.documentElement.dataset.theme).toBe("eye-green");
    localStorage.setItem(READER_APPEARANCE_KEY, "dark"); window.dispatchEvent(new StorageEvent("storage", { key: READER_APPEARANCE_KEY }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    localStorage.setItem(READER_APPEARANCE_KEY, "light"); localStorage.setItem(READER_THEME_KEY, "moon-white");
    window.dispatchEvent(new StorageEvent("storage", { key: READER_THEME_KEY })); expect(document.documentElement.dataset.theme).toBe("moon-white");
    localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); expect(document.documentElement.dataset.theme).toBe("parchment");
    const count = notified.mock.calls.length; window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })); expect(notified).toHaveBeenCalledTimes(count);
  } finally {
    await act(async () => root.unmount()); stop();
    for (const event of ["storage", "gloss:theme-change", "gloss:appearance-change"]) {
      const callback = added.mock.calls.find(c => c[0] === event)![1];
      expect(removed.mock.calls.some(c => c[0] === event && c[1] === callback)).toBe(true);
    }
    expect(mediaRemoved.mock.calls[0]).toEqual(mediaAdded.mock.calls[0]);
    const previous = document.documentElement.dataset.theme; setReaderAppearance("dark"); expect(document.documentElement.dataset.theme).toBe(previous);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.documentElement.removeAttribute("data-theme-transition");
  }
});
