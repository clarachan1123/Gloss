import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_GLOSS_CACHE_RUNTIME,
  GLOSS_CACHE_SCHEMA_VERSION,
  addRecord,
  hashGlossContext,
  lookupPreloadedGloss,
  makeGlossCacheKey,
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
  it("暴露命中 / 未命中接口给 G-15，带摘要时不采用无摘要条目", () => {
    const entries = new Map([[3, { text: "已缓存", hasStructure: false }]]);
    expect(lookupPreloadedGloss(entries, 3, false)).toEqual({
      status: "hit",
      entry: { text: "已缓存", hasStructure: false },
    });
    expect(lookupPreloadedGloss(entries, 3, true)).toEqual({ status: "miss" });
  });

  it("两个只差一个空白字符的实际请求得到不同上下文 hash", async () => {
    const left = await hashGlossContext({ ...input, sentence: "原句 A。" });
    const right = await hashGlossContext({ ...input, sentence: "原句  A。" });
    expect(left).not.toBe(right);
  });

  it("有摘要时只接受有摘要条目；无摘要时优先有摘要条目", async () => {
    const withStructure = await record(true, "带摘要白话");
    const withoutStructure = await record(false, "无摘要白话");
    const contextHash = await hashGlossContext(input);
    expect(selectRecord([withStructure, withoutStructure], "12345678", contextHash, CURRENT_GLOSS_CACHE_RUNTIME, true)).toEqual({
      text: "带摘要白话",
      hasStructure: true,
    });
    expect(selectRecord([withoutStructure], "12345678", contextHash, CURRENT_GLOSS_CACHE_RUNTIME, true)).toBeNull();
    expect(selectRecord([withoutStructure, withStructure], "12345678", contextHash, CURRENT_GLOSS_CACHE_RUNTIME, false)).toEqual({
      text: "带摘要白话",
      hasStructure: true,
    });
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
