import { describe, expect, it } from "vitest";
import { lookupPreloadedGloss, type MemoryGloss } from "@/lib/cache";
import { retainGlossAfterUnsave } from "./Reader";

describe("G-10a 取消保存", () => {
  it("保留当前显示文本为会话内存命中：取消后不需要发请求", () => {
    const memory = new Map<number, MemoryGloss>();
    retainGlossAfterUnsave(memory, 4, { status: "done", text: "保存时正在看的版本", failure: null, instant: true }, false);

    // Reader 请求 effect 不依赖 savedGlosses；以后因收起再打开进入 effect 时，这个命中会直接返回。
    expect(lookupPreloadedGloss(memory, 4, false)).toMatchObject({ status: "hit", entry: { text: "保存时正在看的版本" } });
  });

  it("收起后再点同一句仍命中相同文本，不需要现场生成", () => {
    const memory = new Map<number, MemoryGloss>();
    retainGlossAfterUnsave(memory, 8, { status: "done", text: "不替换的白话", failure: null, instant: true }, true);

    const reopened = lookupPreloadedGloss(memory, 8, true);
    expect(reopened).toMatchObject({ status: "hit", entry: { text: "不替换的白话" } });
    expect(memory.get(8)).toMatchObject({ source: "session", shown: true });
  });
});
