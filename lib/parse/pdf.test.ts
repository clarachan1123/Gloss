// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseDocx } from "./docx";
import {
  buildPdfDocument,
  garbledRatio,
  linesToParagraphs,
  readPdfPages,
  stripPageEdges,
  type PdfLine,
  type PdfPageData,
} from "./pdf";
import { ParseError, type ParsedDocument } from "./validate";
import { segmentParagraphs } from "../segment";
// @ts-expect-error 纯 JS 构建脚本，没有类型声明
import { assetDir } from "../../scripts/copy-pdfjs-assets.mjs";

const ROOT = path.resolve(__dirname, "../..");
const FIXTURES = path.join(ROOT, "test-fixtures");
const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));
/** Node 下 pdf.js 用 fs 读 cMap，要本地路径，以 / 结尾 */
const CMAP_DIR = path.join(PDFJS_DIR, "cmaps").split(path.sep).join("/") + "/";

const fixture = (name: string) => path.join(FIXTURES, name);
const has = (...names: string[]) => names.every((n) => existsSync(fixture(n)));
const strip = (s: string) => s.replace(/\s/g, "");

async function parseFixture(name: string, params: Record<string, unknown> = { cMapUrl: CMAP_DIR, cMapPacked: true }) {
  const data = new Uint8Array(readFileSync(fixture(name)));
  const pages = await readPdfPages(pdfjs, { data, ...params });
  return buildPdfDocument(pages, name);
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (err) {
    return err instanceof ParseError ? err.code : `unexpected ${(err as Error)?.name}`;
  }
}

async function docxFixture(): Promise<ParsedDocument> {
  const buf = readFileSync(fixture("政治经济学批判-序言.docx"));
  // G-24 起 parseDocx 返回 { doc, warnings, detail }
  return (await parseDocx(new File([buf], "序言.docx"))).doc;
}

/** docx 里全部可见文字（含被 A10 剔除的表格），按文档顺序 */
async function docxAllText(): Promise<{ all: string; tables: string }> {
  const { default: mammoth } = await import("mammoth");
  const { value } = await mammoth.convertToHtml({ buffer: readFileSync(fixture("政治经济学批判-序言.docx")) });
  const body = new DOMParser().parseFromString(`<body>${value}</body>`, "text/html").body;
  const tables = Array.from(body.querySelectorAll("table"), (t) => t.textContent ?? "").join("");
  return { all: body.textContent ?? "", tables };
}

describe("pdf.js 资源版本", () => {
  it("package.json 锁定的版本、已安装的版本、模块报告的版本、cMap 目录三者一致", () => {
    const pinned = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies["pdfjs-dist"];
    const installed = JSON.parse(readFileSync(path.join(PDFJS_DIR, "package.json"), "utf8")).version;
    expect(pinned).toBe(installed);
    expect(pdfjs.version).toBe(installed);
    // pdf.ts 按 /pdfjs/<pdfjs.version>/cmaps/ 取文件，复制脚本必须写到同一个目录
    expect(assetDir(ROOT, installed).split(path.sep).join("/")).toBe(
      `${ROOT.split(path.sep).join("/")}/public/pdfjs/${pdfjs.version}/cmaps`,
    );
  });
});

describe.skipIf(!has("pdf-text.pdf", "政治经济学批判-序言.docx"))("样本：文字层 PDF", () => {
  it("pdf-text.pdf 与 docx 全部可见文字（含表格）去空白后逐字一致", async () => {
    const { doc, warnings } = await parseFixture("pdf-text.pdf");
    const docx = await docxFixture();
    const { all, tables } = await docxAllText();
    expect(warnings).toEqual([]);
    expect(doc.meta.pageCount).toBe(6);
    expect(strip(doc.text)).toBe(strip(all));
    // 分段也与 docx 一致：前 15 段逐段相同，其后是表格里的行
    expect(doc.paragraphs.slice(0, docx.paragraphs.length).map(strip)).toEqual(docx.paragraphs.map(strip));
    // docx 路径按 A10 剔除表格，少掉的正好是表格里的字
    expect(doc.meta.charCount).toBe(docx.meta.charCount + strip(tables).length);
  });

  it("docx 基线不变：3037 字 / 15 段 / 61 句", async () => {
    const docx = await docxFixture();
    expect(docx.meta.charCount).toBe(3037);
    expect(docx.paragraphs.length).toBe(15);
    expect(segmentParagraphs(docx.paragraphs).sentences.length).toBe(61);
  });
});

describe.skipIf(!has("pdf-header.pdf", "pdf-text.pdf"))("样本：页眉页码", () => {
  it("pdf-header.pdf 去掉页眉页码后与 pdf-text.pdf 逐字一致", async () => {
    const a = await parseFixture("pdf-header.pdf");
    const b = await parseFixture("pdf-text.pdf");
    expect(strip(a.doc.text)).toBe(strip(b.doc.text));
  });
});

describe.skipIf(!has("pdf-encrypted.pdf"))("样本：加密", () => {
  it("需要打开密码 → A4", async () => {
    expect(await codeOf(parseFixture("pdf-encrypted.pdf"))).toBe("A4");
  });
  it("错误密码同样 → A4", async () => {
    expect(await codeOf(parseFixture("pdf-encrypted.pdf", { password: "000000" }))).toBe("A4");
  });
});

describe.skipIf(!has("pdf-scan.pdf", "pdf-mixed.pdf", "pdf-real.pdf"))("样本：扫描件", () => {
  it("全部页是扫描页 → A5", async () => {
    expect(await codeOf(parseFixture("pdf-scan.pdf"))).toBe("A5");
  });

  it("部分页是扫描页 → A6，跳过这些页", async () => {
    const { doc, warnings, skippedPages } = await parseFixture("pdf-mixed.pdf");
    expect(warnings).toEqual(["A6"]);
    expect(skippedPages).toEqual([2]);
    expect(doc.meta.charCount).toBe(234);
    expect(doc.meta.pageCount).toBe(2);
  });

  it("双层 PDF（扫描图 + 文字层）不误判", async () => {
    const { doc, warnings } = await parseFixture("pdf-real.pdf");
    expect(warnings).toEqual([]);
    expect(doc.meta.charCount).toBeGreaterThan(8000);
  });

  it("缺 cMap 时文字全丢 → 兜底判为 A5，不显示乱码", async () => {
    expect(await codeOf(parseFixture("pdf-real.pdf", {}))).toBe("A5");
  });
});

/* ---------------- 构造数据 ---------------- */

const SIZE = 10;
const RIGHT = 500;
/** 构造一行：indent 为缩进字数，short 为行末提前的字数 */
const line = (text: string, y: number, { indent = 0, short = 0, size = SIZE } = {}): PdfLine => ({
  text,
  x: 100 + indent * size,
  right: RIGHT - short * size,
  y,
  size,
});
const page = (lines: PdfLine[], imageCoverage = 0): PdfPageData => ({
  lines,
  charCount: lines.reduce((n, l) => n + strip(l.text).length, 0),
  imageCoverage,
});
/** 一页正文：满行若干 + 可选的末行 */
const bodyPage = (texts: string[], opts: { lastShort?: boolean; firstIndent?: boolean } = {}) =>
  texts.map((t, i) =>
    line(t, 700 - i * 15, {
      indent: i === 0 && opts.firstIndent ? 2 : 0,
      short: i === texts.length - 1 && opts.lastShort ? 5 : 0,
    }),
  );
const LONG = "正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文";

describe("扫描页判定与兜底", () => {
  const textPage = page(bodyPage([LONG, LONG, LONG]));
  const scanPage = page([line("12", 50)], 0.5);

  it("字少且有大图才算扫描页；字少但图小不算", () => {
    const { skippedPages } = buildPdfDocument([textPage, scanPage, page([line("短", 700)], 0.29)], null);
    expect(skippedPages).toEqual([2]);
  });

  it("有任何一页是扫描页就走 A6，不触发平均字数兜底", () => {
    const tiny = page([line("一二三", 700)]);
    const result = buildPdfDocument([tiny, scanPage, tiny], null);
    expect(result.warnings).toEqual(["A6"]);
  });

  it("没有扫描页、平均每页少于 20 字 → A5（含 0 字无图）", async () => {
    expect(await codeOf(Promise.resolve().then(() => buildPdfDocument([page([]), page([])], null)))).toBe("A5");
    const nineteen = page([line("一二三四五六七八九十一二三四五六七八九", 700)]);
    expect(await codeOf(Promise.resolve().then(() => buildPdfDocument([nineteen], null)))).toBe("A5");
    const twenty = page([line("一二三四五六七八九十一二三四五六七八九十", 700)]);
    expect(await codeOf(Promise.resolve().then(() => buildPdfDocument([twenty], null)))).toBe("ok");
  });

  it("乱码超过 5% → GARBLED", async () => {
    const bad = "".repeat(6) + "字".repeat(94);
    expect(garbledRatio(bad)).toBeCloseTo(0.06);
    expect(await codeOf(Promise.resolve().then(() => buildPdfDocument([page([line(bad, 700)])], null)))).toBe(
      "GARBLED",
    );
    const ok = "�".repeat(5) + "字".repeat(95);
    expect(await codeOf(Promise.resolve().then(() => buildPdfDocument([page([line(ok, 700)])], null)))).toBe("ok");
  });
});

describe("页眉页脚", () => {
  const withEdges = (n: number, header: string, footer: string) =>
    page([line(header, 780, { indent: 10, short: 10 }), ...bodyPage([`${LONG}${n}`, LONG]), line(footer, 40, { indent: 20, short: 20 })]);

  it("≥3 页重复的首行去掉，奇偶页页眉分别计数；纯数字页码去掉", () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => withEdges(n, n % 2 ? "政治经济学批判" : "序言", String(n)));
    const out = stripPageEdges(pages);
    for (const lines of out) expect(lines!.map((l) => l.text)).toEqual([expect.stringMatching(/^正文/), LONG]);
  });

  it("只出现 2 次的首行不去；非纯数字的末行不去", () => {
    const pages = [1, 2, 3].map((n) => withEdges(n, n < 3 ? "只有两页" : "别的", `附注${"甲乙丙"[n - 1]}`));
    const out = stripPageEdges(pages);
    expect(out[0]![0].text).toBe("只有两页");
    expect(out[0]!.at(-1)!.text).toBe("附注甲");
  });

  it("带页码的页脚：数字统一后重复 ≥3 页，去掉", () => {
    const pages = [1, 2, 3].map((n) => withEdges(n, "x", `第${n}页`));
    for (const lines of stripPageEdges(pages)) expect(lines!.at(-1)!.text).toBe(LONG);
  });

  it("页码数字不同的页眉算同一行，含 OCR 认错的页码", () => {
    const pages = [1, 2, 3].map((n) => withEdges(n, `序言 ${n}`, "x"));
    for (const lines of stripPageEdges(pages)) expect(lines![0].text).not.toMatch(/序言/);
    const ocr = ["导论z", "导论9", "19导论"].map((h, i) => withEdges(i, h, "x"));
    for (const lines of stripPageEdges(ocr)) expect(lines![0].text).not.toMatch(/导论/);
  });

  it("章首页的大标题与页眉同名，但位置低得多，不去掉", () => {
    const pages = [1, 2, 3, 4].map((n) => withEdges(n, n === 1 ? "导论" : `导论${n}`, "x"));
    pages[0].lines[0] = { ...pages[0].lines[0], y: 700, size: 24 };
    pages[0].lines.slice(1, -1).forEach((l, i) => (pages[0].lines[i + 1] = { ...l, y: 650 - i * 15 }));
    const out = stripPageEdges(pages);
    expect(out[0]![0].text).toBe("导论");
    for (const lines of out.slice(1)) expect(lines![0].text).not.toMatch(/导论/);
  });

  it("整行英文的首行不会因为「剥掉字母数字后相同」而被去掉", () => {
    const pages = [1, 2, 3].map((n) => withEdges(n, ["the first", "another line", "third one"][n - 1], "x"));
    expect(stripPageEdges(pages).map((lines) => lines![0].text)).toEqual(["the first", "another line", "third one"]);
  });

  it("按纵坐标找首末行，不按内容顺序", () => {
    const pages = [1, 2, 3].map((n) => {
      const p = withEdges(n, "页眉", String(n));
      return { ...p, lines: [...p.lines.slice(1), p.lines[0]] };
    });
    for (const lines of stripPageEdges(pages)) expect(lines!.map((l) => l.text)).not.toContain("页眉");
  });

  it("只看首末各一行：正文中间的纯数字行不动", () => {
    const pages = [page([line("一", 700), line("1859", 685), line("二", 670)])];
    expect(stripPageEdges(pages)[0]!.map((l) => l.text)).toEqual(["一", "1859", "二"]);
  });
});

describe("行拼段落", () => {
  it("写满的行接上，段末短行之后分段，缩进行开始新段", () => {
    const lines = [
      line("第一段第一行", 700, { indent: 2 }),
      line("第一段末行", 685, { short: 5 }),
      line("第二段第一行", 670, { indent: 2 }),
      line("第二段第二行", 655),
    ];
    expect(linesToParagraphs([lines])).toEqual(["第一段第一行第一段末行", "第二段第一行第二段第二行"]);
  });

  it("跨页：上页末行写满、下页首行无缩进 → 接上", () => {
    const p1 = bodyPage(["甲一", "甲二", "甲三"], { firstIndent: true });
    const p2 = bodyPage(["甲四", "甲五"], { lastShort: true });
    expect(linesToParagraphs([p1, p2])).toEqual(["甲一甲二甲三甲四甲五"]);
  });

  it("跨页：上页末行没写满 → 分段；下页首行缩进 → 分段", () => {
    const p1 = bodyPage(["甲一", "甲二", "甲三"], { lastShort: true });
    const p2 = bodyPage(["乙一", "乙二", "乙三"]);
    expect(linesToParagraphs([p1, p2])).toEqual(["甲一甲二甲三", "乙一乙二乙三"]);
    const p3 = bodyPage(["甲一", "甲二", "甲三"]);
    const p4 = bodyPage(["乙一", "乙二", "乙三"], { firstIndent: true });
    expect(linesToParagraphs([p3, p4])).toEqual(["甲一甲二甲三", "乙一乙二乙三"]);
  });

  it("扫描页打断段落", () => {
    const p1 = bodyPage(["甲一", "甲二", "甲三"]);
    const p3 = bodyPage(["乙一", "乙二", "乙三"]);
    expect(linesToParagraphs([p1, null, p3])).toEqual(["甲一甲二甲三", "乙一乙二乙三"]);
  });

  it("行距明显变大 → 分段；居中短标题自成一段", () => {
    const gap = [line("甲一", 700), line("甲二", 685), line("乙一", 640), line("乙二", 625)];
    expect(linesToParagraphs([gap])).toEqual(["甲一甲二", "乙一乙二"]);
    const title = [line("标题", 700, { indent: 15, short: 15 }), line("正文一", 685), line("正文二", 670)];
    expect(linesToParagraphs([title])).toEqual(["标题", "正文一正文二"]);
  });

  it("字号乱跳（OCR 文字层）不分段", () => {
    const noisy = [line("甲一", 700, { size: 13 }), line("甲二", 685, { size: 18.7 }), line("甲三", 670, { size: 10 })];
    expect(linesToParagraphs([noisy])).toEqual(["甲一甲二甲三"]);
  });

  it("英文或数字跨行补空格，中文不补", () => {
    const lines = [line("see the", 700), line("book 1859", 685), line("年出版", 670)];
    expect(linesToParagraphs([lines])).toEqual(["see the book 1859年出版"]);
  });
});
