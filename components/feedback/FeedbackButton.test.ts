// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import FeedbackButton from "./FeedbackButton";
import Reader from "@/components/reader/Reader";
import * as cache from "@/lib/cache";
import * as lineSplit from "@/components/reader/lineSplit";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  window.getSelection()?.removeAllRanges();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = () => host.querySelector<HTMLButtonElement>(".feedback-button")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="提意见"]');
async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}
async function mount() {
  await act(async () => root.render(createElement(FeedbackButton)));
}
function clipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

it.each(["outside", "escape", "button"])("打开及 %s 关闭，aria-expanded 与焦点正确", async (method) => {
  await mount();
  expect(button().getAttribute("aria-expanded")).toBe("false");
  await click(button());
  expect(button().getAttribute("aria-expanded")).toBe("true");
  expect(dialog()).not.toBeNull();
  if (method === "outside") await click(document.body);
  else if (method === "button") await click(button());
  else await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(dialog()).toBeNull();
  expect(button().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button());
});

it("复制成功调用指定微信号；两秒恢复按钮文字", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  clipboard(writeText);
  await mount();
  await click(button());
  await click(dialog()!.querySelector("button")!);
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Claraiing");
  expect(dialog()!.querySelector("button")!.textContent).toBe("已复制");
  await act(async () => vi.advanceTimersByTime(1999));
  expect(dialog()!.querySelector("button")!.textContent).toBe("已复制");
  await act(async () => vi.advanceTimersByTime(1));
  expect(dialog()!.querySelector("button")!.textContent).toBe("复制微信号");
});

it("复制失败选择微信号并显示请手动复制", async () => {
  clipboard(vi.fn().mockRejectedValue(new Error("denied")));
  await mount();
  await click(button());
  await click(dialog()!.querySelector("button")!);
  expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe("请手动复制");
  expect(window.getSelection()!.toString()).toBe("Claraiing");
});

it("关闭后忽略尚未完成的复制结果", async () => {
  let resolve!: () => void;
  clipboard(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
  await mount();
  await click(button());
  await click(dialog()!.querySelector("button")!);
  await click(button());
  await act(async () => resolve());
  await click(button());
  expect(dialog()!.querySelector("button")!.textContent).toBe("复制微信号");
});

it("复制、正文句子上点外关闭及 Esc 关闭保留撑开区且零埋点；关闭后 Esc 恢复收起", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  vi.spyOn(cache, "preloadGlossCache").mockResolvedValue(new Map([[0, { text: "测试白话。", hasStructure: false }]]));
  vi.spyOn(lineSplit, "measureSplit").mockReturnValue(1);
  clipboard(vi.fn().mockResolvedValue(undefined));
  localStorage.setItem("gloss:doc:g60", JSON.stringify({
    version: 1, docId: "g60", paragraphs: ["甲乙。丙丁。"], headings: [], footnotes: [],
    meta: { format: "txt", fileName: "测试.txt", charCount: 6 }, savedAt: 1,
  }));
  await act(async () => root.render(createElement(Reader, { docId: "g60" })));
  for (let step = 0; step < 6; step++) await act(async () => { await Promise.resolve(); });
  await click(host.querySelector(".sentence")!);
  for (let step = 0; step < 6; step++) await act(async () => { await Promise.resolve(); });
  expect(host.querySelector(".gloss-panel")).not.toBeNull();
  const events: unknown[] = [];
  const listener = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener("gloss:analytics", listener);
  try {
    for (const method of ["outside", "escape", "button"]) {
      const panel = host.querySelector(".gloss-panel");
      await click(button());
      await click(dialog()!.querySelector("p")!);
      await click(dialog()!.querySelector("button")!);
      expect(host.querySelector(".gloss-panel")).toBe(panel);
      expect(events).toEqual([]);
      await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
      if (method === "outside") await click(host.querySelector('.sentence[data-index="1"]')!);
      else if (method === "button") await click(button());
      else await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(host.querySelector(".gloss-panel")).toBe(panel);
      expect(events).toEqual([]);
      expect(dialog()).toBeNull();
    }
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await vi.waitFor(() => expect(host.querySelector(".gloss-panel")).toBeNull());
  } finally { window.removeEventListener("gloss:analytics", listener); }
});
