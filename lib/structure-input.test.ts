import { describe, expect, it } from "vitest";
import { buildStructureInput } from "./structure-input";
import { countChars } from "./parse/validate";
import { parseStructureRequest } from "./context";

const chars = (texts: string[]) => texts.reduce((n, text) => n + countChars(text), 0);
describe("G-61 structure input", () => {
  it.each([49_999, 50_000])("%i 字输入 JSON 逐字节不变", (length) => {
    const input = { title: " 标题 ", headings: [" 目录一 ", "目录二"], paragraphs: ["　" + "甲".repeat(length) + " \n"] };
    expect(JSON.stringify(buildStructureInput(input))).toBe(JSON.stringify(input));
    expect(buildStructureInput(input)).toBe(input);
  });
  it("20 万字覆盖十段、完整段落连续且顺序正确、全部短标题保留", () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => String(i).padStart(3, "0") + "甲".repeat(997));
    const input = { title: "书名", headings: ["序", "终"], paragraphs };
    const sampled = buildStructureInput(input);
    expect(sampled.title).toBe(input.title);
    expect(sampled.headings).toEqual(input.headings);
    const budget = Math.floor((50_000 - 2) / 10);
    expect(sampled.paragraphs).toEqual(Array.from({ length: 10 }, (_, i) => paragraphs.slice(i * 20, i * 20 + Math.floor(budget / 1000))).flat());
    expect(countChars(sampled.title ?? "") + chars(sampled.headings) + chars(sampled.paragraphs)).toBeLessThanOrEqual(50_000);
    expect(parseStructureRequest(sampled).ok).toBe(true);
  });
  it("超长单段覆盖十个字符区间，按同一预算截取开头，代理对及空白口径一致", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => String(i).repeat(1) + "𠀀　".repeat(19_999));
    const input = { title: null, headings: [], paragraphs: [blocks.join("")] };
    const sampled = buildStructureInput(input);
    expect(sampled.paragraphs).toHaveLength(10);
    expect(sampled.paragraphs.map(countChars)).toEqual(Array(10).fill(5000));
    expect(sampled.paragraphs.map(p => p.trimStart()[0])).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
    expect(sampled.paragraphs.every(p => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
  });
  it("标题超过五千字时均匀抽取并保留顺序，总标题正文不超过五万", () => {
    const headings = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, "0") + "题".repeat(98));
    const result = buildStructureInput({ title: "标题", headings, paragraphs: Array(200).fill("甲".repeat(1000)) });
    expect(result.headings).toHaveLength(50);
    expect(result.headings).toEqual(Array.from({ length: 50 }, (_, i) => headings[Math.floor(i * 99 / 49)]));
    expect(chars(result.headings)).toBe(5000);
    expect(countChars(result.title ?? "") + chars(result.headings) + chars(result.paragraphs)).toBeLessThanOrEqual(50_000);
  });
  it("无法完整容纳的巨标题不突破标题预算", () => {
    const result = buildStructureInput({ title: null, headings: ["题".repeat(5001)], paragraphs: ["甲".repeat(200_000)] });
    expect(result.headings).toEqual([]);
    expect(chars(result.paragraphs)).toBe(50_000);
  });
});


it("G-61 字符分段边界落在普通段落内时保留完整段落", () => {
  const paragraphs = Array.from({ length: 199 }, (_, i) => String(i).padStart(3, "0") + "甲".repeat(998));
  const result = buildStructureInput({ title: null, headings: [], paragraphs });
  expect(result.paragraphs).toEqual(Array.from({ length: 10 }, (_, part) => {
    const start = Math.floor(199 * part / 10);
    return paragraphs.slice(start, start + 4);
  }).flat());
  expect(result.paragraphs.every(p => paragraphs.includes(p))).toBe(true);
});