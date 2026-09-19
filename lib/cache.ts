import type { GlossInput } from "./gloss-client";
import { MODEL_FAST } from "./models";
import { GLOSS_MAX_TOKENS, GLOSS_PROMPT_VERSION, GLOSS_TEMPERATURE } from "./prompts/gloss";
import { STRUCTURE_PROMPT_VERSION } from "./prompts/structure";
import { GLOSS_OUTPUT_VERSION } from "./output";

export const GLOSS_CACHE_DB = "gloss-auto-cache";
export const GLOSS_CACHE_STORE = "ai-gloss-auto-cache";
export const GLOSS_CACHE_SCHEMA_VERSION = 1;

export interface GlossCacheRuntime {
  model: string;
  promptVersion: string;
  structurePromptVersion: string;
  temperature: number;
  maxTokens: number;
  outputVersion: string;
}

export const CURRENT_GLOSS_CACHE_RUNTIME: GlossCacheRuntime = {
  model: MODEL_FAST,
  promptVersion: GLOSS_PROMPT_VERSION,
  structurePromptVersion: STRUCTURE_PROMPT_VERSION,
  temperature: GLOSS_TEMPERATURE,
  maxTokens: GLOSS_MAX_TOKENS,
  outputVersion: GLOSS_OUTPUT_VERSION,
};

export interface GlossCacheKeyParts {
  docId: string;
  contextHash: string;
  hasStructure: boolean;
  runtime: GlossCacheRuntime;
}

export interface GlossCacheRecord extends GlossCacheKeyParts {
  key: string;
  schemaVersion: number;
  text: string;
  /** 仅诊断结构摘要是否变过；不参与 key。 */
  structureHash: string | null;
  savedAt: number;
}

export interface PreloadedGloss {
  text: string;
  hasStructure: boolean;
}

export interface MemoryGloss extends PreloadedGloss {
  source: "preload" | "session";
  shown: boolean;
}

/** 预载只填本会话尚无的句子，绝不覆盖已生成 / 已展示的白话。 */
export function mergePreloadedGlosses(
  memory: Map<number, MemoryGloss>,
  preloaded: ReadonlyMap<number, PreloadedGloss>,
): void {
  for (const [index, entry] of preloaded) {
    const existing = memory.get(index);
    if (!existing) {
      memory.set(index, { ...entry, source: "preload", shown: false });
    } else if (existing.source === "preload" && !existing.shown && !existing.hasStructure && entry.hasStructure) {
      // R2：摘要后来就绪时，用优先级更高的带摘要预载替换尚未展示的无摘要预载。
      memory.set(index, { ...entry, source: "preload", shown: false });
    }
  }
}

/** G-15 接入埋点时使用；本卡只暴露结果，不建立客户端埋点通道。 */
export type GlossCacheLookup =
  | { status: "hit"; entry: PreloadedGloss }
  | { status: "miss" };

export function lookupPreloadedGloss(
  entries: ReadonlyMap<number, PreloadedGloss>,
  index: number,
  _hasStructure: boolean,
): GlossCacheLookup {
  const entry = entries.get(index);
  // R2：无论当前摘要状态，优先带摘要；没有才回退到无摘要，避免重开书后二次生成。
  if (!entry) return { status: "miss" };
  return { status: "hit", entry };
}

export interface GlossCacheInput {
  index: number;
  input: GlossInput;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 不折叠空白：此 JSON 就是实际 /api/gloss 请求中的三个文本字段。 */
export function serializeGlossContext(input: Pick<GlossInput, "sentence" | "before" | "after">): string {
  return JSON.stringify({ sentence: input.sentence, before: input.before, after: input.after });
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

export async function hashGlossContext(input: Pick<GlossInput, "sentence" | "before" | "after">): Promise<string> {
  return sha256(serializeGlossContext(input));
}

export function makeGlossCacheKey({ docId, contextHash, hasStructure, runtime }: GlossCacheKeyParts): string {
  return [
    "gac",
    GLOSS_CACHE_SCHEMA_VERSION,
    runtime.outputVersion,
    runtime.maxTokens,
    docId,
    contextHash,
    runtime.promptVersion,
    runtime.structurePromptVersion,
    runtime.temperature,
    runtime.model,
    hasStructure ? "structure" : "no-structure",
  ].join(":");
}

function isCurrent(record: GlossCacheRecord, runtime: GlossCacheRuntime): boolean {
  return (
    record.schemaVersion === GLOSS_CACHE_SCHEMA_VERSION &&
    record.runtime.outputVersion === runtime.outputVersion &&
    record.runtime.maxTokens === runtime.maxTokens &&
    record.runtime.promptVersion === runtime.promptVersion &&
    record.runtime.structurePromptVersion === runtime.structurePromptVersion &&
    record.runtime.temperature === runtime.temperature &&
    record.runtime.model === runtime.model
  );
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(GLOSS_CACHE_DB, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      const store = db.createObjectStore(GLOSS_CACHE_STORE, { keyPath: "key" });
      store.createIndex("docId", "docId", { unique: false });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** 清除全部浏览器自动缓存；不触碰 localStorage 中的保存白话、原文、位置或结构摘要。 */
export function clearAllGlossCache(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(GLOSS_CACHE_DB);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export function selectRecord(
  records: readonly GlossCacheRecord[],
  docId: string,
  contextHash: string,
  runtime: GlossCacheRuntime,
  _currentHasStructure: boolean,
): PreloadedGloss | null {
  const withStructureKey = makeGlossCacheKey({ docId, contextHash, runtime, hasStructure: true });
  const withoutStructureKey = makeGlossCacheKey({ docId, contextHash, runtime, hasStructure: false });
  const withStructure = records.find((record) => record.key === withStructureKey);
  if (withStructure) return { text: withStructure.text, hasStructure: true };
  const withoutStructure = records.find((record) => record.key === withoutStructureKey);
  return withoutStructure ? { text: withoutStructure.text, hasStructure: false } : null;
}

/**
 * 预载只写 ref 的调用方内存，不触发 React state。无论当前摘要状态都优先带摘要条目；没有才取无摘要条目。
 */
export async function preloadGlossCache(
  docId: string,
  inputs: readonly GlossCacheInput[],
  currentStructure: string | null,
  runtime: GlossCacheRuntime = CURRENT_GLOSS_CACHE_RUNTIME,
): Promise<Map<number, PreloadedGloss>> {
  try {
    const db = await openCache();
    try {
      const transaction = db.transaction(GLOSS_CACHE_STORE, "readonly");
      const store = transaction.objectStore(GLOSS_CACHE_STORE);
      const records = (await request(store.index("docId").getAll(docId))) as GlossCacheRecord[];
      await transactionDone(transaction);
      const current = records.filter((record) => isCurrent(record, runtime));
      const hasStructure = currentStructure !== null;
      const out = new Map<number, PreloadedGloss>();
      const hashes = await Promise.all(inputs.map(({ input }) => hashGlossContext(input)));
      for (let index = 0; index < inputs.length; index++) {
        const contextHash = hashes[index];
        const value = selectRecord(current, docId, contextHash, runtime, hasStructure);
        if (value) out.set(inputs[index].index, value);
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

async function clearStaleEntries(store: IDBObjectStore, runtime: GlossCacheRuntime): Promise<void> {
  const records = (await request(store.getAll())) as GlossCacheRecord[];
  for (const record of records) {
    if (!isCurrent(record, runtime)) store.delete(record.key);
  }
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "ConstraintError";
}

export async function addRecord(store: IDBObjectStore, record: GlossCacheRecord): Promise<"added" | "exists" | "failed"> {
  try {
    await request(store.add(record));
    return "added";
  } catch (error) {
    if (isConstraintError(error)) return "exists";
    throw error;
  }
}

/** 只追加，从不覆盖已有同键白话。任何失败都返回 false，让阅读器继续正常显示本次结果。 */
export async function saveGlossCache(
  docId: string,
  input: GlossInput,
  text: string,
  runtime: GlossCacheRuntime = CURRENT_GLOSS_CACHE_RUNTIME,
): Promise<boolean> {
  try {
    const contextHash = await hashGlossContext(input);
    const hasStructure = input.structure !== null;
    const record: GlossCacheRecord = {
      key: makeGlossCacheKey({ docId, contextHash, hasStructure, runtime }),
      docId,
      contextHash,
      hasStructure,
      runtime,
      schemaVersion: GLOSS_CACHE_SCHEMA_VERSION,
      text,
      structureHash: input.structure === null ? null : await sha256(input.structure),
      savedAt: Date.now(),
    };
    const db = await openCache();
    try {
      let transaction = db.transaction(GLOSS_CACHE_STORE, "readwrite");
      let store = transaction.objectStore(GLOSS_CACHE_STORE);
      try {
        const result = await addRecord(store, record);
        await transactionDone(transaction);
        return result === "added";
      } catch (error) {
        try {
          transaction.abort();
        } catch {}
        if (!isQuotaError(error)) return false;
      }
      transaction = db.transaction(GLOSS_CACHE_STORE, "readwrite");
      store = transaction.objectStore(GLOSS_CACHE_STORE);
      await clearStaleEntries(store, runtime);
      const result = await addRecord(store, record);
      await transactionDone(transaction);
      return result === "added";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
