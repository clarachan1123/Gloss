import { countChars } from "./parse/validate";
import { segmentParagraphs } from "./segment";
import type { StoredDocument, ShelfEntry } from "./storage";

export const SAMPLE_DOC_ID = "sample";
export const SAMPLE_TITLE = "自由与必然";
export const SAMPLE_AUTHOR = "瞿秋白";
export const SAMPLE_SOURCE = "《社会哲学概论》（1924），第一部分第七章";
export const SAMPLE_URL = "/samples/ziyou-yu-biran.json";
export const SAMPLE_REMOVED_KEY = "gloss:sample:removed";
export const SAMPLE_BREATHED_KEY = "gloss:sample:breathed";
export const SAMPLE_SENTENCE_COUNT = 13;

export interface SampleContent {
  id: typeof SAMPLE_DOC_ID;
  title: string;
  author: string;
  source: string;
  glossPromptVersion: string;
  placeholder: boolean;
  breatheSentenceIndex: number;
  structure: string | null;
  paragraphs: string[];
  glosses: string[];
}

export interface SampleBook {
  content: SampleContent;
  doc: StoredDocument;
}

export const SAMPLE_SHELF_ENTRY: ShelfEntry = {
  docId: SAMPLE_DOC_ID,
  title: SAMPLE_TITLE,
  author: SAMPLE_AUTHOR,
  addedAt: 0,
  lastOpenedAt: 0,
  colorId: "book-0",
  widthSeed: 0,
};

export function isSampleRemoved(): boolean {
  try { return globalThis.localStorage?.getItem(SAMPLE_REMOVED_KEY) === "1"; }
  catch { return false; }
}

export function removeSampleFromShelf(): boolean {
  try { globalThis.localStorage?.setItem(SAMPLE_REMOVED_KEY, "1"); return true; }
  catch { return false; }
}

export function hasSampleBreathed(): boolean {
  try { return globalThis.localStorage?.getItem(SAMPLE_BREATHED_KEY) === "1"; }
  catch { return false; }
}

export function markSampleBreathed(): void {
  try { globalThis.localStorage?.setItem(SAMPLE_BREATHED_KEY, "1"); }
  catch { /* 本次会话仍会停止动效。 */ }
}

/** 公共内容文件只在阅读页请求；句序与随书白话必须完全对齐。 */
export function parseSampleContent(value: unknown): SampleBook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.id !== SAMPLE_DOC_ID || data.title !== SAMPLE_TITLE || data.author !== SAMPLE_AUTHOR ||
      data.source !== SAMPLE_SOURCE || typeof data.glossPromptVersion !== "string" ||
      typeof data.placeholder !== "boolean" || !Array.isArray(data.paragraphs) ||
      !data.paragraphs.every((paragraph) => typeof paragraph === "string") ||
      !Array.isArray(data.glosses) || !data.glosses.every((gloss) => typeof gloss === "string" && gloss.length > 0) ||
      !(data.structure === null || typeof data.structure === "string")) return null;
  const paragraphs = data.paragraphs as string[];
  const glosses = data.glosses as string[];
  const sentenceCount = segmentParagraphs(paragraphs).sentences.length;
  if (sentenceCount !== SAMPLE_SENTENCE_COUNT || glosses.length !== SAMPLE_SENTENCE_COUNT ||
      !Number.isInteger(data.breatheSentenceIndex) || (data.breatheSentenceIndex as number) < 0 ||
      (data.breatheSentenceIndex as number) >= sentenceCount) return null;
  const content = data as unknown as SampleContent;
  return {
    content,
    doc: {
      version: 1,
      docId: SAMPLE_DOC_ID,
      paragraphs,
      headings: [],
      footnotes: [],
      meta: { format: "txt", fileName: SAMPLE_TITLE, charCount: countChars(paragraphs.join("\n")) },
      savedAt: 0,
    },
  };
}

export async function loadSampleBook(): Promise<SampleBook | null> {
  const response = await fetch(SAMPLE_URL);
  if (!response.ok) return null;
  return parseSampleContent(await response.json());
}
