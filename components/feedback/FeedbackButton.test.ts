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
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="体验反馈"]');
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
  await click([...dialog()!.querySelectorAll("button")].find(element => element.textContent === "复制")!);
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Claraiing");
  expect(dialog()!.querySelector(".feedback-copy")!.textContent).toBe("已复制");
  await act(async () => vi.advanceTimersByTime(1999));
  expect(dialog()!.querySelector(".feedback-copy")!.textContent).toBe("已复制");
  await act(async () => vi.advanceTimersByTime(1));
  expect(dialog()!.querySelector(".feedback-copy")!.textContent).toBe("复制");
});

it("复制失败选择微信号并显示请手动复制", async () => {
  clipboard(vi.fn().mockRejectedValue(new Error("denied")));
  await mount();
  await click(button());
  await click([...dialog()!.querySelectorAll("button")].find(element => element.textContent === "复制")!);
  expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe("请手动复制");
  expect(window.getSelection()!.toString()).toBe("Claraiing");
});

it("关闭后忽略尚未完成的复制结果", async () => {
  let resolve!: () => void;
  clipboard(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
  await mount();
  await click(button());
  await click([...dialog()!.querySelectorAll("button")].find(element => element.textContent === "复制")!);
  await click(button());
  await act(async () => resolve());
  await click(button());
  expect(dialog()!.querySelector(".feedback-copy")!.textContent).toBe("复制");
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
      await click(dialog()!.querySelector(".feedback-copy")!);
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

const sendButton = () => dialog()!.querySelector<HTMLButtonElement>(".feedback-send")!;
const bodyInput = () => dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="意见"]')!;
const contactInput = () => dialog()!.querySelector<HTMLInputElement>('input[aria-label="联系方式（选填）"]')!;
async function edit(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("直接发送成功替换表单，清空草稿，下一次打开为空表单", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await mount(); await click(button());
  await edit(bodyInput(), " 测试 "); await edit(contactInput(), " 微信 ");
  await click(sendButton());
  expect(dialog()!.textContent).toContain("已收到，谢谢！");
  expect(dialog()!.querySelector("textarea")).toBeNull();
  const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(payload).toMatchObject({ body: "测试", contact: "微信", source: "landing" });
  expect(Object.keys(payload)).toEqual(["id", "body", "contact", "source"]);
  expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
  await click(button()); await click(button());
  expect(bodyInput().value).toBe(""); expect(contactInput().value).toBe("");
});
it("直接发送失败保留草稿，关闭再打开仍保留；手动再发生成新id", async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
  vi.stubGlobal("fetch", fetchMock);
  await mount(); await click(button());
  await edit(bodyInput(), "测试"); await edit(contactInput(), "邮箱");
  await click(sendButton());
  expect(dialog()!.textContent).toContain("没发出去，可以稍后再试，或加微信 Claraiing");
  expect(bodyInput().value).toBe("测试");
  await click(button()); await click(button());
  expect(bodyInput().value).toBe("测试"); expect(contactInput().value).toBe("邮箱");
  await click(sendButton());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).id).not.toBe(JSON.parse(fetchMock.mock.calls[1][1].body).id);
});
it("组字中Esc（isComposing或229）不关闭，普通Esc关闭", async () => {
  await mount(); await click(button()); await edit(bodyInput(), "草稿");
  await act(async () => { bodyInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })); });
  expect(dialog()).not.toBeNull();
  await act(async () => { const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true }); Object.defineProperty(event, "keyCode", { value: 229 }); bodyInput().dispatchEvent(event); });
  expect(dialog()).not.toBeNull();
  await act(async () => { bodyInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(dialog()).toBeNull();
  await click(button()); expect(bodyInput().value).toBe("草稿");
});
it("空正文、1001码点（含内部空格换行）、超长联系方式禁用发送", async () => {
  await mount(); await click(button()); expect(sendButton().disabled).toBe(true);
  await edit(bodyInput(), " \n "); expect(sendButton().disabled).toBe(true);
  await edit(bodyInput(), "甲".repeat(998) + " \n乙");
  expect(sendButton().disabled).toBe(true); expect(dialog()!.textContent).toContain("超过 1000 字了，删一些再发");
  await edit(bodyInput(), "甲".repeat(997) + " \n乙"); expect(sendButton().disabled).toBe(false);
  await edit(contactInput(), "🙂".repeat(101)); expect(sendButton().disabled).toBe(true);
  expect(dialog()!.textContent).toContain("联系方式太长了");
});
it("两次快速点击仅发送一次请求，发送中禁用且显示发送中", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetchMock); await mount(); await click(button()); await edit(bodyInput(), "测试");
  const send = sendButton();
  await act(async () => { send.click(); send.click(); });
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(sendButton().disabled).toBe(true); expect(sendButton().textContent).toBe("发送中…");
  await act(async () => resolve(new Response(null, { status: 503 })));
});
it("15秒无响应显示失败并保留草稿，不自动重试", async () => {
  vi.useFakeTimers(); const fetchMock = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetchMock);
  await mount(); await click(button()); await edit(bodyInput(), "测试"); await click(sendButton());
  await act(async () => vi.advanceTimersByTime(14_999)); expect(sendButton().textContent).toBe("发送中…");
  await act(async () => vi.advanceTimersByTime(1)); expect(bodyInput().value).toBe("测试");
  expect(dialog()!.textContent).toContain("没发出去，可以稍后再试，或加微信 Claraiing");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
