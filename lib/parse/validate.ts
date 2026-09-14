/**
 * 解析结果类型、异常码与提示文案、与格式无关的校验。
 *
 * docx / txt / 粘贴（G-02）与 pdf（G-02B）共用本文件：
 * 字数必须统一走 countChars()，异常提示统一走 noticeContent()。
 * 本文件不做任何网络请求——解析全部在浏览器内完成，原文不出浏览器。
 */

export type ParseFormat = "docx" | "txt" | "paste";

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
  };
}

/** PRD 3.8 单文件大小上限 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** PRD 3.8 单文档字数上限（按 countChars 口径） */
export const MAX_CHARS = 50_000;

/** A9：汉字占非空白字符的比例低于此值时提示「针对中文优化」（不阻断） */
export const CJK_RATIO_THRESHOLD = 0.3;

const SUPPORTED_FILE_FORMATS: Record<string, "docx" | "txt"> = {
  ".docx": "docx",
  ".txt": "txt",
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

/** 由各格式解析器调用，统一生成 text 与 charCount */
export function assembleDocument(
  parts: Pick<ParsedDocument, "paragraphs" | "headings" | "footnotes">,
  format: ParseFormat,
  fileName: string | null,
): ParsedDocument {
  const text = parts.paragraphs.join("\n");
  return {
    text,
    paragraphs: parts.paragraphs,
    headings: parts.headings,
    footnotes: parts.footnotes,
    meta: { format, fileName, charCount: countChars(text) },
  };
}

/* ---------------- 异常码与提示文案（PRD 3.9 A 类） ---------------- */

/**
 * LOAD 不在 PRD 3.9：解析组件（按需加载的 mammoth）没能下载下来，通常是断网。
 * 与 A3「文件损坏」分开，避免让用户朝错误方向排查。完整的断网处理见 D1，不在 G-02 范围。
 */
export type BlockingCode = "A1" | "A2" | "A3" | "A7" | "A8" | "LOAD";
export type WarningCode = "A9";
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

export function noticeContent(code: NoticeCode, charCount?: number): NoticeContent {
  switch (code) {
    case "A1":
      return {
        code,
        tone: "block",
        message: "暂不支持这种文件格式。目前支持 .docx 和 .txt，也可以直接粘贴文本。",
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
export function checkFile(file: File): "docx" | "txt" {
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
