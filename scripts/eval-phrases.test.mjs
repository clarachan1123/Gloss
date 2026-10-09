import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { containsPhrase, scorePhrases } from "./eval-phrases.mjs";

describe("G-56 说法原样留存的机械口径", () => {
  it("去空白和术语定界符，要求整个说法连续出现", () => {
    expect(containsPhrase("他要⟦通晓 物情⟧。", "通晓物情")).toBe(true);
    expect(containsPhrase("他通晓，物情。", "通晓物情")).toBe(false);
    expect(containsPhrase("只写通晓而不写后半句。", "通晓物情")).toBe(false);
  });

  it("标注说法带标点时双方去标点，先引用再解释仍计原样出现", () => {
    const phrase = "以其人之道，还治其人之身";
    expect(containsPhrase("他说“以其人之道，还治其人之身”，接着解释。", phrase)).toBe(true);
    expect(containsPhrase("以其人之道；还治其人之身。", phrase)).toBe(true);
    expect(containsPhrase("用对方的办法回应对方。", phrase)).toBe(false);
  });

  it("按每个标注说法计数，列出该换却保留和该保留却丢失的明细", () => {
    const labels = { items: [
      { id: "a", "原句": "甲。", "换": ["通晓物情"], "保留": ["天赋人权"] },
      { id: "b", "原句": "乙。", "换": ["以其人之道，还治其人之身"], "保留": ["公律"] },
    ] };
    const materials = labels.items.map((item) => ({ id: item.id, "原句": item["原句"] }));
    const report = { prompt: "gloss-v12", items: [
      { id: "a", text: "⟦天赋人权⟧要求通晓物情。", error: null },
      { id: "b", text: "“以其人之道，还治其人之身”就是用对方的办法回应。", error: null },
    ] };
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = vi.fn(() => { throw new Error("离线打分不应发请求"); });
    try {
      const scored = scorePhrases(labels, materials, report, "gloss-v12");
      expect(scored).toMatchObject({ items: 2, swapTotal: 2, swapUnchanged: 2, keepTotal: 2, keepPresent: 1 });
      expect(scored.details).toEqual([
        { id: "a", type: "换", phrase: "通晓物情", present: true },
        { id: "a", type: "保留", phrase: "天赋人权", present: true },
        { id: "b", type: "换", phrase: "以其人之道，还治其人之身", present: true },
        { id: "b", type: "保留", phrase: "公律", present: false },
      ]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(() => scorePhrases(labels, materials, report, "gloss-v11")).toThrow("提示词版本不符");
      expect(() => scorePhrases(labels, materials, { ...report, items: report.items.slice(0, 1) })).toThrow("条数不一致");
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it("脚本代码不包含网络调用入口", async () => {
    const source = await readFile(new URL("./eval-phrases.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|https?:\/\/|node:https?/);
  });
});
