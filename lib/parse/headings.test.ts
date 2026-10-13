import { describe, expect, it } from "vitest";
import { detectHeadings } from "./headings";
import { normalizeWhitespace } from "./validate";

const body = "这是用于隔开标题的自写正文，包含标点而且长度足够，不会被识别成无序号标题。".repeat(2);
const separated = (titles: string[]) => titles.flatMap((title) => [title, body]);

describe("G-27 序号族", () => {
  it.each([
    ["第一编 开端", "第二篇 续篇"], ["第1部 开端", "第2卷 续篇"],
    ["第一章 开端", "第2章 续章"], ["第一节 开端", "第2节 续节"],
    ["第一 哲学", "第2 科学"], ["一、开端", "二．续篇", "三.终篇"],
    ["（一）开端", "(二)续篇"], ["1. 开端", "2、续篇", "3．终篇"],
    ["1.1 开端", "2.1 续篇"], ["A 开端", "B、续篇"],
  ])("识别变体 %j", (...titles: string[]) => {
    const paragraphs = separated(titles);
    expect(detectHeadings(paragraphs)).toEqual(titles.map((text, i) => ({ paraIndex: i * 2, level: 1, text })));
  });
  it.each(["◇", "◆", "■", "□", "●", "○"])("编篇部卷允许装饰符 %s", (symbol) => {
    expect(detectHeadings(separated([symbol + "第一编 开端", symbol + "第二卷 续篇"]))).toHaveLength(2);
  });
  it("九族按固定高低顺序编号，不按首次出现顺序，规则二可到十层", () => {
    const highToLow = ["第一编 开端", "第一章 开端", "第一节 开端", "第一 哲学", "一、开端",
      "（一）开端", "1. 开端", "1.1 开端", "A 开端"];
    const second = ["第二部 续篇", "第二章 续章", "第二节 续节", "第二 科学", "二.续篇",
      "(二)续篇", "2、续篇", "2.1 续篇", "B、续篇"];
    const paragraphs = separated([...highToLow].reverse().concat([...second].reverse()));
    paragraphs.push("无序号小题", body);
    const result = detectHeadings(paragraphs);
    expect(result.slice(0, 9).map((h) => h.level)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(result.at(-1)).toEqual({ paraIndex: 36, level: 10, text: "无序号小题" });
  });
  it("一次不算；同族相邻候选全部排除，按剩余族压缩层级", () => {
    expect(detectHeadings(["第一章 独章", body])).toEqual([]);
    expect(detectHeadings(["第一章 甲", "第二章 乙", body])).toEqual([]);
    expect(detectHeadings(["第一章 甲", "第二章 乙", body, "第一节 甲", body, "第二节 乙", body])
      .map((h) => h.level)).toEqual([1, 1]);
  });
  it("任意一侧相邻即排除，不逐个删除候选影响后续判定", () => {
    expect(detectHeadings(["一、甲", "二、乙", "三、丙", body, "四、丁", body]))
      .toEqual([{ paraIndex: 4, level: 1, text: "四、丁" }]);
  });
  it("不同族相邻不排除；1.1 不算 1. 族", () => {
    const result = detectHeadings(["1. 开端", "1.1 小题", body, "2. 续篇", "2.1 小题", body]);
    expect(result.map((h) => h.level)).toEqual([1, 2, 1, 2]);
  });
  it.each(Array.from("。！？；：，、…!?;:,"))("排除行末 %s", (punctuation) => {
    expect(detectHeadings(separated(["第一章 甲" + punctuation, "第二章 乙" + punctuation]))).toEqual([]);
  });
  it("段内句号、超长候选排除；30 个码点含内部空格，段首尾空白不计", () => {
    expect(detectHeadings(separated(["第一章 甲。乙", "第二章 丙。丁"]))).toEqual([]);
    const a = "第一章 " + "𠀀".repeat(26);
    const b = "第二章 " + "𠀀".repeat(26);
    expect(detectHeadings(separated(["  " + a + "  ", b]))).toHaveLength(2);
    expect(detectHeadings(separated([a + "甲", b + "乙"]))).toEqual([]);
  });
});

describe("G-27 关键词", () => {
  it.each(["绪论", "绪言", "序言", "序", "导言", "引言", "导论", "结论", "结语",
    "附录", "后记", "跋", "自序", "前言"])("关键词 %s 一次即算且层级为 1", (text) => {
    expect(detectHeadings([text])).toEqual([{ paraIndex: 0, level: 1, text }]);
  });
  it("允许空格加最多 20 字，或一至两个中文数字；不受相邻过滤", () => {
    const titles = ["绪言二", "绪言十二", "绪言 " + "甲".repeat(20), "前言"];
    expect(detectHeadings(titles).map((h) => h.text)).toEqual(titles);
    expect(detectHeadings(["绪言 " + "甲".repeat(21), "绪言一二三", "绪言2", "绪言正文", "摘要", "参考文献"])).toEqual([]);
  });
  it("依赖空格的形式在归一化前识别，输出段落原文", () => {
    const paragraphs = ["  第一 哲学  ", body, "第二 科学", body, "绪言 哲学的开端"];
    expect(detectHeadings(paragraphs).map((h) => h.text)).toEqual([paragraphs[0], paragraphs[2], paragraphs[4]]);
    expect(detectHeadings(paragraphs.map(normalizeWhitespace))).toEqual([]);
  });
});

describe("G-27 无序号短行", () => {
  it("仅在最终规则一保留至少两条时启用，关键词计入门槛", () => {
    for (const prefix of [[], ["序言"], ["第一章 甲", "第二章 乙"]]) {
      expect(detectHeadings([...prefix, body, "短标题", body]).some((h) => h.text === "短标题")).toBe(false);
    }
    expect(detectHeadings(["序言", "后记", "短标题", body]).at(-1))
      .toEqual({ paraIndex: 2, level: 2, text: "短标题" });
  });
  it("层级为最终最深层级加一，既有标题不重复", () => {
    const paragraphs = separated(["第一章 甲", "第一节 甲", "第二章 乙", "第二节 乙"]);
    paragraphs.push("小题", body);
    expect(detectHeadings(paragraphs).map((h) => h.level)).toEqual([1, 2, 1, 2, 3]);
  });
  it("20 / 40 码点边界；内部空格计入；没有下一段不算", () => {
    const prefix = ["序言", "后记"];
    expect(detectHeadings([...prefix, "𠀀".repeat(20), "甲".repeat(40)]).map((h) => h.paraIndex)).toEqual([0, 1, 2]);
    for (const [title, next] of [["甲".repeat(21), body], ["甲".repeat(19) + " 乙", body], ["短题", "甲".repeat(39)]]) {
      expect(detectHeadings([...prefix, title, next]).some((h) => h.paraIndex === 2)).toBe(false);
    }
    expect(detectHeadings([...prefix, "末尾短题"]).map((h) => h.paraIndex)).toEqual([0, 1]);
  });
  it.each(Array.from('，。、；：！？,.;:!?（）()「」“”"…—'))("排除短行标点 %s", (punctuation) => {
    expect(detectHeadings(["序言", "后记", "甲" + punctuation + "乙", body]).map((h) => h.paraIndex)).toEqual([0, 1]);
  });
  it("不改输入数组和文字", () => {
    const input = Object.freeze([" 第一章 甲 ", body, "第二章 乙", body]);
    const before = [...input];
    detectHeadings(input);
    expect(input).toEqual(before);
  });
});
