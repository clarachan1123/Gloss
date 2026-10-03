import {
  ANALYTICS_LOCAL_KEY,
  ANALYTICS_OPTOUT_KEY,
  CLIENT_EVENTS,
  type AnalyticsDetail,
  type AnalyticsEvent,
  validateAnalyticsEvent,
} from "./analytics-events";

export const ANALYTICS_MAX_LOCAL_EVENTS = 200;

interface LocalDoc {
  importDay: string | null;
  opened: boolean;
  returned: boolean;
}

export interface AnalyticsLocalState {
  version: 1;
  firstUseDay: string | null;
  readerReturned: boolean;
  docs: Record<string, LocalDoc>;
  outbox: AnalyticsEvent[];
}

const empty = (): AnalyticsLocalState => ({ version: 1, firstUseDay: null, readerReturned: false, docs: {}, outbox: [] });
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localDayDifference(from: string, to: string): number | null {
  if (!dayPattern.test(from) || !dayPattern.test(to)) return null;
  const ordinal = (day: string) => {
    const [year, month, date] = day.split("-").map(Number);
    const parsed = new Date(year, month - 1, date);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== date) return null;
    return Date.UTC(year, month - 1, date) / 86_400_000;
  };
  const first = ordinal(from);
  const last = ordinal(to);
  return first === null || last === null ? null : last - first;
}

function availableStorage(storage?: Storage): Storage | null {
  try { return storage ?? globalThis.localStorage; } catch { return null; }
}

export function isAnalyticsOptedOut(storage?: Storage): boolean {
  try {
    const target = availableStorage(storage);
    return !target || target.getItem(ANALYTICS_OPTOUT_KEY) === "1";
  } catch {
    // A blocked store cannot tell us whether the reader opted out.
    return true;
  }
}

/** Every opt-out check also drops queued records, so turning the switch off later cannot resend them. */
export function enforceAnalyticsOptout(storage?: Storage): boolean {
  const optedOut = isAnalyticsOptedOut(storage);
  if (optedOut) clearAnalyticsOutbox(storage);
  return optedOut;
}

export function readAnalyticsState(storage?: Storage): AnalyticsLocalState | null {
  try {
    const raw = availableStorage(storage)?.getItem(ANALYTICS_LOCAL_KEY);
    if (raw === undefined) return null;
    if (raw === null) return empty();
    const value = JSON.parse(raw) as Partial<AnalyticsLocalState> | null;
    if (value?.version !== 1 || !Array.isArray(value.outbox) || !value.docs || typeof value.docs !== "object" ||
        !(value.firstUseDay === null || typeof value.firstUseDay === "string") || typeof value.readerReturned !== "boolean") return null;
    const state: AnalyticsLocalState = {
      version: 1,
      firstUseDay: value.firstUseDay,
      readerReturned: value.readerReturned,
      docs: value.docs as Record<string, LocalDoc>,
      outbox: value.outbox.filter((entry) => validateAnalyticsEvent(entry, true)).slice(-ANALYTICS_MAX_LOCAL_EVENTS),
    };
    if (state.outbox.length < value.outbox.length) {
      const target = availableStorage(storage);
      if (target) commit(target, state);
    }
    return state;
  } catch {
    return null;
  }
}

function commit(storage: Storage, state: AnalyticsLocalState): boolean {
  try {
    storage.setItem(ANALYTICS_LOCAL_KEY, JSON.stringify(state));
    return true;
  } catch {
    // Analytics must never evict documents, reading positions or saved glosses.
    return false;
  }
}

function eventFor(detail: AnalyticsDetail): AnalyticsEvent | null {
  if (!CLIENT_EVENTS.has(detail.event)) return null;
  try {
    const event = { ...detail, eventId: crypto.randomUUID() } as AnalyticsEvent;
    return validateAnalyticsEvent(event, true) ? event : null;
  } catch { return null; }
}

function append(state: AnalyticsLocalState, detail: AnalyticsDetail): AnalyticsEvent | null {
  const event = eventFor(detail);
  if (!event) return null;
  state.outbox = [...state.outbox, event].slice(-ANALYTICS_MAX_LOCAL_EVENTS);
  return event;
}

export function enqueueAnalytics(detail: AnalyticsDetail, providedStorage?: Storage): AnalyticsEvent | null {
  const storage = availableStorage(providedStorage);
  if (!storage || enforceAnalyticsOptout(storage)) return null;
  const state = readAnalyticsState(storage);
  if (!state) return null;
  const event = append(state, detail);
  return event && commit(storage, state) ? event : null;
}

export function visitAnalytics(now = new Date(), providedStorage?: Storage): AnalyticsEvent | null {
  const storage = availableStorage(providedStorage);
  if (!storage || enforceAnalyticsOptout(storage)) return null;
  const state = readAnalyticsState(storage);
  if (!state) return null;
  const today = localDay(now);
  let event: AnalyticsEvent | null = null;
  if (state.firstUseDay === null) {
    event = append(state, { event: "reader_first_seen" });
    if (!event) return null;
    state.firstUseDay = today;
  } else if (!state.readerReturned) {
    const difference = localDayDifference(state.firstUseDay, today);
    if (difference !== null && difference >= 1 && difference <= 7) {
      event = append(state, { event: "reader_return_7d", dayOffset: difference });
      if (!event) return null;
      state.readerReturned = true;
    }
  }
  return event && commit(storage, state) ? event : null;
}

export function markAnalyticsImport(docId: string, now = new Date(), providedStorage?: Storage): void {
  const storage = availableStorage(providedStorage);
  if (!storage || enforceAnalyticsOptout(storage)) return;
  const state = readAnalyticsState(storage);
  if (!state || !docId) return;
  state.docs[docId] ??= { importDay: localDay(now), opened: false, returned: false };
  commit(storage, state);
}

export function markAnalyticsOpen(docId: string, now = new Date(), providedStorage?: Storage): AnalyticsEvent | null {
  const storage = availableStorage(providedStorage);
  if (!storage || enforceAnalyticsOptout(storage)) return null;
  const state = readAnalyticsState(storage);
  if (!state || !docId) return null;
  const existing = state.docs[docId];
  const doc: LocalDoc = existing && typeof existing === "object" && typeof existing.opened === "boolean" &&
    typeof existing.returned === "boolean" && (existing.importDay === null || typeof existing.importDay === "string")
    ? existing : { importDay: null, opened: false, returned: false };
  let event: AnalyticsEvent | null = null;
  const difference = doc.importDay === null ? null : localDayDifference(doc.importDay, localDay(now));
  if (doc.opened && !doc.returned && difference !== null && difference >= 1 && difference <= 7) {
    event = append(state, { event: "doc_reopen_7d", dayOffset: difference });
    if (event) doc.returned = true;
  }
  doc.opened = true;
  state.docs[docId] = doc;
  return commit(storage, state) ? event : null;
}

export function pendingAnalytics(providedStorage?: Storage): AnalyticsEvent[] {
  const storage = availableStorage(providedStorage);
  if (!storage || enforceAnalyticsOptout(storage)) return [];
  return readAnalyticsState(storage)?.outbox ?? [];
}

export function acknowledgeAnalytics(ids: readonly string[], providedStorage?: Storage): boolean {
  const storage = availableStorage(providedStorage);
  if (!storage) return false;
  const state = readAnalyticsState(storage);
  if (!state) return false;
  const settled = new Set(ids);
  state.outbox = state.outbox.filter((event) => !settled.has(event.eventId));
  return commit(storage, state);
}

export function clearAnalyticsOutbox(providedStorage?: Storage): void {
  const storage = availableStorage(providedStorage);
  if (!storage) return;
  const state = readAnalyticsState(storage);
  if (!state || state.outbox.length === 0) return;
  state.outbox = [];
  commit(storage, state);
}

export type ReaderEntrySource = "shelf" | "upload" | "direct";

// In-memory and one-shot: never written to the URL or storage, and gone after a reload.
let pendingReaderEntry: { docId: string; source: Exclude<ReaderEntrySource, "direct"> } | null = null;

export function markReaderEntry(docId: string, source: Exclude<ReaderEntrySource, "direct">): void {
  pendingReaderEntry = { docId, source };
}

export function takeReaderEntrySource(docId: string): ReaderEntrySource {
  const pending = pendingReaderEntry;
  pendingReaderEntry = null;
  return pending?.docId === docId ? pending.source : "direct";
}

/** 书架条目导入时 lastOpenedAt 与 addedAt 同值，阅读页打开才会更新；两者相等即从未打开。 */
export function daysSinceOpenBucket(lastOpenedAt: unknown, addedAt: unknown, now = new Date()): string {
  if (typeof lastOpenedAt !== "number" || !Number.isFinite(lastOpenedAt) || lastOpenedAt === addedAt) return "never";
  const difference = localDayDifference(localDay(new Date(lastOpenedAt)), localDay(now));
  if (difference === null) return "never";
  if (difference <= 0) return "0";
  if (difference === 1) return "1";
  if (difference <= 7) return "2-7";
  if (difference <= 30) return "8-30";
  return ">30";
}
