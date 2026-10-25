import type { GlossResult } from "./gloss-client";
import { MODEL_FAST } from "./models";
import { splitTerms } from "./output";
import { countChars } from "./parse/validate";
import { RANGE_PROMPT_VERSION, RANGE_TEMPERATURE } from "./prompts/range";
import { TERM_MAX_CHARS, TERM_MAX_TOKENS, TERM_PROMPT_VERSION, TERM_TEMPERATURE } from "./prompts/term";
import { rangeParameters, SELECTION_OUTPUT_VERSION, type SelectionInput } from "./selection-context";

export const SELECTION_CACHE_DB = "gloss-selection-cache";
export const SELECTION_CACHE_STORE = "selection-results";
export const SELECTION_CACHE_SCHEMA_VERSION = 1;
export interface SelectionCacheRuntime {
  model: string; promptVersion: string; temperature: number; maxTokens: number; maxChars: number; outputVersion: string;
}
export interface SelectionCacheKeyParts {
  docId: string; kind: SelectionInput["kind"]; contextHash: string; hasStructure: boolean; runtime: SelectionCacheRuntime;
}
export interface SelectionCacheRecord extends SelectionCacheKeyParts {
  key: string; schemaVersion: number; text: string; savedAt: number;
}

export function selectionCacheRuntime(selection: SelectionInput): SelectionCacheRuntime {
  return selection.kind === "term"
    ? { model: MODEL_FAST, promptVersion: TERM_PROMPT_VERSION, temperature: TERM_TEMPERATURE, maxTokens: TERM_MAX_TOKENS, maxChars: TERM_MAX_CHARS, outputVersion: SELECTION_OUTPUT_VERSION }
    : { model: MODEL_FAST, promptVersion: RANGE_PROMPT_VERSION, temperature: RANGE_TEMPERATURE, ...rangeParameters(selection.input.sentenceCount), outputVersion: SELECTION_OUTPUT_VERSION };
}
export function makeSelectionCacheKey(parts: SelectionCacheKeyParts): string {
  const r = parts.runtime;
  return JSON.stringify(["selection", SELECTION_CACHE_SCHEMA_VERSION, parts.docId, parts.kind, parts.contextHash, parts.hasStructure,
    r.model, r.promptVersion, r.temperature, r.maxTokens, r.maxChars, r.outputVersion]);
}
export async function hashSelectionContext(selection: SelectionInput): Promise<string> {
  const context = selection.kind === "term"
    ? { text: selection.input.word, word: selection.input.word, sentence: selection.input.sentence,
      before: selection.input.context.previous, current: selection.input.context.current, after: selection.input.context.next }
    : { text: selection.input.text, word: "", before: selection.input.before, after: selection.input.after };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(context)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function keyParts(docId: string, selection: SelectionInput, runtime: SelectionCacheRuntime): Promise<SelectionCacheKeyParts> {
  return { docId, kind: selection.kind, contextHash: await hashSelectionContext(selection), hasStructure: !!selection.input.structure?.trim(), runtime };
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
function openSelectionCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SELECTION_CACHE_DB, SELECTION_CACHE_SCHEMA_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(SELECTION_CACHE_STORE, { keyPath: "key" });
      store.createIndex("docId", "docId", { unique: false });
    };
    request.onblocked = () => { blocked = true; reject(new Error("划选缓存被占用")); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  });
}
const visibleChars = (text: string) => countChars(splitTerms(text).map(segment => segment.text).join(""));
function completeText(text: unknown, runtime: SelectionCacheRuntime): text is string {
  return typeof text === "string" && countChars(text) > 0 && visibleChars(text) <= runtime.maxChars &&
    !text.trimStart().startsWith("【无法作答】") && !text.trimStart().startsWith("【无法处理】");
}

/** 每次关闭连接；浏览器禁用缓存、配额不足或记录损坏时照常生成，不抛给阅读器。 */
export async function readSelectionCache(docId: string, selection: SelectionInput, runtime?: SelectionCacheRuntime): Promise<string | null> {
  try {
    runtime ??= selectionCacheRuntime(selection);
    const parts = await keyParts(docId, selection, runtime), key = makeSelectionCacheKey(parts);
    const db = await openSelectionCache();
    try {
      const transaction = db.transaction(SELECTION_CACHE_STORE, "readonly");
      const done = transactionDone(transaction);
      const [entry] = await Promise.all([requestResult(transaction.objectStore(SELECTION_CACHE_STORE).get(key) as IDBRequest<SelectionCacheRecord | undefined>), done]);
      if (!entry || entry.schemaVersion !== SELECTION_CACHE_SCHEMA_VERSION || entry.docId !== docId ||
        entry.kind !== selection.kind || entry.key !== key || makeSelectionCacheKey(entry) !== key || !completeText(entry.text, runtime)) return null;
      return entry.text;
    } finally { db.close(); }
  } catch { return null; }
}

/** 只追加完整成功结果；失败、拒答、中止和半成品都不能进入缓存。 */
export async function saveSelectionCache(docId: string, selection: SelectionInput, result: GlossResult, runtime?: SelectionCacheRuntime): Promise<boolean> {
  if (result.status !== "done") return false;
  try {
    runtime ??= selectionCacheRuntime(selection);
    if (!completeText(result.text, runtime)) return false;
    const parts = await keyParts(docId, selection, runtime);
    const entry: SelectionCacheRecord = { ...parts, key: makeSelectionCacheKey(parts), schemaVersion: SELECTION_CACHE_SCHEMA_VERSION, text: result.text, savedAt: Date.now() };
    const db = await openSelectionCache();
    try {
      const transaction = db.transaction(SELECTION_CACHE_STORE, "readwrite");
      const done = transactionDone(transaction);
      await Promise.all([requestResult(transaction.objectStore(SELECTION_CACHE_STORE).add(entry)), done]);
      return true;
    } finally { db.close(); }
  } catch { return false; }
}
export function clearAllSelectionCache(): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const request = indexedDB.deleteDatabase(SELECTION_CACHE_DB);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch { resolve(false); }
  });
}
export async function clearSelectionCacheForDocument(docId: string): Promise<boolean> {
  try {
    const db = await openSelectionCache();
    try {
      const transaction = db.transaction(SELECTION_CACHE_STORE, "readwrite");
      const done = transactionDone(transaction);
      const cursorRequest = transaction.objectStore(SELECTION_CACHE_STORE).index("docId").openCursor(IDBKeyRange.only(docId));
      const deleted = new Promise<void>((resolve, reject) => {
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) { resolve(); return; }
          cursor.delete(); cursor.continue();
        };
      });
      await Promise.all([deleted, done]); return true;
    } finally { db.close(); }
  } catch { return false; }
}
