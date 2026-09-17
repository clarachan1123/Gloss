// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDocx } from "./docx";
import { noticeContent } from "./validate";

// Node 版 mammoth 只收 { buffer }，浏览器版才收 { arrayBuffer }：测试里转一下，docx.ts 不动
vi.mock("mammoth", async (importOriginal) => {
  const actual = ((await importOriginal()) as { default: typeof import("mammoth") }).default;
  type Input = Parameters<typeof actual.convertToHtml>[0];
  const toBuffer = (input: Input) =>
    "arrayBuffer" in input ? { buffer: Buffer.from(input.arrayBuffer as ArrayBuffer) } : input;
  const wrapped = {
    ...actual,
    convertToHtml: (input: Input, options?: Parameters<typeof actual.convertToHtml>[1]) =>
      actual.convertToHtml(toBuffer(input), options),
  };
  return { default: wrapped };
});

const FIXTURES = path.resolve(__dirname, "../../test-fixtures");
const fixture = (name: string) => path.join(FIXTURES, name);
const has = (...names: string[]) => names.every((n) => existsSync(fixture(n)));
const parse = (name: string) => parseDocx(new File([readFileSync(fixture(name))], name));

/** 不依赖样本：直接喂 mammoth 转出来的那种 HTML */
async function parseHtml(html: string, messages: { type: string; message: string }[] = []) {
  const mammoth = (await import("mammoth")).default as unknown as {
    convertToHtml: (...args: unknown[]) => Promise<{ value: string; messages: unknown[] }>;
  };
  const spy = vi.spyOn(mammoth, "convertToHtml").mockResolvedValue({ value: html, messages });
  try {
    return await parseDocx(new File([new Uint8Array(1)], "构造.docx"));
  } finally {
    spy.mockRestore();
  }
}

const OMML_MESSAGE = {
  type: "warning",
  message:
    "An unrecognised element was ignored: {http://schemas.openxmlformats.org/officeDocument/2006/math}oMathPara",
};

describe.skipIf(!has("docx-table-formula.docx", "政治经济学批判-序言.docx"))("样本", () => {
  it("含表格和公式：A10，表格 1 处 102 字，公式检测到", async () => {
    const { doc, warnings, detail } = await parse("docx-table-formula.docx");
    expect(warnings).toEqual(["A10"]);
    expect(detail).toEqual({ tableCount: 1, tableChars: 102, hasFormula: true });
    expect(doc.meta.charCount).toBe(1234);
    expect(doc.paragraphs.length).toBe(8);
    // 表格里的字确实没进正文
    expect(doc.text).not.toContain("意识流型");
  });

  it("只有排版用表格（1 行 1 单元格）：照样计入，62 字", async () => {
    const { doc, warnings, detail } = await parse("政治经济学批判-序言.docx");
    expect(warnings).toEqual(["A10"]);
    expect(detail).toEqual({ tableCount: 1, tableChars: 62, hasFormula: false });
    expect(doc.text).not.toContain("原文是德文");
    // 基线不变
    expect(doc.meta.charCount).toBe(3037);
    expect(doc.paragraphs.length).toBe(15);
  });
});

describe("表格计数口径", () => {
  it("不含表格和公式的文档不出提示", async () => {
    const { warnings, detail } = await parseHtml("<p>正文一</p><p>正文二</p>");
    expect(warnings).toEqual([]);
    expect(detail).toEqual({ tableCount: 0, tableChars: 0, hasFormula: false });
  });

  it("嵌套表格只算最外层一处，字数含内层", async () => {
    const { warnings, detail } = await parseHtml(
      "<p>正文</p><table><tr><td>外层<table><tr><td>内层</td></tr></table></td></tr></table>",
    );
    expect(warnings).toEqual(["A10"]);
    expect(detail.tableCount).toBe(1);
    expect(detail.tableChars).toBe(4);
  });

  it("并列的两个表格算两处", async () => {
    const { detail } = await parseHtml(
      "<table><tr><td>甲一</td></tr></table><p>正文</p><table><tr><td>乙</td></tr></table>",
    );
    expect(detail.tableCount).toBe(2);
    expect(detail.tableChars).toBe(3);
  });

  it("表格字数与全项目字数口径一致：不计空白", async () => {
    const { detail } = await parseHtml("<table><tr><td>甲 乙\n丙</td></tr></table>");
    expect(detail.tableChars).toBe(3);
  });
});

describe("公式检测", () => {
  it("mammoth 报出 math 命名空间的警告 → hasFormula", async () => {
    const { warnings, detail } = await parseHtml("<p>正文</p>", [OMML_MESSAGE]);
    expect(warnings).toEqual(["A10"]);
    expect(detail.hasFormula).toBe(true);
  });

  it("行内公式（oMath）同样命中", async () => {
    const inline = {
      type: "warning",
      message:
        "An unrecognised element was ignored: {http://schemas.openxmlformats.org/officeDocument/2006/math}oMath",
    };
    expect((await parseHtml("<p>正文</p>", [inline])).detail.hasFormula).toBe(true);
  });

  it("其他警告不误判成公式", async () => {
    const others = [
      { type: "warning", message: "An unrecognised element was ignored: w:tblPrEx" },
      { type: "warning", message: "Unrecognised paragraph style: 'Normal (Web)' (Style ID: 3)" },
    ];
    expect((await parseHtml("<p>正文</p>", others)).detail.hasFormula).toBe(false);
  });
});

describe("A10 提示文案", () => {
  it("只有表格", () => {
    const n = noticeContent("A10", { tableCount: 1, tableChars: 102, hasFormula: false });
    expect(n.tone).toBe("banner");
    expect(n.offerPaste).toBe(false);
    expect(n.message).toBe("这份文档里有 1 处表格，其中的 102 字已跳过，不影响正文阅读。");
  });

  it("只有公式", () => {
    expect(noticeContent("A10", { hasFormula: true }).message).toBe(
      "这份文档里有公式，已跳过，不影响正文阅读。",
    );
  });

  it("两者都有", () => {
    expect(noticeContent("A10", { tableCount: 1, tableChars: 102, hasFormula: true }).message).toBe(
      "这份文档里有 1 处表格（102 字）和公式，都已跳过，不影响正文阅读。",
    );
  });

  it("字数用千分位", () => {
    expect(noticeContent("A10", { tableCount: 3, tableChars: 12345 }).message).toContain("12,345 字");
  });
});
