import type { ParsedDocument, ParsedFootnote, ParsedHeading } from "./parse/validate";

/**
 * 本地存储：文档与阅读位置（G-04）、全书结构摘要（G-07）。白话存储不在这里（G-10）。
 *
 * - docId = SHA-256(paragraphs.join("\n")) 的前 8 位 hex，是书架主键。
 *   只由内容决定，与文件名、格式、上传时间无关；同一份文档重复上传覆盖同一条目。
 *   G-02 保证单个段落内不含换行，join("\n") 不会让不同分段撞成同一个 id。
 * - 只存 paragraphs / headings / footnotes / meta，不存 text 和 sentences：
 *   二者加载时重算（切句是确定性的），避免重复数据逼近 localStorage 上限（E1）。
 * - 阅读位置存句序号（PRD 3.8：doc_id → 句序号），不存像素位置。
 */

const DOC_PREFIX = "gloss:doc:";
const POS_PREFIX = "gloss:pos:";
const STRUCTURE_PREFIX = "gloss:structure:";
const SCHEMA_VERSION = 1;

export interface StoredDocument {
  version: typeof SCHEMA_VERSION;
  docId: string;
  paragraphs: string[];
  headings: ParsedHeading[];
  footnotes: ParsedFootnote[];
  meta: ParsedDocument["meta"];
  savedAt: number;
}

/** PRD 3.9：E1 存储已满；E2 存储不可用（被禁用、隐私模式等） */
export type StorageErrorCode = "E1" | "E2";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, cause?: unknown) {
    super(`storage failed: ${code}`);
    this.name = "StorageError";
    this.code = code;
    this.cause = cause;
  }
}

export async function computeDocId(paragraphs: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(paragraphs.join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

function getStorage(): Storage {
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("localStorage is not available");
    return storage;
  } catch (err) {
    throw new StorageError("E2", err);
  }
}

function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/** 保存文档，返回 docId。存储已满抛 StorageError("E1")，不可用抛 StorageError("E2") */
export async function saveDocument(doc: ParsedDocument): Promise<string> {
  const docId = await computeDocId(doc.paragraphs);
  const record: StoredDocument = {
    version: SCHEMA_VERSION,
    docId,
    paragraphs: doc.paragraphs,
    headings: doc.headings,
    footnotes: doc.footnotes,
    meta: doc.meta,
    savedAt: Date.now(),
  };
  const storage = getStorage();
  try {
    storage.setItem(DOC_PREFIX + docId, JSON.stringify(record));
  } catch (err) {
    throw new StorageError(isQuotaError(err) ? "E1" : "E2", err);
  }
  return docId;
}

/** 读取文档。找不到或数据损坏返回 null；存储不可用抛 StorageError("E2") */
export function loadDocument(docId: string): StoredDocument | null {
  const storage = getStorage();
  let raw: string | null;
  try {
    raw = storage.getItem(DOC_PREFIX + docId);
  } catch (err) {
    throw new StorageError("E2", err);
  }
  if (raw === null) return null;

  try {
    const record = JSON.parse(raw) as StoredDocument;
    if (record?.version !== SCHEMA_VERSION || !Array.isArray(record.paragraphs)) {
      throw new Error("unexpected record shape");
    }
    return record;
  } catch (err) {
    console.warn("[Gloss] 本地文档数据无法读取，按不存在处理", { docId, err });
    return null;
  }
}

/** 保存阅读位置（句序号）。尽力而为：失败只留 console.warn，不打断阅读 */
export function saveReadingPosition(docId: string, sentenceIndex: number): void {
  try {
    getStorage().setItem(POS_PREFIX + docId, String(sentenceIndex));
  } catch (err) {
    console.warn("[Gloss] 阅读位置保存失败", { docId, sentenceIndex, err });
  }
}

/** 读取阅读位置（句序号）。未保存、值非法或存储不可用时返回 null */
export function loadReadingPosition(docId: string): number | null {
  try {
    const raw = getStorage().getItem(POS_PREFIX + docId);
    // 只接受非负整数的十进制写法；Number("") 是 0，不能直接转
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

/* ---------------- 全书结构摘要 ---------------- */

interface StoredStructure {
  version: typeof SCHEMA_VERSION;
  /** 生成这份摘要的提示词版本。提示词一改，旧摘要作废，下次开书重算 */
  prompt: string;
  structure: string;
  savedAt: number;
}

/**
 * 保存全书结构摘要。/api/structure 每调用一次就计费一次，所以每份文档只算一次，算好就存。
 * 尽力而为：失败只留 console.warn——下次开书会重算，不影响阅读。
 */
export function saveStructure(docId: string, prompt: string, structure: string): void {
  const record: StoredStructure = { version: SCHEMA_VERSION, prompt, structure, savedAt: Date.now() };
  try {
    getStorage().setItem(STRUCTURE_PREFIX + docId, JSON.stringify(record));
  } catch (err) {
    console.warn("[Gloss] 结构摘要保存失败，下次打开会重算", { docId, err });
  }
}

/** 读取结构摘要。没有、数据损坏、提示词版本不符或存储不可用时返回 null */
export function loadStructure(docId: string, prompt: string): string | null {
  try {
    const raw = getStorage().getItem(STRUCTURE_PREFIX + docId);
    if (raw === null) return null;
    const record = JSON.parse(raw) as Partial<StoredStructure> | null;
    if (record?.version !== SCHEMA_VERSION || record.prompt !== prompt || typeof record.structure !== "string") {
      return null;
    }
    return record.structure;
  } catch {
    return null;
  }
}
