// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocx } from "./parse/docx";
import { countChars } from "./parse/validate";
import { MAX_SENTENCE_CHARS, segmentParagraphs } from "./segment";

// Node 版 mammoth 只接受 { path } / { buffer }，浏览器版才接受 { arrayBuffer }。
// 这里只转换输入形式；解析仍是真实的 mammoth + lib/parse/docx.ts。
vi.mock("mammoth", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual: any = await importOriginal();
  const mammoth = actual.default ?? actual;
  return {
    default: {
      ...mammoth,
      convertToHtml: (input: { arrayBuffer?: ArrayBuffer }, options: unknown) =>
        mammoth.convertToHtml(
          input.arrayBuffer ? { buffer: Buffer.from(input.arrayBuffer) } : input,
          options,
        ),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sentencesOf = (paragraphs: string[]) => segmentParagraphs(paragraphs).sentences;
const texts = (paragraphs: string[]) => sentencesOf(paragraphs).map((s) => s.text);
const degradedOf = (paragraphs: string[]) => segmentParagraphs(paragraphs).degradedParagraphs;
const chunk = (n: number) => "字".repeat(n);
const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

/* ---------------- 真实样本 ---------------- */

const FIXTURE = "test-fixtures/政治经济学批判-序言.docx";

describe.skipIf(!existsSync(FIXTURE))(
  "真实样本 政治经济学批判-序言.docx（样本文件被 git 忽略，此机器上不存在时跳过）",
  () => {
    async function load() {
      // G-24 起 parseDocx 返回 { doc, warnings, detail }
      const { doc } = await parseDocx(new File([readFileSync(FIXTURE)], "政治经济学批判-序言.docx"));
      const { sentences, degradedParagraphs } = segmentParagraphs(doc.paragraphs);
      const inPara = (i: number) => sentences.filter((s) => s.paraIndex === i);
      return { doc, sentences, degradedParagraphs, inPara };
    }

    it("61 句 · 平均 49.8 · 最长 157 · 最短 2，逐段分布一致，无超长警告", async () => {
      const warn = spyWarn();
      const { doc, sentences, inPara } = await load();
      const counts = sentences.map((s) => s.charCount);
      const total = counts.reduce((a, b) => a + b, 0);

      expect(doc.paragraphs).toHaveLength(15);
      expect(doc.paragraphs.map((_, i) => inPara(i).length)).toEqual([
        1, 1, 1, 6, 3, 6, 23, 7, 6, 2, 1, 1, 1, 1, 1,
      ]);
      expect(sentences).toHaveLength(61);
      expect((total / sentences.length).toFixed(1)).toBe("49.8");
      expect(Math.max(...counts)).toBe(157);
      expect(Math.min(...counts)).toBe(2);
      expect(total).toBe(doc.meta.charCount);
      expect(sentences.map((s) => s.index)).toEqual(sentences.map((_, i) => i));
      doc.paragraphs.forEach((p, i) => {
        expect(inPara(i).map((s) => s.text).join("")).toBe(p);
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("降级段落恰好是段 11、段 13（前标点未在段内闭合），其余 13 段不降级", async () => {
      const { doc, degradedParagraphs } = await load();
      expect(degradedParagraphs).toEqual([10, 12]);
      doc.paragraphs.forEach((_, i) => {
        if (i !== 10 && i !== 12) expect(degradedParagraphs).not.toContain(i);
      });
    });

    it("段 11：书名号本段未闭合、分号在段末 → 1 句；段 12 的 》 不打乱状态 → 1 句", async () => {
      const { inPara } = await load();
      expect(inPara(10)).toHaveLength(1);
      expect(inPara(10)[0].text.endsWith("；")).toBe(true);
      expect(inPara(11)).toHaveLength(1);
      expect(inPara(11)[0].text.endsWith("》")).toBe(true);
    });

    it("段 14：句号后的孤立后引号并入前一句", async () => {
      const { inPara } = await load();
      expect(inPara(13)).toHaveLength(1);
      expect(inPara(13)[0].text.endsWith("。”")).toBe(true);
    });

    it("段 9：带引号的报名与方括号数字角标、全角括号不被切开", async () => {
      const { inPara } = await load();
      const para = inPara(8);
      expect(para).toHaveLength(6);
      expect(para.some((s) => s.text.includes("“新莱茵报”[14]的出版"))).toBe(true);
      expect(para.some((s) => /“纽约每日论坛报”\[15\]撰稿（[^）]*）/.test(s.text))).toBe(true);
    });

    it("段 7：1211 字切出 23 句，每句不超过 250 字", async () => {
      const { doc, inPara } = await load();
      expect(countChars(doc.paragraphs[6])).toBe(1211);
      expect(inPara(6)).toHaveLength(23);
      for (const s of inPara(6)) expect(s.charCount).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    });
  },
);

/* ---------------- B4 句末标点 ---------------- */

describe("B4 句末标点", () => {
  it("。！？；． 与半角 ! ? ; 都是句末", () => {
    expect(texts(["甲。乙！丙？丁；戊．己!庚?辛;"])).toEqual([
      "甲。", "乙！", "丙？", "丁；", "戊．", "己!", "庚?", "辛;",
    ]);
  });

  it("半角 . 不是句末", () => {
    expect(texts(["价格涨了1.5倍，Mr. Smith 说。"])).toHaveLength(1);
  });

  it("省略号、破折号不是句末", () => {
    expect(texts(["他想了想……又说——算了。"])).toHaveLength(1);
  });

  it("连续句末标点合为一句", () => {
    expect(texts(["真的吗？！是的。"])).toEqual(["真的吗？！", "是的。"]);
  });
});

/* ---------------- B3 成对标点 ---------------- */

describe("B3 成对标点内部不切（含全角括号）", () => {
  it.each([
    "“好。走吧。”他说。",
    "‘好。’他说。",
    "《甲。乙》出版了。",
    "「甲。乙」他说。",
    "『甲。乙』他说。",
    "（甲。乙）他说。",
    "［甲。乙］他说。",
  ])("%s → 1 句，不降级", (p) => {
    expect(texts([p])).toEqual([p]);
    expect(degradedOf([p])).toEqual([]);
  });

  it("《甲；乙》。 → 1 句（B3 优先于 B4）", () => {
    expect(texts(["《甲；乙》。"])).toEqual(["《甲；乙》。"]);
  });

  it("嵌套的成对标点", () => {
    expect(texts(["“他读了《甲。乙》。”然后走了。"])).toHaveLength(1);
  });

  it("半角 () 不保护", () => {
    expect(texts(["(甲。乙)"])).toEqual(["(甲。", "乙)"]);
  });

  it("前标点跨段未闭合：本段降级，不影响下一段", () => {
    const result = segmentParagraphs(["《甲；", "乙》。丙。"]);
    expect(result.sentences.map((s) => [s.paraIndex, s.text])).toEqual([
      [0, "《甲；"],
      [1, "乙》。"],
      [1, "丙。"],
    ]);
    expect(result.degradedParagraphs).toEqual([0]);
  });
});

/* ---------------- 未配对前标点：整段降级 ---------------- */

describe("段内有未配对的前标点 → 该段放弃成对标点保护", () => {
  it("段中一个孤立的前引号 “，该段仍按句号正常切分，并记入 degradedParagraphs", () => {
    const result = segmentParagraphs(["他说：“好。然后走了。又回来了。"]);
    expect(result.sentences.map((s) => s.text)).toEqual(["他说：“好。", "然后走了。", "又回来了。"]);
    expect(result.degradedParagraphs).toEqual([0]);
  });

  it("正常配对的段落不降级，引号内部仍不切", () => {
    const result = segmentParagraphs(["“好。走吧。”他说。然后走了。"]);
    expect(result.sentences.map((s) => s.text)).toEqual(["“好。走吧。”他说。", "然后走了。"]);
    expect(result.degradedParagraphs).toEqual([]);
  });

  it("孤立的后引号（找不到前标点）不触发降级", () => {
    expect(degradedOf(["无济于事。”", "）甲。"])).toEqual([]);
  });

  it("降级只影响本段，下一段的配对照常保护", () => {
    const result = segmentParagraphs(["（甲。乙。", "“丙。丁。”戊。"]);
    expect(result.sentences.map((s) => [s.paraIndex, s.text])).toEqual([
      [0, "（甲。"],
      [0, "乙。"],
      [1, "“丙。丁。”戊。"],
    ]);
    expect(result.degradedParagraphs).toEqual([0]);
  });

  it("空白段落不参与降级判断，下标对应原段落", () => {
    expect(degradedOf(["", "“甲。乙。", "丙。"])).toEqual([1]);
  });

  it("降级段内 B2 也不再受那个孤立前引号限制", () => {
    const warn = spyWarn();
    const long = "“" + Array.from({ length: 4 }, () => chunk(100) + "，").join("") + "完。";
    const result = segmentParagraphs([long]);
    expect(result.degradedParagraphs).toEqual([0]);
    expect(result.sentences.length).toBeGreaterThan(1);
    for (const s of result.sentences) expect(s.charCount).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    expect(warn).not.toHaveBeenCalled();
  });
});

/* ---------------- 闭合标点并入 ---------------- */

describe("句末标点后紧跟的闭合标点并入前一句", () => {
  it.each(["”", "’", "』", "」", "》", "）", "］", '"', "'", "．"])(
    "无济于事。%s 不产生孤立残片",
    (closer) => {
      expect(texts([`无济于事。${closer}`])).toEqual([`无济于事。${closer}`]);
    },
  );

  it("多个闭合标点连续并入", () => {
    expect(texts(["完了。”）接着。"])).toEqual(["完了。”）", "接着。"]);
  });

  it("半角 ' 作撇号时不影响切分（不进成对标点的栈）", () => {
    expect(texts(["Marx's 序言。第二句。"])).toEqual(["Marx's 序言。", "第二句。"]);
    expect(degradedOf(["Marx's 序言。第二句。"])).toEqual([]);
  });
});

/* ---------------- 段落边界 · B5 · 输出字段 ---------------- */

describe("段落边界、B5 与输出字段", () => {
  it("段落边界强制断句，即使上一段没有句末标点", () => {
    expect(sentencesOf(["没有句号", "下一段。"]).map((s) => [s.index, s.paraIndex, s.text])).toEqual([
      [0, 0, "没有句号"],
      [1, 1, "下一段。"],
    ]);
  });

  it("空白段落不产生句子，paraIndex 仍对应原段落", () => {
    expect(sentencesOf(["", " 　\t", "甲。"]).map((s) => [s.index, s.paraIndex])).toEqual([[0, 2]]);
  });

  it("句末之后只剩空白时不产生空句", () => {
    expect(texts(["甲。  　"])).toEqual(["甲。"]);
  });

  it("文本原样保留（含段首全角空格），字数用 countChars 去空白", () => {
    const [s] = sentencesOf(["　　甲 乙。"]);
    expect(s.text).toBe("　　甲 乙。");
    expect(s.charCount).toBe(countChars("　　甲 乙。"));
    expect(s.charCount).toBe(3);
  });

  it("index 为全文顺序号，跨段连续", () => {
    expect(sentencesOf(["甲。乙。", "丙。"]).map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

/* ---------------- B2 超长句（合成用例） ---------------- */

describe("B2 超长句切分", () => {
  it("在句中标点处切，切完仍超长则继续切，直到每片 ≤250，不警告", () => {
    const warn = spyWarn();
    const long = Array.from({ length: 6 }, () => chunk(100) + "，").join("") + chunk(10) + "。";
    const out = texts([long]);
    expect(out.join("")).toBe(long);
    expect(out.map(countChars)).toEqual([202, 202, 213]);
    for (const s of out) expect(countChars(s)).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("250 字以内没有切点时，在超过 250 后的第一个句中标点处切；剩下的超长片留警告", () => {
    const warn = spyWarn();
    expect(texts([chunk(300) + "，" + chunk(20) + "。"]).map(countChars)).toEqual([301, 21]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("整句没有句中标点时不硬切，但留警告", () => {
    const warn = spyWarn();
    expect(texts([chunk(400) + "。"])).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("整句在成对标点内时不切，但必须 console.warn 留痕", () => {
    const warn = spyWarn();
    const long = "“" + Array.from({ length: 4 }, () => chunk(100) + "，").join("") + "”。";
    const result = segmentParagraphs([long]);
    expect(result.sentences).toHaveLength(1);
    expect(result.degradedParagraphs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(String(MAX_SENTENCE_CHARS));
    expect(warn.mock.calls[0][1]).toMatchObject({
      index: 0,
      paraIndex: 0,
      charCount: result.sentences[0].charCount,
    });
  });

  it("刚好 250 字不切", () => {
    expect(texts([chunk(120) + "，" + chunk(128) + "。"])).toHaveLength(1);
  });
});
