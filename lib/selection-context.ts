import { parseExplainRequest, parseGlossRequest, MAX_EXPLAIN_CONTEXT_CHARS, type ExplainRequest, type Parsed } from "./context";
import type { ChatMessage } from "./deepseek";
import { countChars } from "./parse/validate";
import { RANGE_SYSTEM_PROMPT } from "./prompts/range";
import { TERM_SYSTEM_PROMPT } from "./prompts/term";
import type { Sentence } from "./segment";
import { comparePoints, selectionText, SELECTION_PUNCTUATION, type SourceSelection } from "./selection";

export interface TermRequest {
  word: string;
  sentence: string;
  context: ExplainRequest["context"];
  structure: string | null;
}
export interface RangeGlossRequest {
  text: string;
  sentenceCount: number;
  before: string[];
  after: string[];
  structure: string | null;
}
export type SelectionInput = { kind: "term"; input: TermRequest } | { kind: "range"; input: RangeGlossRequest };
export const SELECTION_OUTPUT_VERSION = "selection-output-v0";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function parseTermRequest(body: unknown): Parsed<TermRequest> {
  if (!record(body)) return fail("请求体必须是 JSON 对象");
  const word = typeof body.word === "string" ? body.word.trim() : "";
  if (countChars(word) < 1 || countChars(word) > 12) return fail("word 必须为 1–12 字");
  if (SELECTION_PUNCTUATION.test(word)) return fail("word 不能包含标点");
  const parsed = parseExplainRequest({ sentence: body.sentence, context: body.context, structure: body.structure, gloss: null });
  if (!parsed.ok) return parsed;
  if (!parsed.value.sentence.includes(word)) return fail("word 必须出现在源句中");
  // 校验沿用既有上限，消息中的源句保留原始全文。
  return { ok: true, value: { word, sentence: body.sentence as string, context: parsed.value.context, structure: parsed.value.structure } };
}

export function rangeParameters(sentenceCount: number): { maxChars: number; maxTokens: number } {
  if (!Number.isSafeInteger(sentenceCount) || sentenceCount < 1 || sentenceCount > 1000) throw new RangeError("源句数必须为 1–1000");
  const maxChars = Math.min(600, 150 * sentenceCount);
  return { maxChars, maxTokens: Math.ceil(400 * maxChars / 150) };
}

export function parseRangeGlossRequest(body: unknown): Parsed<RangeGlossRequest> {
  if (!record(body)) return fail("请求体必须是 JSON 对象");
  const parsed = parseGlossRequest({ sentence: body.text, before: body.before, after: body.after, structure: body.structure });
  if (!parsed.ok) return parsed;
  const sentenceCount = body.sentenceCount;
  if (typeof sentenceCount !== "number" || !Number.isSafeInteger(sentenceCount) || sentenceCount < 1 || sentenceCount > countChars(parsed.value.sentence)) {
    return fail("sentenceCount 必须为选区字数以内的正整数");
  }
  return { ok: true, value: { text: body.text as string, sentenceCount, before: parsed.value.before, after: parsed.value.after, structure: parsed.value.structure } };
}

export function buildTermMessages(input: TermRequest): ChatMessage[] {
  return [
    { role: "system", content: TERM_SYSTEM_PROMPT },
    { role: "user", content: "【全书结构摘要】\n" + (input.structure ?? "暂无") },
    { role: "user", content: "【上一段】\n" + (input.context.previous ?? "暂无") + "\n\n【当前段】\n" + input.context.current + "\n\n【下一段】\n" + (input.context.next ?? "暂无") },
    { role: "user", content: "【目标句】\n" + input.sentence },
    { role: "user", content: "【选中的词】\n" + input.word },
  ];
}

export function buildRangeGlossMessages(input: RangeGlossRequest): ChatMessage[] {
  const { maxChars } = rangeParameters(input.sentenceCount);
  return [
    { role: "system", content: RANGE_SYSTEM_PROMPT },
    { role: "user", content: "【全书结构】\n" + (input.structure ?? "暂无") },
    { role: "user", content: "【前文】\n" + input.before.join("\n") },
    { role: "user", content: "【要讲白的段落】\n" + input.text },
    { role: "user", content: "【后文】\n" + input.after.join("\n") },
    { role: "user", content: "【字数上限】\n" + maxChars },
  ];
}

export function touchedSelectionSentences(selection: SourceSelection, sentences: readonly Sentence[]): Sentence[] {
  return sentences.filter(sentence => comparePoints({ paraIndex: sentence.paraIndex, offset: sentence.start }, selection.end) < 0 &&
    comparePoints({ paraIndex: sentence.paraIndex, offset: sentence.start + sentence.text.length }, selection.start) > 0);
}

export function buildTermInput(selection: SourceSelection, paragraphs: readonly string[], sentences: readonly Sentence[], structure: string | null): TermRequest {
  if (selection.kind !== "term") throw new Error("语境释义必须来自词语选区");
  const touched = touchedSelectionSentences(selection, sentences);
  if (touched.length !== 1) throw new Error("语境释义必须位于同一源句");
  const text = selectionText(paragraphs, selection.start, selection.end);
  const word = selection.autoPunctuation ? text.slice(0, -selection.autoPunctuation.length) : text;
  const input = { word, sentence: touched[0].text, context: cropTermContext(paragraphs, touched[0]), structure: structure?.trim() || null };
  const parsed = parseTermRequest(input);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

export function buildRangeGlossInput(selection: SourceSelection, paragraphs: readonly string[], sentences: readonly Sentence[], structure: string | null): RangeGlossRequest {
  if (selection.kind !== "range") throw new Error("整句与词语不走范围白话");
  const touched = touchedSelectionSentences(selection, sentences);
  if (!touched.length) throw new Error("选区没有触及源句");
  const first = sentences.indexOf(touched[0]), last = sentences.indexOf(touched.at(-1)!);
  const input = {
    text: selectionText(paragraphs, selection.start, selection.end), sentenceCount: touched.length,
    before: sentences.slice(Math.max(0, first - 2), first).map(sentence => sentence.text),
    after: sentences.slice(last + 1, last + 3).map(sentence => sentence.text), structure: structure?.trim() || null,
  };
  const parsed = parseRangeGlossRequest(input);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

export interface WholeSentenceSources {
  saved?: string | null;
  session?: { text: string; complete: boolean } | null;
  automatic?: string | null;
  sample?: string | null;
}
export type WholeSentenceReuse =
  | { status: "reuse"; source: "saved" | "session" | "automatic" | "sample"; text: string }
  | { status: "single-sentence-required" }
  | { status: "not-whole" };

/** 未命中时明确交回既有单句链路，绝不转成范围白话请求。 */
export function resolveWholeSentenceReuse(selection: Pick<SourceSelection, "kind">, sources: WholeSentenceSources): WholeSentenceReuse {
  if (selection.kind !== "sentence") return { status: "not-whole" };
  const candidates = [
    ["saved", sources.saved], ["session", sources.session?.complete ? sources.session.text : null],
    ["automatic", sources.automatic], ["sample", sources.sample],
  ] as const;
  for (const [source, text] of candidates) if (text?.trim()) return { status: "reuse", source, text };
  return { status: "single-sentence-required" };
}

/** 逐项沿用现有 Reader 的裁剪预算与算法；组件文件保持不变。 */
export function cropTermContext(paragraphs: readonly string[], sentence: Pick<Sentence, "paraIndex" | "start" | "text">): TermRequest["context"] {
  const previous = sentence.paraIndex > 0 ? paragraphs[sentence.paraIndex - 1]?.trim() || null : null;
  const current = paragraphs[sentence.paraIndex]?.trim() || sentence.text.trim();
  const next = sentence.paraIndex + 1 < paragraphs.length ? paragraphs[sentence.paraIndex + 1]?.trim() || null : null;
  if (countChars(previous ?? "") + countChars(current) + countChars(next ?? "") <= MAX_EXPLAIN_CONTEXT_CHARS) return { previous, current, next };
  const rawCurrent = paragraphs[sentence.paraIndex] ?? sentence.text;
  const targetStart = Math.max(0, sentence.start), targetEnd = Math.min(rawCurrent.length, targetStart + sentence.text.length);
  const currentBudget = Math.min(1200, countChars(current));
  const croppedCurrent = countChars(current) <= currentBudget ? current : cropAroundSentence(rawCurrent, targetStart, targetEnd, currentBudget);
  const remainingBudget = MAX_EXPLAIN_CONTEXT_CHARS - countChars(croppedCurrent);
  const { previousBudget, nextBudget } = distributeNeighborBudget(countChars(previous ?? ""), countChars(next ?? ""), remainingBudget);
  return { previous: previous ? cropTail(previous, previousBudget) : null, current: croppedCurrent, next: next ? cropHead(next, nextBudget) : null };
}
function distributeNeighborBudget(previousChars: number, nextChars: number, total: number) {
  let previousBudget = Math.min(previousChars, Math.floor(total / 2));
  let nextBudget = Math.min(nextChars, total - Math.floor(total / 2));
  let remaining = total - previousBudget - nextBudget;
  const previousExtra = Math.min(previousChars - previousBudget, remaining);
  previousBudget += previousExtra; remaining -= previousExtra;
  nextBudget += Math.min(nextChars - nextBudget, remaining);
  return { previousBudget, nextBudget };
}
function cropHead(text: string, budget: number): string {
  return countChars(text) <= budget ? text : Array.from(text).slice(0, Math.max(0, budget - countChars("……"))).join("") + "……";
}
function cropTail(text: string, budget: number): string {
  if (countChars(text) <= budget) return text;
  const limit = Math.max(0, budget - countChars("……"));
  return "……" + (limit > 0 ? Array.from(text).slice(-limit).join("") : "");
}
function cropAroundSentence(text: string, start: number, end: number, budget: number): string {
  if (countChars(text) <= budget) return text.trim();
  const target = text.slice(start, end).trim();
  if (countChars(target) >= budget) return cropHead(target, budget);
  const remaining = budget - countChars(target);
  return (cropTail(text.slice(0, start).trimEnd(), Math.floor(remaining / 2)) + target + cropHead(text.slice(end).trimStart(), remaining - Math.floor(remaining / 2))).trim();
}
