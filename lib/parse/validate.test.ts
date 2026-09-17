import { describe, expect, it } from "vitest";
import {
  ParseError,
  assembleDocument,
  checkFile,
  formatPageRanges,
  noticeContent,
  normalizeWhitespace,
  skippedSummary,
} from "./validate";

describe("空白归一化", () => {
  it("删掉汉字之间的半角空格和制表符", () => {
    expect(normalizeWhitespace("性 状与倾\t向，政 治  经 济 学")).toBe("性状与倾向，政治经济学");
  });

  it("中英文之间、数字之间、汉字与标点之间的空格不动", () => {
    expect(normalizeWhitespace("读 Hegel 的书 1859 年 12 月")).toBe("读 Hegel 的书 1859 年 12 月");
    expect(normalizeWhitespace("他说 ，我 “不”")).toBe("他说 ，我 “不”");
  });

  it("全角空格、不间断空格、换行不动", () => {
    expect(normalizeWhitespace("　　段首　缩进")).toBe("　　段首　缩进");
    expect(normalizeWhitespace("甲 乙")).toBe("甲 乙");
    expect(normalizeWhitespace("甲\n乙")).toBe("甲\n乙");
  });

  it("assembleDocument 对段落和标题都做归一化，字数不变", () => {
    const doc = assembleDocument(
      { paragraphs: ["序 言", "性 状"], headings: [{ paraIndex: 0, level: 1, text: "序 言" }], footnotes: [] },
      "docx",
      "a.docx",
    );
    expect(doc.paragraphs).toEqual(["序言", "性状"]);
    expect(doc.headings[0].text).toBe("序言");
    expect(doc.text).toBe("序言\n性状");
    expect(doc.meta).toEqual({ format: "docx", fileName: "a.docx", charCount: 4 });
  });

  it("PDF 带页数", () => {
    const doc = assembleDocument({ paragraphs: ["甲"], headings: [], footnotes: [] }, "pdf", "a.pdf", 3);
    expect(doc.meta.pageCount).toBe(3);
  });
});

describe("文件校验", () => {
  const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);

  it("接受 .pdf（大小写不敏感）", () => {
    expect(checkFile(file("书.PDF"))).toBe("pdf");
    expect(checkFile(file("书.pdf"))).toBe("pdf");
  });

  it("其他格式仍是 A1，A1 文案列出 PDF", () => {
    expect(() => checkFile(file("书.epub"))).toThrow(ParseError);
    expect(noticeContent("A1").message).toContain(".pdf");
  });
});

describe("PDF 提示文案", () => {
  it("A5 明确含「扫描件」、原因与 v2 计划，阻断并提供粘贴入口", () => {
    const n = noticeContent("A5");
    expect(n.tone).toBe("block");
    expect(n.message).toContain("扫描件");
    expect(n.message).toContain("图片");
    expect(n.message).toContain("v2");
    expect(n.offerPaste).toBe(true);
  });

  it("A6 是横幅，列出被跳过的页码区间", () => {
    const n = noticeContent("A6", { skippedPages: [3, 1, 2, 7] });
    expect(n.tone).toBe("banner");
    expect(n.message).toContain("第 1–3、7 页为扫描页，已跳过");
  });

  it("A4 提示需先解除密码", () => {
    expect(noticeContent("A4").message).toContain("解除密码");
  });

  it("乱码与扫描件文案分开", () => {
    const n = noticeContent("GARBLED");
    expect(n.tone).toBe("block");
    expect(n.message).toContain("文字读不出来");
    expect(n.message).toContain("换一个版本");
    expect(n.message).not.toContain("扫描件");
  });

  it("A8 仍带字数", () => {
    expect(noticeContent("A8", { charCount: 60000 }).message).toContain("60,000");
  });
});

describe("页码区间", () => {
  it("合并连续页、去重、排序", () => {
    expect(formatPageRanges([8, 1, 2, 3, 5, 7, 3])).toBe("1–3、5、7–8");
    expect(formatPageRanges([4])).toBe("4");
  });
});

describe("左栏「已跳过」一行（G-25）", () => {
  it("没有跳过任何东西 → null", () => {
    expect(skippedSummary(undefined)).toBeNull();
    expect(skippedSummary({})).toBeNull();
    expect(skippedSummary({ tableCount: 0, hasFormula: false, scannedPages: [] })).toBeNull();
  });

  it("docx：表格与公式", () => {
    expect(skippedSummary({ tableCount: 1, tableChars: 62 })).toBe("已跳过：表格 1 处（62 字）");
    expect(skippedSummary({ hasFormula: true })).toBe("已跳过：公式");
    expect(skippedSummary({ tableCount: 1, tableChars: 102, hasFormula: true })).toBe(
      "已跳过：表格 1 处（102 字）、公式",
    );
  });

  it("PDF：扫描页按区间合并", () => {
    expect(skippedSummary({ scannedPages: [2] })).toBe("已跳过：第 2 页（扫描页）");
    expect(skippedSummary({ scannedPages: [3, 1, 2, 7] })).toBe("已跳过：第 1–3、7 页（扫描页）");
  });

  it("字数用千分位", () => {
    expect(skippedSummary({ tableCount: 2, tableChars: 12345 })).toContain("12,345 字");
  });
});
