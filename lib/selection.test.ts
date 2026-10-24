import { describe, it, expect } from "vitest";
import { segmentParagraphs } from "./segment";
import { normalizeSelection, sourcePointFromGlyphs, selectionSummary, type SourceGlyph } from "./selection";
const selected = (paragraphs: string[], a: number, b: number, endPara = 0) => normalizeSelection(paragraphs, segmentParagraphs(paragraphs).sentences, { paraIndex: 0, offset: a }, { paraIndex: endPara, offset: b });
describe("划选原文坐标、边界与结果分流", () => {
  it("资本主吸附到资本主义", () => { expect(selected(["资本主义以前的社会。"], 0, 2)?.text).toBe("资本主义"); });
  it("中国的儒道自动带一个顿号", () => { const r = selected(["中国的儒道、印度的佛教。"], 0, 4)!; expect(r.text).toBe("中国的儒道、"); expect(r.autoPunctuation).toBe("、"); });
  it("反向拖选与正向结果相同", () => { expect(selected(["资本主义以前的社会。"], 2, 0)).toEqual(selected(["资本主义以前的社会。"], 0, 2)); });
  it("跨段按原始坐标拼接，强制为范围", () => { const r = selected(["第一段", "第二段"], 0, 2, 1)!; expect(r.text).toBe("第一段\n第二段"); expect(r.kind).toBe("range"); expect(r.sentenceCount).toBe(2); });
  it("代理对两半都定位到同一码点", () => { const p = ["😀，随后继续。"]; expect(selected(p, 0, 0)?.text).toBe("😀，"); expect(selected(p, 1, 1)).toEqual(selected(p, 0, 0)); });
  it("去开头标点并保留真实源坐标", () => { expect(selected(["“资本主义”的时代。"], 0, 3)?.start.offset).toBe(1); });
  it("整句优先于无标点短词", () => { expect(selected(["那一种是对的？"], 0, 5)?.kind).toBe("sentence"); });
  it("整句忽略段首隐藏空白", () => { expect(selected(["　那一种是对的？"], 1, 6)?.kind).toBe("sentence"); });
  it.each([12, 13])("%i字符的语境释义边界", n => { const core = "天地玄黄宇宙洪荒日月盈昃辰".slice(0, n); const r = selected([core + "，余文。"], 0, n - 1)!; expect(r.kind).toBe(n === 12 ? "term" : "range"); });
  it.each([999, 1000, 1001])("%i码点不按UTF16长度计数", n => { const r = selected(["😀".repeat(n) + "尾。"], 0, (n - 1) * 2)!; expect(r.chars).toBe(n); expect(r.chars <= 1000).toBe(n <= 1000); });
  it("没有标点但长于12字走范围", () => { expect(selected(["天地玄黄宇宙洪荒日月盈昃辰，余文。"], 0, 12)?.kind).toBe("range"); });
  it("只含标点不构成选区", () => { expect(selected(["！？”"], 0, 1)).toBeNull(); });
  it("显式选择的末尾标点不算自动附带", () => { expect(selected(["词语，后文。"], 0, 2)?.autoPunctuation).toBe(""); });
  it("摘要超过16字保留前后各7字", () => { expect(selectionSummary("一二三四五六七八九十一二三四五六七八")).toBe("一二三四五六七…二三四五六七八"); });
});
describe("只有真实原文字框可以成为端点", () => {
  const glyph: SourceGlyph = { kind: "source", start: { paraIndex: 2, offset: 9 }, end: { paraIndex: 2, offset: 10 }, left: 10, right: 20, top: 30, bottom: 40 };
  it("命中字框才取原始坐标", () => { expect(sourcePointFromGlyphs([glyph], 15, 35)).toEqual(glyph.start); expect(sourcePointFromGlyphs([glyph], 21, 35)).toBeNull(); });
  it.each(["panel", "placeholder", "note"] as const)("%s内的点不算原文", kind => { expect(sourcePointFromGlyphs([{ ...glyph, kind }], 15, 35)).toBeNull(); });
});
