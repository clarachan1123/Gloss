// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import * as cache from "@/lib/cache";
import Shelf, { relatedTargetLeftSlot } from "./Shelf";

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
