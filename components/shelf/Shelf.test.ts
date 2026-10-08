// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import * as cache from "@/lib/cache";
import * as storage from "@/lib/storage";
import { assembleDocument } from "@/lib/parse/validate";
import { takeReaderEntrySource } from "@/lib/analytics-local";
import { SAMPLE_SHELF_ENTRY } from "@/lib/sample";
import Shelf, { enterFromShelf, relatedTargetLeftSlot } from "./Shelf";

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
    enterFromShelf(ownBook, "start");
    expect(events).toEqual([{ event: "shelf_book_click", entry: "start", daysSinceOpenBucket: "never" }]);
    expect(takeReaderEntrySource("own-book")).toBe("shelf");
  } finally {
    window.removeEventListener("gloss:analytics", onAnalytics);
    takeReaderEntrySource("");
  }
});

describe("G-44 预览离开判据", () => {
  it("relatedTarget 不是 Node 时按已离开处理，不抛异常", () => {
    const slot = document.createElement("div");
    expect(() => relatedTargetLeftSlot(slot, window)).not.toThrow();
    expect(relatedTargetLeftSlot(slot, window)).toBe(true);
    expect(relatedTargetLeftSlot(slot, null)).toBe(true);
  });

  it("焦点或鼠标仍在 slot 的子节点时保持预览", () => {
    const slot = document.createElement("div");
    const cover = document.createElement("a");
    slot.append(cover);
    expect(relatedTargetLeftSlot(slot, cover)).toBe(false);
    expect(relatedTargetLeftSlot(slot, document.createElement("button"))).toBe(true);
  });
});

it("G-16a 示例书始终是虚拟条目，移除只写 tombstone 并保留阅读记录", async () => {
  localStorage.clear();
  localStorage.setItem("gloss:pos:sample", "5");
  localStorage.setItem("gloss:saved:sample", "keep");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
