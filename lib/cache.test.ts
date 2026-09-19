// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_GLOSS_CACHE_RUNTIME,
  GLOSS_CACHE_SCHEMA_VERSION,
  addRecord,
  clearAllGlossCache,
  hashGlossContext,
  lookupPreloadedGloss,
  makeGlossCacheKey,
  mergePreloadedGlosses,
  selectRecord,
  type GlossCacheRecord,
} from "./cache";

const input = { sentence: "原句 A。", before: ["前文。"], after: ["后文。"], structure: null };

async function record(hasStructure: boolean, text: string): Promise<GlossCacheRecord> {
  const contextHash = await hashGlossContext(input);
  const runtime = CURRENT_GLOSS_CACHE_RUNTIME;
  return {
    key: makeGlossCacheKey({ docId: "12345678", contextHash, hasStructure, runtime }),
    docId: "12345678",
    contextHash,
    hasStructure,
    runtime,
    schemaVersion: GLOSS_CACHE_SCHEMA_VERSION,
    text,
    structureHash: hasStructure ? "structure-hash" : null,
    savedAt: 1,
  };
}

describe("G-09 自动缓存键", () => {
  it("预载晚于成功生成时不丢会话结果，也不覆盖已有条目", () => {
    const memory = new Map([[2, { text: "刚生成", hasStructure: false, source: "session" as const, shown: true }]]);
    mergePreloadedGlosses(memory, new Map([[2, { text: "旧预载", hasStructure: true }], [3, { text: "新预载", hasStructure: true }]]));
    expect(memory.get(2)?.text).toBe("刚生成");
    expect(memory.get(3)?.text).toBe("新预载");
  });

  it("暴露命中 / 未命中接口给 G-15，当前摘要状态不拒绝无摘要条目", () => {
    const entries = new Map([[3, { text: "已缓存", hasStructure: false }]]);
    expect(lookupPreloadedGloss(entries, 3, false)).toEqual({ status: "hit", entry: { text: "已缓存", hasStructure: false } });
    expect(lookupPreloadedGloss(entries, 3, true)).toEqual({ status: "hit", entry: { text: "已缓存", hasStructure: false } });
  });

  it("只有无摘要条目且当前有摘要状态时查找命中", () => {
    const entries = new Map([[4, { text: "无摘要白话", hasStructure: false }]]);
    expect(lookupPreloadedGloss(entries, 4, true)).toEqual({ status: "hit", entry: { text: "无摘要白话", hasStructure: false } });
  });

  it("两个只差一个空白字符的实际请求得到不同上下文 hash", async () => {
    const left = await hashGlossContext({ ...input, sentence: "原句 A。" });
    const right = await hashGlossContext({ ...input, sentence: "原句  A。" });
    expect(left).not.toBe(right);
  });

  it("两种条目都有时预载优先带摘要条目", async () => {
    const withStructure = await record(true, "带摘要白话");
    const withoutStructure = await record(false, "无摘要白话");
    const contextHash = await hashGlossContext(input);
    expect(selectRecord([withStructure, withoutStructure], "12345678", contextHash, CURRENT_GLOSS_CACHE_RUNTIME, true)).toEqual({
      text: "带摘要白话",
      hasStructure: true,
    });
    expect(selectRecord([withoutStructure], "12345678", contextHash, CURRENT_GLOSS_CACHE_RUNTIME, true)).toEqual({
      text: "无摘要白话",
      hasStructure: false,
    });
    expect(selectRecord([withoutStructure, withStructure], "12345678", contextHash, CURRENT_GLOSS_CACHE_RUNTIME, false)).toEqual({
      text: "带摘要白话",
      hasStructure: true,
    });
  });

  it("摘要后来就绪时，未展示的无摘要预载由带摘要预载替换", () => {
    const memory = new Map([[5, { text: "无摘要白话", hasStructure: false, source: "preload" as const, shown: false }]]);
    mergePreloadedGlosses(memory, new Map([[5, { text: "带摘要白话", hasStructure: true }]]));
    expect(memory.get(5)).toMatchObject({ text: "带摘要白话", hasStructure: true, source: "preload", shown: false });
  });
});

describe("G-09 写入保留先到结果", () => {
  it("同键已有条目时只用 add，ConstraintError 静默忽略，不调用 put 覆盖", async () => {
    const idbRequest = {} as IDBRequest<IDBValidKey>;
    const add = vi.fn(() => {
      queueMicrotask(() => {
        Object.assign(idbRequest, { error: new DOMException("exists", "ConstraintError") });
        idbRequest.onerror?.(new Event("error"));
      });
      return idbRequest;
    });
    const put = vi.fn();
    const fakeStore = { add, put } as unknown as IDBObjectStore;
    expect(await addRecord(fakeStore, await record(false, "后到的结果"))).toBe("exists");
    expect(add).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("G-10a 清除自动缓存", () => {
  it("只删除 IndexedDB 自动缓存数据库；不触碰 localStorage 的保存区、原文、位置或结构摘要", async () => {
    localStorage.setItem("gloss:saved:12345678", "保存白话");
    localStorage.setItem("gloss:doc:12345678", "原文");
    localStorage.setItem("gloss:pos:12345678", "4");
    localStorage.setItem("gloss:structure:12345678", "摘要");
    const request = {} as IDBOpenDBRequest;
    const deleteDatabase = vi.fn(() => request);
    vi.stubGlobal("indexedDB", { deleteDatabase });
    const result = clearAllGlossCache();
    request.onsuccess?.(new Event("success"));
    expect(await result).toBe(true);
    expect(deleteDatabase).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("gloss:saved:12345678")).toBe("保存白话");
    expect(localStorage.getItem("gloss:doc:12345678")).toBe("原文");
    expect(localStorage.getItem("gloss:pos:12345678")).toBe("4");
    expect(localStorage.getItem("gloss:structure:12345678")).toBe("摘要");
    vi.unstubAllGlobals();
  });
});
