/**
 * 解析结果类型、异常码与提示文案、与格式无关的校验。
 *
 * docx / txt / 粘贴（G-02）与 pdf（G-02B）共用本文件：
 * 字数必须统一走 countChars()，异常提示统一走 noticeContent()。
 * 本文件不做任何网络请求——解析全部在浏览器内完成，原文不出浏览器。
 */

export type ParseFormat = "docx" | "txt" | "paste" | "pdf";

export interface ParsedHeading {
  /** 在 paragraphs 中的下标 */
  paraIndex: number;
  /** 1–6 */
  level: number;
  text: string;
}

export interface ParsedFootnote {
  marker: string;
  text: string;
}

export interface ParsedDocument {
  /** paragraphs.join("\n")，不含表格与脚注 */
  text: string;
  paragraphs: string[];
  /** 只记录标题所在段落的下标与层级，不改变 paragraphs */
  headings: ParsedHeading[];
  /** 单独归类，不计入 text / charCount，不参与切句 */
  footnotes: ParsedFootnote[];
  meta: {
    format: ParseFormat;
    fileName: string | null;
    charCount: number;
    /** 仅 PDF：原文件总页数（含被跳过的扫描页） */
    pageCount?: number;
  };
}

/** PRD 3.8 单文件大小上限 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** PRD 3.8 单文档字数上限（按 countChars 口径） */
export const MAX_CHARS = 50_000;

/** A9：汉字占非空白字符的比例低于此值时提示「针对中文优化」（不阻断） */
export const CJK_RATIO_THRESHOLD = 0.3;

export type FileFormat = "docx" | "txt" | "pdf";

const SUPPORTED_FILE_FORMATS: Record<string, FileFormat> = {
  ".docx": "docx",
  ".txt": "txt",
  ".pdf": "pdf",
};

/**
 * 字数口径（全项目唯一，G-02B 必须复用本函数）：
 * 去掉所有空白后的字符数，含标点；不含表格、不含脚注。
 *
 * - 空白 = 正则 \s：半角空格、制表符、换行（含软回车）、全角空格 U+3000、
 *   不间断空格 U+00A0、BOM U+FEFF 等。
 * - 按 Unicode 码点计数，扩展区汉字（UTF-16 代理对）算 1 个字。
 * - 表格在解析阶段已剔除；脚注在 footnotes 中，只统计 text。
 * - 对照 Word：「字数统计 → 字符数（不计空格）」，且不勾选「包括文本框、脚注和尾注」。
 */
export function countChars(text: string): number {
  return Array.from(text.replace(/\s/g, "")).length;
}

const HAN = new RegExp("\\p{Script=Han}", "gu");

/** 汉字占非空白字符的比例；无非空白字符时返回 0 */
export function cjkRatio(text: string): number {
  const total = countChars(text);
  if (total === 0) return 0;
  return (text.match(HAN)?.length ?? 0) / total;
}

/**
 * 空白归一化：删掉「汉字与汉字之间」的半角空格 / 制表符。
 * docx 提取常留下「性 状」「倾 向」这类词中空格，模型收到的是断开的词（G-06 评测发现）。
 *
 * - 只动两侧都是汉字的位置：中英文之间、数字之间、汉字与标点之间的空格不动。
 * - 全角空格 U+3000 不动（段首缩进、诗文间隔常用它），不间断空格 U+00A0 不动。
 * - 不影响字数：countChars 本来就不计空白。会改变 docId（按段落内容计算）。
 */
const HAN_GAP = new RegExp("(?<=\\p{Script=Han})[ \\t]+(?=\\p{Script=Han})", "gu");

export function normalizeWhitespace(paragraph: string): string {
  return paragraph.replace(HAN_GAP, "");
}

/** 由各格式解析器调用，统一做空白归一化并生成 text 与 charCount */
export function assembleDocument(
  parts: Pick<ParsedDocument, "paragraphs" | "headings" | "footnotes">,
  format: ParseFormat,
  fileName: string | null,
  pageCount?: number,
): ParsedDocument {
  const paragraphs = parts.paragraphs.map(normalizeWhitespace);
  const headings = parts.headings.map((h) => ({ ...h, text: normalizeWhitespace(h.text) }));
  const text = paragraphs.join("\n");
  const meta: ParsedDocument["meta"] = { format, fileName, charCount: countChars(text) };
  if (pageCount !== undefined) meta.pageCount = pageCount;
  return { text, paragraphs, headings, footnotes: parts.footnotes, meta };
}

/* ---------------- 异常码与提示文案（PRD 3.9 A 类） ---------------- */

/**
 * LOAD 不在 PRD 3.9：解析组件（按需加载的 mammoth / pdf.js，或 PDF 需要的 cMap 字符映射表）
 * 没能下载下来，通常是断网。与 A3「文件损坏」分开，避免让用户朝错误方向排查。
 * 完整的断网处理见 D1，不在 G-02 范围。
 *
 * GARBLED 不在 PRD 3.9：PDF 有文字层，但提取出来的字符大量无法识别（阈值见 lib/parse/pdf.ts）。
 * 与 A5「扫描件」分开：不是没有文字，而是文字读不出来，换一个版本的 PDF 可能就好了。
 */
export type BlockingCode = "A1" | "A2" | "A3" | "A4" | "A5" | "A7" | "A8" | "GARBLED" | "LOAD";
export type WarningCode = "A6" | "A9";
export type NoticeCode = BlockingCode | WarningCode;

export class ParseError extends Error {
  readonly code: BlockingCode;
  readonly charCount?: number;

  constructor(code: BlockingCode, charCount?: number) {
    super(`parse failed: ${code}`);
    this.name = "ParseError";
    this.code = code;
    this.charCount = charCount;
  }
}

export interface NoticeContent {
  code: NoticeCode;
  /** block：阻断，本次解析无结果；banner：仅提示，不阻断 */
  tone: "block" | "banner";
  message: string;
  /** 是否提供「改用粘贴文本」入口 */
  offerPaste: boolean;
}

/** [1,2,3,5,7,8] → 「1–3、5、7–8」 */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    ranges.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return ranges.join("、");
}

export interface NoticeDetail {
  /** A8 */
  charCount?: number;
  /** A6：被跳过的扫描页页码，从 1 起 */
  skippedPages?: number[];
}

export function noticeContent(code: NoticeCode, detail: NoticeDetail = {}): NoticeContent {
  const { charCount, skippedPages = [] } = detail;
  switch (code) {
    case "A1":
      return {
        code,
        tone: "block",
        message: "暂不支持这种文件格式。目前支持 .docx、.txt 和带文字层的 .pdf，也可以直接粘贴文本。",
        offerPaste: true,
      };
    case "A2":
      return {
        code,
        tone: "block",
        message: "文件超过 20 MB 上限。建议把书拆成几卷，分别上传。",
        offerPaste: false,
      };
    case "A3":
      return {
        code,
        tone: "block",
        message: "无法读取这个文件，它可能已损坏。可以复制正文，改用粘贴文本。",
        offerPaste: true,
      };
    case "A4":
      return {
        code,
        tone: "block",
        message: "这份 PDF 设置了打开密码，Gloss 读不了。请先在 PDF 阅读器里解除密码，另存一份再上传。",
        offerPaste: false,
      };
    case "A5":
      return {
        code,
        tone: "block",
        message:
          "这份 PDF 看起来是扫描件：页面是图片，没有可以读取的文字，Gloss 目前处理不了。" +
          "扫描件的文字识别计划在 v2 支持。现在可以找这本书的文字版，或者复制正文改用粘贴文本。",
        offerPaste: true,
      };
    case "A6":
      return {
        code,
        tone: "banner",
        message: `第 ${formatPageRanges(skippedPages)} 页为扫描页，已跳过。其余页面已正常读取。`,
        offerPaste: false,
      };
    case "GARBLED":
      return {
        code,
        tone: "block",
        message:
          "这份 PDF 的文字读不出来：提取出来的大多是无法识别的字符。换一个版本的 PDF 试试，或者复制正文改用粘贴文本。",
        offerPaste: true,
      };
    case "A7":
      return { code, tone: "block", message: "未检测到文本内容。", offerPaste: false };
    case "A8":
      return {
        code,
        tone: "block",
        message: `全文${charCount === undefined ? "" : ` ${charCount.toLocaleString("zh-CN")} 字，`}超过 ${MAX_CHARS.toLocaleString("zh-CN")} 字上限。请分卷上传。`,
        offerPaste: false,
      };
    case "LOAD":
      return {
        code,
        tone: "block",
        message: "解析组件加载失败，请检查网络后重试",
        offerPaste: false,
      };
    case "A9":
      return {
        code,
        tone: "banner",
        message: "这份文本主要不是中文。Gloss 针对中文优化，其他语言的效果可能不理想。",
        offerPaste: false,
      };
  }
}

/* ---------------- 校验 ---------------- */

/** 读文件前的校验：A1 格式 → A2 大小 → A7 空文件。返回解析器类型。 */
export function checkFile(file: File): FileFormat {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  const format = SUPPORTED_FILE_FORMATS[ext];
  if (!format) throw new ParseError("A1");
  if (file.size > MAX_FILE_BYTES) throw new ParseError("A2");
  if (file.size === 0) throw new ParseError("A7");
  return format;
}

/** 解析后的校验：A7 无文本、A8 超字数（阻断，抛出）；A9 非中文（不阻断，返回）。 */
export function checkParsed(doc: ParsedDocument): WarningCode[] {
  const { charCount } = doc.meta;
  if (charCount === 0) throw new ParseError("A7");
  if (charCount > MAX_CHARS) throw new ParseError("A8", charCount);
  return cjkRatio(doc.text) < CJK_RATIO_THRESHOLD ? ["A9"] : [];
}
