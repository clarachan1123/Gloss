// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { relatedTargetLeftSlot } from "./Shelf";

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
