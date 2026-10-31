// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import * as cache from "@/lib/cache";
import * as storage from "@/lib/storage";
import * as selections from "@/lib/selection-storage";
import { assembleDocument } from "@/lib/parse/validate";
import { takeReaderEntrySource } from "@/lib/analytics-local";
import { SAMPLE_SHELF_ENTRY } from "@/lib/sample";
import Shelf, { enterFromShelf } from "./Shelf";

vi.mock("next/font/local", () => ({ default: () => ({ className: "title-font-test" }) }));
vi.mock("@/components/landing/LandingDemo", () => ({ default: () => createElement("div", { "data-demo-stub": true }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

it("G-16a-2 示例书入口只标记 shelf 来源，自有书照常派发 shelf_book_click", () => {
  const events: unknown[] = [];
  const onAnalytics = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener("gloss:analytics", onAnalytics);
  try {
    enterFromShelf(SAMPLE_SHELF_ENTRY, "cover");
    expect(events).toEqual([]);
    expect(takeReaderEntrySource("sample")).toBe("shelf");

    const ownBook = { ...SAMPLE_SHELF_ENTRY, docId: "own-book", addedAt: 123, lastOpenedAt: 123 };
    enterFromShelf(ownBook, "cover");
    expect(events).toEqual([{ event: "shelf_book_click", entry: "cover", daysSinceOpenBucket: "never" }]);
    expect(takeReaderEntrySource("own-book")).toBe("shelf");
  } finally {
    window.removeEventListener("gloss:analytics", onAnalytics);
    takeReaderEntrySource("");
  }
});

describe("G-73a 响应式书架与详情", () => {
  async function setup(desktop: boolean) {
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const entries = [0, 1].map(n => ({ ...SAMPLE_SHELF_ENTRY, docId: `own-${n}`, title: `自有书${n}`, addedAt: 1, lastOpenedAt: 10 + n }));
    vi.spyOn(storage, "loadShelf").mockReturnValue({ entries, unavailable: false });
    const doc = { ...assembleDocument({ paragraphs: ["第一句。第二句。"], headings: [], footnotes: [] }, "txt", "自有书.txt"), version: 1 as const, docId: "own-0", savedAt: 1 };
    const load = vi.spyOn(storage, "loadDocument").mockReturnValue(doc);
    const saved = vi.spyOn(storage, "loadSavedGlosses").mockResolvedValue(new Map([[0, { paraIndex: 0, start: 0, sourceHash: "test", text: "白话", savedAt: 1, kind: "saved" }]]));
    vi.spyOn(selections, "loadSavedSelections").mockResolvedValue([
      { resultKind: "term", start: { paraIndex: 0, offset: 0 }, end: { paraIndex: 0, offset: 2 }, sourceHash: "test", text: "划选白话", savedAt: 1, promptVersion: "test", model: "test" },
      { resultKind: "range", start: { paraIndex: 9, offset: 0 }, end: { paraIndex: 9, offset: 2 }, sourceHash: "test", text: "无触及句", savedAt: 1, promptVersion: "test", model: "test" },
    ]);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Shelf)); });
    return { container, load, saved, cleanup: async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); } };
  }

  it("电脑初始全合；聚焦保留链接和焦点，详情严格计数且按书缓存", async () => {
    const { container, load, saved, cleanup } = await setup(true);
    try {
      expect(container.querySelector(".book-detail")).toBeNull(); expect(load).not.toHaveBeenCalled();
      const link = container.querySelector<HTMLAnchorElement>(".book-slot")!;
      await act(async () => link.focus());
      expect(container.querySelector(".book-slot")).toBe(link); expect(document.activeElement).toBe(link);
      expect(container.querySelector(".book-detail dl")?.textContent).toContain("2 处");
      const second = container.querySelectorAll<HTMLAnchorElement>(".book-slot")[1];
      await act(async () => second.focus()); await act(async () => link.focus());
      expect(saved).toHaveBeenCalledTimes(2); expect(load).toHaveBeenCalledTimes(2);
      await act(async () => container.querySelector(".book-cover")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
      expect(document.querySelector(".spine-menu")).not.toBeNull(); expect(container.querySelector(".book-detail")).toBeNull();
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(document.activeElement).toBe(link); expect(container.querySelector(".book-detail")).not.toBeNull();
    } finally { await cleanup(); }
  });

  it("手机只渲染书单，最近一本独立显示，示例最后且不计算所有书的正文", async () => {
    const { container, load, saved, cleanup } = await setup(false);
    try {
      expect(container.querySelector(".book-spine,.book-cover,.shelf-ledge,.book-detail")).toBeNull();
      expect(container.querySelector(".mobile-current")?.getAttribute("href")).toBe("/read/own-1");
      expect([...container.querySelectorAll<HTMLElement>(".mobile-book")].map(el => el.dataset.docId)).toEqual(["own-0", "sample"]);
      expect(container.querySelector(".mobile-book small")?.textContent).not.toContain("已存");
      expect(load).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it("G-73b 书单与正在读共用展开状态，原生长按、键盘入口、色板与确认框", async () => {
    const { container, cleanup } = await setup(false);
    try {
      const rows = [...container.querySelectorAll<HTMLElement>(".mobile-swipe")];
      expect(rows).toHaveLength(3);
      const more = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".mobile-more")!;
      const opened = () => container.querySelectorAll(".mobile-swipe-open");
      const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      rows[1].querySelector("a")!.dispatchEvent(native); expect(native.defaultPrevented).toBe(false);
      await act(async () => more(rows[0]).click());
      expect(opened()).toHaveLength(1); expect(more(rows[0]).disabled).toBe(true);
      await act(async () => more(rows[1]).click());
      expect(opened()).toHaveLength(1); expect(rows[0].classList.contains("mobile-swipe-open")).toBe(false);
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => rows[1].querySelector("a")!.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true); expect(opened()).toHaveLength(0);
      await act(async () => more(rows[1]).click());
      await act(async () => rows[1].querySelector<HTMLButtonElement>(".mobile-swipe-actions button")!.click());
      expect(document.querySelectorAll(".spine-menu .color-swatch")).toHaveLength(11);
      expect(document.querySelector(".spine-menu")?.textContent).not.toContain("从书架移除");
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await act(async () => more(rows[2]).click());
      expect(rows[2].querySelectorAll(".mobile-swipe-actions button")).toHaveLength(1);
      await act(async () => rows[2].querySelector<HTMLButtonElement>(".mobile-swipe-actions button")!.click());
      expect(container.querySelector(".remove-confirm")).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>(".remove-confirm button")!.click());
      expect(container.querySelectorAll(".mobile-swipe")).toHaveLength(3);
    } finally { await cleanup(); }
  });
  it.each([[-47, 0, false], [-48, 0, true], [-9, 0, false], [-40, 60, false], [-48, 45, false]])("G-73b 手势方向与阈值 dx=%s dy=%s", async (dx, dy, expanded) => {
    const { container, cleanup } = await setup(false);
    try {
      const row = container.querySelector<HTMLElement>(".mobile-swipe")!;
      const send = async (type: string, x: number, y: number) => { await act(async () => row.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "touch", button: 0, clientX: x, clientY: y }))); };
      await send("pointerdown", 200, 100); await send("pointermove", 200 + dx, 100 + dy); await send("pointerup", 200 + dx, 100 + dy);
      expect(row.classList.contains("mobile-swipe-open")).toBe(expanded);
      if (Math.abs(dx) >= 1 && dy === 0) {
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        await act(async () => row.querySelector("a")!.dispatchEvent(click)); expect(click.defaultPrevented).toBe(true);
      }
    } finally { await cleanup(); }
  });
  it.each(["scroll", "outside", "Escape", "pagehide"])("G-73b %s 收回", async method => {
    const { container, cleanup } = await setup(false);
    try {
      await act(async () => container.querySelector<HTMLButtonElement>(".mobile-more")!.click());
      expect(container.querySelector(".mobile-swipe-open")).not.toBeNull();
      await act(async () => {
        if (method === "outside") document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        else if (method === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        else window.dispatchEvent(new Event(method));
      });
      expect(container.querySelector(".mobile-swipe-open")).toBeNull();
    } finally { await cleanup(); }
  });

  it("句序号零也显示接着读，封面右键继续可用，非 Node relatedTarget 不抛错", async () => {
    const { container, cleanup } = await setup(true);
    try {
      localStorage.setItem("gloss:pos:own-0", "0");
      await act(async () => container.querySelector<HTMLAnchorElement>(".book-slot")!.focus());
      expect(container.querySelector(".cover-action")?.textContent).toBe("接着读");
      const event = new MouseEvent("mouseout", { bubbles: true, relatedTarget: window });
      expect(() => container.querySelector(".book-cover")!.dispatchEvent(event)).not.toThrow();
      expect(container.querySelectorAll(".book-cover")).toHaveLength(1);
    } finally { await cleanup(); }
  });
});

it("G-16a 示例书始终是虚拟条目，移除只写 tombstone 并保留阅读记录", async () => {
  localStorage.clear();
  localStorage.setItem("gloss:pos:sample", "5");
  localStorage.setItem("gloss:saved:sample", "keep");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches:true, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  await storage.saveDocument(assembleDocument({ paragraphs: ["测试自有书。"], headings: [], footnotes: [] }, "txt", "自有书.txt"));
  const clearCache = vi.spyOn(cache, "clearGlossCacheForDocument");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Shelf)); });
    const spine = container.querySelector<HTMLElement>('.book-slot[data-doc-id="sample"] .book-spine');
    expect(spine?.textContent).toContain("示例");
    expect(localStorage.getItem("gloss:doc:sample")).toBeNull();
    expect(localStorage.getItem("gloss:shelf:v1")).not.toContain('"sample"');
    await act(async () => { spine!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const menuRemove = [...document.querySelectorAll<HTMLButtonElement>(".spine-menu button")]
      .find((button) => button.textContent === "从书架移除");
    await act(async () => { menuRemove!.click(); });
    const confirm = [...container.querySelectorAll<HTMLButtonElement>(".remove-confirm button")]
      .find((button) => button.textContent === "确认移除");
    await act(async () => { confirm!.click(); });
    expect(container.querySelector('.book-slot[data-doc-id="sample"]')).toBeNull();
    expect(localStorage.getItem("gloss:sample:removed")).toBe("1");
    expect(localStorage.getItem("gloss:pos:sample")).toBe("5");
    expect(localStorage.getItem("gloss:saved:sample")).toBe("keep");
    expect(clearCache).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});


describe("G-52 首页分流", () => {
  async function renderWithEntries(entries: storage.ShelfEntry[], sampleRemoved = false) {
    localStorage.clear();
    if (sampleRemoved) localStorage.setItem("gloss:sample:removed", "1");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({ matches:true, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.spyOn(storage, "loadShelf").mockReturnValue({ entries, unavailable: false });
    const initial = renderToString(createElement(Shelf));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Shelf)); });
    return { initial, container, root };
  }

  it.each([false, true])("无自有书时显示落地页，sample removed=%s", async (removed) => {
    const { initial, container, root } = await renderWithEntries([], removed);
    try {
      expect(initial).toContain("shelf-loading");
      expect(initial).not.toContain("landing-page");
      expect(initial).not.toContain("shelf-page");
      expect(container.querySelector(".landing-page")).not.toBeNull();
      expect(container.querySelector(".shelf-page")).toBeNull();
      const button = container.querySelector<HTMLButtonElement>(".landing-secondary");
      await act(async () => { button!.click(); });
      expect(container.querySelector(".import-panel")).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      localStorage.clear();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("有一本自有书时只显示原书架，且不记 landing_view", async () => {
    const ownBook = { ...SAMPLE_SHELF_ENTRY, docId: "own-book" };
    const { initial, container, root } = await renderWithEntries([ownBook]);
    try {
      expect(initial).toContain("shelf-loading");
      expect(initial).not.toContain("landing-page");
      expect(container.querySelector(".shelf-page")).not.toBeNull();
      expect(container.querySelector(".landing-page")).toBeNull();
      const events = JSON.parse(localStorage.getItem("gloss:analytics:local:v1") ?? "{}").outbox ?? [];
      expect(events.filter((event: { event: string }) => event.event === "landing_view")).toHaveLength(0);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      localStorage.clear();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
