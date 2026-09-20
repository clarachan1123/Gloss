import type { ParsedDocument, ParsedFootnote, ParsedHeading } from "./parse/validate";
import type { Sentence } from "./segment";

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
const SAVED_GLOSS_PREFIX = "gloss:saved:";
const EXPLAIN_PREFIX = "gloss:explain:";
const SHELF_KEY = "gloss:shelf:v1";
const SCHEMA_VERSION = 1;
const SAVED_GLOSS_SCHEMA_VERSION = 1;
const EXPLAIN_SCHEMA_VERSION = 1;

export interface StoredDocument {
  version: typeof SCHEMA_VERSION;
  docId: string;
  paragraphs: string[];
  headings: ParsedHeading[];
  footnotes: ParsedFootnote[];
  meta: ParsedDocument["meta"];
  savedAt: number;
}

export interface ShelfEntry {
  docId: string;
  title: string;
  author: string | null;
  addedAt: number;
  lastOpenedAt: number;
  colorId: string;
  widthSeed: number;
}

interface ShelfRecord {
  version: 1;
  migratedAt: number;
  entries: Record<string, ShelfEntry>;
}

export interface ShelfSnapshot {
  entries: ShelfEntry[];
  unavailable: boolean;
}

export type SavedGlossKind = "saved" | "edited";

/** 已保存白话的身份基于原文字符区间，不依赖会话用的全局句序号。 */
export interface SavedGloss {
  paraIndex: number;
  start: number;
  sourceHash: string;
  text: string;
  savedAt: number;
  kind: SavedGlossKind;
}

interface SavedGlossRecord {
  version: typeof SAVED_GLOSS_SCHEMA_VERSION;
  entries: SavedGloss[];
}

/** 功能二结果独立于保存白话；身份同样不依赖易变的全局句序号。 */
export interface StoredExplanation {
  paraIndex: number;
  start: number;
  sourceHash: string;
  text: string;
  createdAt: number;
}

interface ExplanationRecord {
  version: typeof EXPLAIN_SCHEMA_VERSION;
  entries: StoredExplanation[];
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

function savedGlossKey(docId: string): string {
  return SAVED_GLOSS_PREFIX + docId;
}

function explanationKey(docId: string): string {
  return EXPLAIN_PREFIX + docId;
}

async function hashSentence(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readSavedGlossRecord(docId: string): SavedGlossRecord {
  const raw = getStorage().getItem(savedGlossKey(docId));
  if (raw === null) return { version: SAVED_GLOSS_SCHEMA_VERSION, entries: [] };
  try {
    const record = JSON.parse(raw) as Partial<SavedGlossRecord> | null;
    if (record?.version !== SAVED_GLOSS_SCHEMA_VERSION || !Array.isArray(record.entries)) {
      return { version: SAVED_GLOSS_SCHEMA_VERSION, entries: [] };
    }
    return {
      version: SAVED_GLOSS_SCHEMA_VERSION,
      entries: record.entries.filter(isSavedGloss),
    };
  } catch {
    return { version: SAVED_GLOSS_SCHEMA_VERSION, entries: [] };
  }
}

function isSavedGloss(value: unknown): value is SavedGloss {
  const item = value as Partial<SavedGloss> | null;
  return (
    typeof item?.paraIndex === "number" &&
    Number.isInteger(item.paraIndex) &&
    item.paraIndex >= 0 &&
    typeof item.start === "number" &&
    Number.isInteger(item.start) &&
    item.start >= 0 &&
    typeof item.sourceHash === "string" &&
    typeof item.text === "string" &&
    typeof item.savedAt === "number" &&
    (item.kind === "saved" || item.kind === "edited")
  );
}

function isStoredExplanation(value: unknown): value is StoredExplanation {
  const item = value as Partial<StoredExplanation> | null;
  return (
    typeof item?.paraIndex === "number" &&
    Number.isInteger(item.paraIndex) &&
    item.paraIndex >= 0 &&
    typeof item.start === "number" &&
    Number.isInteger(item.start) &&
    item.start >= 0 &&
    typeof item.sourceHash === "string" &&
    typeof item.text === "string" &&
    typeof item.createdAt === "number"
  );
}

function writeSavedGlossRecord(docId: string, record: SavedGlossRecord): void {
  try {
    getStorage().setItem(savedGlossKey(docId), JSON.stringify(record));
  } catch (err) {
    throw new StorageError(isQuotaError(err) ? "E1" : "E2", err);
  }
}

/**
 * 只对该文档已有的保存记录计算当前候选句的 hash。无效记录留在本地，供未来断句变化后的重新对位使用。
 */
export async function loadSavedGlosses(docId: string, sentences: readonly Sentence[]): Promise<Map<number, SavedGloss>> {
  const record = readSavedGlossRecord(docId);
  const byLocation = new Map(sentences.map((sentence) => [`${sentence.paraIndex}:${sentence.start}`, sentence]));
  const matches = await Promise.all(
    record.entries.map(async (entry) => {
      const sentence = byLocation.get(`${entry.paraIndex}:${entry.start}`);
      if (!sentence || (await hashSentence(sentence.text)) !== entry.sourceHash) return null;
      return [sentence.index, entry] as const;
    }),
  );
  return new Map(matches.filter((match): match is readonly [number, SavedGloss] => match !== null));
}

/** 保存当时屏幕显示的原始白话文本；编辑版字段仅预留，G-17 才会写入 edited。 */
export async function saveSavedGloss(
  docId: string,
  sentence: Pick<Sentence, "paraIndex" | "start" | "text">,
  text: string,
  kind: SavedGlossKind = "saved",
): Promise<SavedGloss> {
  const entry: SavedGloss = {
    paraIndex: sentence.paraIndex,
    start: sentence.start,
    sourceHash: await hashSentence(sentence.text),
    text,
    savedAt: Date.now(),
    kind,
  };
  const record = readSavedGlossRecord(docId);
  record.entries = record.entries.filter((item) => item.paraIndex !== entry.paraIndex || item.start !== entry.start);
  record.entries.push(entry);
  writeSavedGlossRecord(docId, record);
  return entry;
}

/** 取消当前字符区间的保存；写入成功后调用方才可以切换 UI 状态。 */
export async function removeSavedGloss(
  docId: string,
  sentence: Pick<Sentence, "paraIndex" | "start" | "text">,
): Promise<void> {
  const sourceHash = await hashSentence(sentence.text);
  const record = readSavedGlossRecord(docId);
  record.entries = record.entries.filter(
    (entry) => entry.paraIndex !== sentence.paraIndex || entry.start !== sentence.start || entry.sourceHash !== sourceHash,
  );
  writeSavedGlossRecord(docId, record);
}

/* ---------------- 功能二：整句理解 ---------------- */

function readExplanationRecord(docId: string): ExplanationRecord {
  const raw = getStorage().getItem(explanationKey(docId));
  if (raw === null) return { version: EXPLAIN_SCHEMA_VERSION, entries: [] };
  try {
    const record = JSON.parse(raw) as Partial<ExplanationRecord> | null;
    if (record?.version !== EXPLAIN_SCHEMA_VERSION || !Array.isArray(record.entries)) {
      return { version: EXPLAIN_SCHEMA_VERSION, entries: [] };
    }
    return { version: EXPLAIN_SCHEMA_VERSION, entries: record.entries.filter(isStoredExplanation) };
  } catch {
    return { version: EXPLAIN_SCHEMA_VERSION, entries: [] };
  }
}

function writeExplanationRecord(docId: string, record: ExplanationRecord): void {
  try {
    getStorage().setItem(explanationKey(docId), JSON.stringify(record));
  } catch (err) {
    throw new StorageError(isQuotaError(err) ? "E1" : "E2", err);
  }
}

export async function loadExplanations(
  docId: string,
  sentences: readonly Sentence[],
): Promise<Map<number, StoredExplanation>> {
  const record = readExplanationRecord(docId);
  const byLocation = new Map(sentences.map((sentence) => [`${sentence.paraIndex}:${sentence.start}`, sentence]));
  const matches = await Promise.all(
    record.entries.map(async (entry) => {
      const sentence = byLocation.get(`${entry.paraIndex}:${entry.start}`);
      if (!sentence || (await hashSentence(sentence.text)) !== entry.sourceHash) return null;
      return [sentence.index, entry] as const;
    }),
  );
  return new Map(matches.filter((match): match is readonly [number, StoredExplanation] => match !== null));
}

export async function saveExplanation(
  docId: string,
  sentence: Pick<Sentence, "paraIndex" | "start" | "text">,
  text: string,
): Promise<StoredExplanation> {
  const entry: StoredExplanation = {
    paraIndex: sentence.paraIndex,
    start: sentence.start,
    sourceHash: await hashSentence(sentence.text),
    text,
    createdAt: Date.now(),
  };
  const record = readExplanationRecord(docId);
  record.entries = record.entries.filter((item) => item.paraIndex !== entry.paraIndex || item.start !== entry.start);
  record.entries.push(entry);
  writeExplanationRecord(docId, record);
  return entry;
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
  // 书架索引只是加速层：索引满或暂不可写时仍保住刚导入的原文，下一次书架对账会补回。
  try {
    upsertShelfEntry(record);
  } catch {}
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
    // 只记错误类型：JSON 解析错误的消息会带出一段原始数据（即文档内容）
    console.warn("[Gloss] 本地文档数据无法读取，按不存在处理", {
      docId,
      errName: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }
}

function titleForDocument(doc: StoredDocument): string {
  const fileName = doc.meta.fileName?.replace(/\.[^.]+$/, "").trim();
  if (fileName) return fileName;
  const heading = doc.headings[0]?.text.trim();
  if (heading) return heading;
  const firstParagraph = doc.paragraphs.find((paragraph) => paragraph.trim())?.trim();
  if (firstParagraph) return `${Array.from(firstParagraph).slice(0, 12).join("")}…`;
  return "未命名文档";
}

function seedForDoc(docId: string): number {
  return Number.parseInt(docId, 16) >>> 0;
}

function shelfEntryForDocument(doc: StoredDocument): ShelfEntry {
  return {
    docId: doc.docId,
    title: titleForDocument(doc),
    author: null,
    addedAt: doc.savedAt,
    lastOpenedAt: doc.savedAt,
    colorId: `book-${seedForDoc(doc.docId) % 11}`,
    widthSeed: seedForDoc(doc.docId),
  };
}

function readShelfRecord(storage: Storage): ShelfRecord | null {
  const raw = storage.getItem(SHELF_KEY);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as Partial<ShelfRecord> | null;
    if (record?.version !== 1 || typeof record.migratedAt !== "number" || !record.entries) return null;
    return { version: 1, migratedAt: record.migratedAt, entries: record.entries };
  } catch {
    return null;
  }
}

/** 第一次书架打开才扫描旧文档；只写 gloss:shelf:v1，绝不回写任何既有记录。 */
function reconcileShelf(storage: Storage): ShelfRecord {
  const existing = readShelfRecord(storage);
  const entries = { ...(existing?.entries ?? {}) };
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(DOC_PREFIX)) continue;
    const docId = key.slice(DOC_PREFIX.length);
    if (entries[docId]) continue;
    const doc = loadDocument(docId);
    if (doc) entries[docId] = shelfEntryForDocument(doc);
  }
  const next: ShelfRecord = { version: 1, migratedAt: existing?.migratedAt ?? Date.now(), entries };
  if (!existing || Object.keys(entries).length !== Object.keys(existing.entries).length) {
    storage.setItem(SHELF_KEY, JSON.stringify(next));
  }
  return next;
}

function upsertShelfEntry(doc: StoredDocument): void {
  const storage = getStorage();
  const record = readShelfRecord(storage) ?? { version: 1 as const, migratedAt: Date.now(), entries: {} };
  const previous = record.entries[doc.docId];
  record.entries[doc.docId] = previous ?? shelfEntryForDocument(doc);
  storage.setItem(SHELF_KEY, JSON.stringify(record));
}

/** 书架加载与遗留文档对账；E2 由调用方显示明确提示。 */
export function loadShelf(): ShelfSnapshot {
  try {
    const record = reconcileShelf(getStorage());
    return { entries: Object.values(record.entries).sort((a, b) => a.addedAt - b.addedAt), unavailable: false };
  } catch {
    return { entries: [], unavailable: true };
  }
}

/** 文档已成功显示后触发；不影响书脊排序。 */
export function touchShelfEntry(docId: string): void {
  try {
    const storage = getStorage();
    const record = reconcileShelf(storage);
    const entry = record.entries[docId];
    if (!entry) return;
    record.entries[docId] = { ...entry, lastOpenedAt: Date.now() };
    storage.setItem(SHELF_KEY, JSON.stringify(record));
  } catch {}
}

export function setShelfColor(docId: string, colorId: string): void {
  try {
    const storage = getStorage();
    const record = reconcileShelf(storage);
    const entry = record.entries[docId];
    if (!entry) return;
    record.entries[docId] = { ...entry, colorId };
    storage.setItem(SHELF_KEY, JSON.stringify(record));
  } catch {}
}

/** 删除一本文档所有 localStorage 关联记录；IndexedDB 自动白话由调用方随后按 docId 删除。 */
export function removeShelfDocument(docId: string): boolean {
  try {
    const storage = getStorage();
    const record = reconcileShelf(storage);
    storage.removeItem(DOC_PREFIX + docId);
    storage.removeItem(POS_PREFIX + docId);
    storage.removeItem(STRUCTURE_PREFIX + docId);
    storage.removeItem(SAVED_GLOSS_PREFIX + docId);
    storage.removeItem(EXPLAIN_PREFIX + docId);
    delete record.entries[docId];
    storage.setItem(SHELF_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
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
