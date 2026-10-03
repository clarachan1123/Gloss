export const ANALYTICS_PREFIX = "gloss:analytics:v1:";
export const ANALYTICS_TTL_SECONDS = 5_184_000;
export const ANALYTICS_MAX_BATCH = 50;
export const ANALYTICS_MAX_BODY_BYTES = 16 * 1024;
export const ANALYTICS_LOCAL_KEY = "gloss:analytics:local:v1";
export const ANALYTICS_OPTOUT_KEY = "gloss:analytics:optout";

type Check = (value: unknown) => boolean;
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const bool = (value: unknown) => typeof value === "boolean";
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value);
const nullable = (check: Check): Check => (value) => value === null || check(value);
const short = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 80;
const fileSize = oneOf("0", "1-100KiB", "100KiB-1MiB", "1-5MiB", "5-20MiB", ">20MiB");
const parseChars = oneOf("0", "1-1000", "1001-5000", "5001-20000", "20001-50000", ">50000");
const sentenceCount = oneOf("0", "1-20", "21-100", "101-500", "501-2000", ">2000");
const sentenceChars = oneOf("0", "1-40", "41-80", "81-150", ">150");
const glossChars = oneOf("0", "1-50", "51-100", "101-150", ">150");
const format = oneOf("pdf", "docx", "txt", "paste", "unsupported");
const index = (value: unknown) => integer(value) && (value as number) <= 100_000;
const warnings = (value: unknown) => Array.isArray(value) && value.length <= 2 &&
  new Set(value).size === value.length && value.every((code) => code === "A6" || code === "A9");
const daysSinceOpen = oneOf("never", "0", "1", "2-7", "8-30", ">30");
export const DISMISS_EARLY_MS = 2_000;

const fields: Record<string, Record<string, Check>> = {
  reader_first_seen: {},
  reader_return_7d: { dayOffset: (value) => integer(value) && (value as number) >= 1 && (value as number) <= 7 },
  doc_reopen_7d: { dayOffset: (value) => integer(value) && (value as number) >= 1 && (value as number) <= 7 },
  doc_upload_attempt: { format, fileSizeBucket: nullable(fileSize) },
  doc_upload_reject: { rejectCode: oneOf("A1", "A2", "A3", "A4", "A5", "A7", "A8") },
  doc_parse_complete: {
    format,
    fileSizeBucket: nullable(fileSize),
    parseCharsBucket: parseChars,
    sentenceCountBucket: sentenceCount,
    parseMs: finite,
    aiSegmented: bool,
    warningCodes: warnings,
  },
  sentence_click: { sentenceIndex: index, sentenceCharsBucket: sentenceChars, cacheHit: bool },
  sentence_reclick: { sentenceIndex: index, reclickOrdinal: (value) => integer(value) && (value as number) >= 2 },
  gloss_first_token: { sentenceIndex: index, firstTokenMs: finite, cacheHit: (value) => value === false },
  gloss_complete: { sentenceIndex: index, cacheHit: bool, durationMs: finite, glossCharsBucket: glossChars },
  gloss_overlength: { overlength: (value) => value === true, model: short, promptVersion: short },
  gloss_read_complete: {
    sentenceIndex: index,
    visibleMs: finite,
    bottomSeen: (value) => value === true,
    glossCharsBucket: glossChars,
  },
  gloss_dismiss_early: { sentenceIndex: index, visibleMs: (value) => finite(value) && (value as number) < DISMISS_EARLY_MS },
  gloss_abort: { sentenceIndex: index, abortPhase: oneOf("waiting", "streaming") },
  gloss_fail: {
    sentenceIndex: index,
    failureCode: oneOf("C1", "C2", "C3", "C4", "C6", "D1", "D2", "OTHER"),
    limitSource: nullable(oneOf("waf", "upstream")),
  },
  deep_explain_click: { sentenceIndex: index, source: oneOf("action_row", "context_menu") },
  deep_explain_blocked: { sentenceIndex: index },
  report_error_click: { sentenceIndex: index },
  gloss_save: { sentenceIndex: index, edited: (value) => value === false },
  reader_enter: { source: oneOf("shelf", "upload", "direct"), positionRestored: bool },
  shelf_book_click: { entry: oneOf("continue", "cover", "start"), daysSinceOpenBucket: daysSinceOpen },
  ai_call: {
    callKind: oneOf("gloss", "structure", "explain"),
    attempt: (value) => integer(value) && (value as number) >= 1 && (value as number) <= 2,
    outcome: oneOf("done", "overlength", "error", "abort"),
    model: short,
    promptVersion: short,
    durationMs: finite,
    firstChunkMs: nullable(finite),
    cacheHitTokens: nullable(integer),
    cacheMissTokens: nullable(integer),
    completionTokens: nullable(integer),
    usageKnown: bool,
    failureCode: nullable(oneOf("C1", "C2", "C3", "C4", "C6", "OTHER")),
    abortPhase: nullable(oneOf("waiting", "streaming")),
  },
};

export type AnalyticsEventName = keyof typeof fields;
export type AnalyticsEvent = { event: AnalyticsEventName; eventId: string; [key: string]: unknown };
export type AnalyticsDetail = { event: AnalyticsEventName; [key: string]: unknown };

export const CLIENT_EVENTS = new Set([
  "reader_first_seen", "reader_return_7d", "doc_reopen_7d", "doc_upload_attempt", "doc_upload_reject",
  "doc_parse_complete", "sentence_click", "sentence_reclick", "gloss_first_token", "gloss_complete",
  "gloss_read_complete", "gloss_abort", "gloss_fail", "gloss_dismiss_early", "deep_explain_click",
  "deep_explain_blocked", "report_error_click", "gloss_save", "reader_enter", "shelf_book_click",
]);

export function nextAnalyticsBatch(events: readonly AnalyticsEvent[]): AnalyticsEvent[] {
  const batch: AnalyticsEvent[] = [];
  for (const event of events.slice(0, ANALYTICS_MAX_BATCH)) {
    if (new TextEncoder().encode(JSON.stringify({ events: [...batch, event] })).length > ANALYTICS_MAX_BODY_BYTES) break;
    batch.push(event);
  }
  return batch;
}

export function validateAnalyticsEvent(value: unknown, clientOnly = false): value is AnalyticsEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.event !== "string" || !Object.hasOwn(fields, record.event)) return false;
  if (clientOnly && !CLIENT_EVENTS.has(record.event)) return false;
  if (typeof record.eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.eventId)) return false;
  const schema = fields[record.event];
  const keys = Object.keys(record);
  if (keys.length !== Object.keys(schema).length + 2) return false;
  return Object.entries(schema).every(([key, check]) => Object.hasOwn(record, key) && check(record[key]));
}

export function validateAnalyticsBatch(value: unknown): value is { events: AnalyticsEvent[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const batch = value as Record<string, unknown>;
  return Object.keys(batch).length === 1 && Array.isArray(batch.events) && batch.events.length > 0 &&
    batch.events.length <= ANALYTICS_MAX_BATCH && batch.events.every((entry) => validateAnalyticsEvent(entry, true));
}

export function emitAnalytics(detail: AnalyticsDetail): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("gloss:analytics", { detail }));
}

export function fileSizeBucket(bytes: number): string {
  if (bytes === 0) return "0";
  if (bytes <= 100 * 1024) return "1-100KiB";
  if (bytes <= 1024 * 1024) return "100KiB-1MiB";
  if (bytes <= 5 * 1024 * 1024) return "1-5MiB";
  if (bytes <= 20 * 1024 * 1024) return "5-20MiB";
  return ">20MiB";
}

export function parseCharsBucket(count: number): string {
  if (count === 0) return "0";
  if (count <= 1000) return "1-1000";
  if (count <= 5000) return "1001-5000";
  if (count <= 20000) return "5001-20000";
  if (count <= 50000) return "20001-50000";
  return ">50000";
}

export function sentenceCharsBucket(count: number): string {
  if (count === 0) return "0";
  if (count <= 40) return "1-40";
  if (count <= 80) return "41-80";
  if (count <= 150) return "81-150";
  return ">150";
}

export function glossCharsBucket(count: number): string {
  if (count === 0) return "0";
  if (count <= 50) return "1-50";
  if (count <= 100) return "51-100";
  if (count <= 150) return "101-150";
  return ">150";
}

export function sentenceCountBucket(count: number): string {
  if (count === 0) return "0";
  if (count <= 20) return "1-20";
  if (count <= 100) return "21-100";
  if (count <= 500) return "101-500";
  if (count <= 2000) return "501-2000";
  return ">2000";
}
