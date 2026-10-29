import type { MemoryGloss } from "@/lib/cache";
import { MAX_AFTER } from "@/lib/context";
import { MAX_BEFORE } from "@/lib/context";
import { MAX_EXPLAIN_CONTEXT_CHARS } from "@/lib/context";
import type { ExplainInput } from "@/lib/explain-client";
import { countChars } from "@/lib/parse/validate";
import type { SkippedContent } from "@/lib/parse/validate";
import { TERM_CLOSE } from "@/lib/prompts/gloss";
import { TERM_OPEN } from "@/lib/prompts/gloss";
import type { Sentence as SentenceData } from "@/lib/segment";
import type { SavedGloss } from "@/lib/storage";
import type { StoredDocument } from "@/lib/storage";
import type { GlossView } from "./GlossPanel";
import type { GlossShape, ReadingMode } from "./readerTypes";
export const GLOSS_SHAPE_KEY = "gloss:settings:gloss-shape";
export const READING_MODE_KEY = "gloss:settings:reading-mode";

export function readGlossShape(): GlossShape {
  try {
    return globalThis.localStorage?.getItem(GLOSS_SHAPE_KEY) === "bubble" ? "bubble" : "inline";
  } catch {
    return "inline";
  }
}

export function readReadingMode(): ReadingMode {
  try {
    const value = globalThis.localStorage?.getItem(READING_MODE_KEY);
    return value === "reading" || value === "review" ? value : "review";
  } catch {
    return "review";
  }
}

/** 取消保存后保留正在看的版本，仅供本会话再次打开命中；绝不写入 IndexedDB。 */
export function retainGlossAfterUnsave(
  memory: Map<number, MemoryGloss>,
  index: number,
  view: GlossView,
  hasStructure: boolean,
): void {
  if (!memory.has(index) && view.status === "done") {
    memory.set(index, { text: view.text, hasStructure, source: "session", shown: true });
  }
}

export function countCompleteSentences(text: string): number {
  return [...text].filter((char) => char === "。" || char === "！" || char === "？").length;
}

/** 本地 JSON 可能缺字段；只把可读正文和有效的展示字段交给阅读器。 */
export function prepareReadableDocument(doc: StoredDocument): { doc: StoredDocument; headingsAvailable: boolean } | null {
  if (!Array.isArray(doc.paragraphs) ||
      !doc.paragraphs.every((paragraph) => typeof paragraph === "string") ||
      !doc.paragraphs.some((paragraph) => paragraph.trim().length > 0)) return null;

  const rawMeta: Record<string, unknown> = doc.meta && typeof doc.meta === "object" && !Array.isArray(doc.meta)
    ? doc.meta as unknown as Record<string, unknown>
    : {};
  const rawSkipped = rawMeta.skipped;
  const skipped: SkippedContent = {};
  if (rawSkipped && typeof rawSkipped === "object" && !Array.isArray(rawSkipped)) {
    const fields = rawSkipped as Record<string, unknown>;
    if (typeof fields.tableCount === "number" && Number.isFinite(fields.tableCount) &&
        typeof fields.tableChars === "number" && Number.isFinite(fields.tableChars)) {
      skipped.tableCount = fields.tableCount;
      skipped.tableChars = fields.tableChars;
    }
    if (typeof fields.hasFormula === "boolean") skipped.hasFormula = fields.hasFormula;
    if (Array.isArray(fields.scannedPages) && fields.scannedPages.every((page) => typeof page === "number" && Number.isInteger(page))) {
      skipped.scannedPages = fields.scannedPages;
    }
  }
  const meta = {
    format: rawMeta.format,
    fileName: typeof rawMeta.fileName === "string" && rawMeta.fileName.trim().length > 0 ? rawMeta.fileName : null,
    ...(typeof rawMeta.charCount === "number" && Number.isFinite(rawMeta.charCount) ? { charCount: rawMeta.charCount } : {}),
    ...(typeof rawMeta.pageCount === "number" && Number.isFinite(rawMeta.pageCount) ? { pageCount: rawMeta.pageCount } : {}),
    ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
  } as StoredDocument["meta"];
  const headingsAvailable = Array.isArray(doc.headings);
  return {
    doc: { ...doc, meta, headings: headingsAvailable ? doc.headings : [], footnotes: Array.isArray(doc.footnotes) ? doc.footnotes : [] },
    headingsAvailable,
  };
}

/** 左栏第二行：有效字数 · 段数 · 有效页数 · 句数。数字口径与上传页一致 */
export function documentStats(doc: StoredDocument, sentenceCount: number): string {
  const n = (value: number) => value.toLocaleString("zh-CN");
  const parts: string[] = [];
  if (typeof doc.meta?.charCount === "number" && Number.isFinite(doc.meta.charCount)) parts.push(`${n(doc.meta.charCount)} 字`);
  parts.push(`${n(doc.paragraphs.length)} 段`);
  if (typeof doc.meta?.pageCount === "number" && Number.isFinite(doc.meta.pageCount)) parts.push(`${n(doc.meta.pageCount)} 页`);
  parts.push(`${n(sentenceCount)} 句`);
  return parts.join(" · ");
}

/** 功能一的上下文窗口：目标句 + 前后各至多 2 句（跨段照取）+ 全书结构摘要 */
export function glossInput(sentences: readonly SentenceData[], index: number, structure: string | null) {
  const text = (i: number) => sentences[i].text.trim();
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from) }, (_, k) => text(from + k)).filter(Boolean);
  return {
    sentence: text(index),
    before: range(Math.max(0, index - MAX_BEFORE), index),
    after: range(index + 1, Math.min(sentences.length, index + 1 + MAX_AFTER)),
    structure,
  };
}

/** 功能二独立使用“上一段／当前段／下一段”，不影响功能一的前后各两句窗口。 */
export function buildExplainInput(
  paragraphs: readonly string[],
  sentences: readonly SentenceData[],
  index: number,
  structure: string | null,
  savedGlosses: ReadonlyMap<number, SavedGloss>,
  automaticGlosses: ReadonlyMap<number, MemoryGloss>,
  sampleGloss: string | null = null,
): ExplainInput {
  const sentence = sentences[index];
  if (!sentence) throw new Error("explain input requires an existing sentence");
  const context = cropExplainContext(paragraphs, sentence);
  const source = savedGlosses.get(index)?.text ?? automaticGlosses.get(index)?.text ?? sampleGloss;
  return {
    sentence: sentence.text.trim(),
    context,
    gloss: source ? source.replaceAll(TERM_OPEN, "").replaceAll(TERM_CLOSE, "").trim() || null : null,
    structure,
  };
}

/**
 * 正常情况完整带三段。超出 2,000 字时，当前段最多占 1,200 字并优先保留；
 * 余量默认均分给相邻段，一侧不够时回流到另一侧。省略号是明确的裁剪提示。
 */
export function cropExplainContext(
  paragraphs: readonly string[],
  sentence: Pick<SentenceData, "paraIndex" | "start" | "text">,
): ExplainInput["context"] {
  const previous = sentence.paraIndex > 0 ? paragraphs[sentence.paraIndex - 1]?.trim() || null : null;
  const current = paragraphs[sentence.paraIndex]?.trim() || sentence.text.trim();
  const next = sentence.paraIndex + 1 < paragraphs.length ? paragraphs[sentence.paraIndex + 1]?.trim() || null : null;
  if (contextChars(previous, current, next) <= MAX_EXPLAIN_CONTEXT_CHARS) return { previous, current, next };

  const rawCurrent = paragraphs[sentence.paraIndex] ?? sentence.text;
  const targetStart = Math.max(0, sentence.start);
  const targetEnd = Math.min(rawCurrent.length, targetStart + sentence.text.length);
  const currentBudget = Math.min(1200, countChars(current));
  const croppedCurrent = countChars(current) <= currentBudget
    ? current
    : cropAroundSentence(rawCurrent, targetStart, targetEnd, currentBudget);
  const remainingBudget = MAX_EXPLAIN_CONTEXT_CHARS - countChars(croppedCurrent);
  const { previousBudget, nextBudget } = distributeNeighborBudget(
    countChars(previous ?? ""),
    countChars(next ?? ""),
    remainingBudget,
  );
  return {
    previous: previous ? cropTail(previous, previousBudget) : null,
    current: croppedCurrent,
    next: next ? cropHead(next, nextBudget) : null,
  };
}

export function distributeNeighborBudget(previousChars: number, nextChars: number, total: number): { previousBudget: number; nextBudget: number } {
  const preferredPrevious = Math.floor(total / 2);
  const preferredNext = total - preferredPrevious;
  let previousBudget = Math.min(previousChars, preferredPrevious);
  let nextBudget = Math.min(nextChars, preferredNext);
  let remaining = total - previousBudget - nextBudget;
  const previousExtra = Math.min(previousChars - previousBudget, remaining);
  previousBudget += previousExtra;
  remaining -= previousExtra;
  nextBudget += Math.min(nextChars - nextBudget, remaining);
  return { previousBudget, nextBudget };
}

export function contextChars(previous: string | null, current: string, next: string | null): number {
  return countChars(previous ?? "") + countChars(current) + countChars(next ?? "");
}

export function cropHead(text: string, budget: number): string {
  if (countChars(text) <= budget) return text;
  return `${takeCodePoints(text, Math.max(0, budget - countChars("……")))}……`;
}

export function cropTail(text: string, budget: number): string {
  if (countChars(text) <= budget) return text;
  return `……${takeCodePointsFromEnd(text, Math.max(0, budget - countChars("……")))}`;
}

export function cropAroundSentence(text: string, start: number, end: number, budget: number): string {
  if (countChars(text) <= budget) return text.trim();
  const target = text.slice(start, end).trim();
  if (countChars(target) >= budget) return cropHead(target, budget);
  const remaining = budget - countChars(target);
  const beforeBudget = Math.floor(remaining / 2);
  const afterBudget = remaining - beforeBudget;
  const before = cropTail(text.slice(0, start).trimEnd(), beforeBudget);
  const after = cropHead(text.slice(end).trimStart(), afterBudget);
  return `${before}${target}${after}`.trim();
}

export function takeCodePoints(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

export function takeCodePointsFromEnd(text: string, limit: number): string {
  if (limit <= 0) return "";
  return Array.from(text).slice(-limit).join("");
}
