import { describe, expect, it } from "vitest";
import { ANALYTICS_LOCAL_KEY, ANALYTICS_OPTOUT_KEY, nextAnalyticsBatch } from "./analytics-events";
import {
  daysSinceOpenBucket,
  enforceAnalyticsOptout,
  enqueueAnalytics,
  markAnalyticsImport,
  markAnalyticsOpen,
  markReaderEntry,
  pendingAnalytics,
  readAnalyticsState,
  takeReaderEntrySource,
  visitAnalytics,
} from "./analytics-local";

function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("analytics local state", () => {
  it.each([[0, false], [1, true], [7, true], [8, false]])("reader revisit day %i", (day, expected) => {
    const store = memoryStore();
    expect(visitAnalytics(new Date(2026, 8, 30), store)?.event).toBe("reader_first_seen");
    const returned = visitAnalytics(new Date(2026, 8, 30 + day), store);
    expect(returned?.event === "reader_return_7d").toBe(expected);
    if (expected) expect(visitAnalytics(new Date(2026, 8, 31 + day), store)?.event).not.toBe("reader_return_7d");
  });

  it.each([[0, false], [1, true], [7, true], [8, false]])("document reopen day %i", (day, expected) => {
    const store = memoryStore();
    markAnalyticsImport("local-only-doc", new Date(2026, 8, 30), store);
    markAnalyticsOpen("local-only-doc", new Date(2026, 8, 30), store);
    const returned = markAnalyticsOpen("local-only-doc", new Date(2026, 8, 30 + day), store);
    expect(returned?.event === "doc_reopen_7d").toBe(expected);
    if (expected) expect(markAnalyticsOpen("local-only-doc", new Date(2026, 8, 31 + day), store)?.event).not.toBe("doc_reopen_7d");
  });

  it("201 queued events retain the newest 200; 60 split into batches 50 and 10", () => {
    const store = memoryStore();
    const first = enqueueAnalytics({ event: "reader_first_seen" }, store);
    for (let index = 0; index < 200; index++) enqueueAnalytics({ event: "reader_first_seen" }, store);
    const events = readAnalyticsState(store)!.outbox;
    expect(events).toHaveLength(200);
    expect(events.some((event) => event.eventId === first?.eventId)).toBe(false);
    expect(nextAnalyticsBatch(events.slice(0, 60))).toHaveLength(50);
    expect(nextAnalyticsBatch(events.slice(50, 60))).toHaveLength(10);
  });

  it("drops old integer events from a mixed outbox and persists only new buckets", () => {
    const store = memoryStore();
    const metadata = {
      version: 1, firstUseDay: "2026-10-01", readerReturned: true,
      docs: { sample: { importDay: "2026-10-01", opened: true, returned: false } },
    };
    const oldEvent = { event: "sentence_click", eventId: crypto.randomUUID(), sentenceIndex: 0, sentenceChars: 3, cacheHit: false };
    const newEvent = { event: "sentence_click", eventId: crypto.randomUUID(), sentenceIndex: 1, sentenceCharsBucket: "1-40", cacheHit: false };
    store.setItem(ANALYTICS_LOCAL_KEY, JSON.stringify({ ...metadata, outbox: [oldEvent, newEvent] }));

    expect(pendingAnalytics(store)).toEqual([newEvent]);
    expect(JSON.parse(store.getItem(ANALYTICS_LOCAL_KEY)!)).toEqual({ ...metadata, outbox: [newEvent] });
  });

  it("G-16a 保留不带 sample 的旧 outbox 与带 sample 的新记录", () => {
    const store = memoryStore();
    const oldEvent = { event: "sentence_click", eventId: crypto.randomUUID(),
      sentenceIndex: 0, sentenceCharsBucket: "1-40", cacheHit: false };
    const sampleEvent = { ...oldEvent, eventId: crypto.randomUUID(), sentenceIndex: 5, sample: true };
    store.setItem(ANALYTICS_LOCAL_KEY, JSON.stringify({
      version: 1, firstUseDay: null, readerReturned: false, docs: {}, outbox: [oldEvent, sampleEvent],
    }));
    expect(pendingAnalytics(store)).toEqual([oldEvent, sampleEvent]);
    expect(enqueueAnalytics({ event: "sample_doc_enter", from: "direct" }, store)?.event).toBe("sample_doc_enter");
  });

  it("optout and storage write failure leave document keys untouched", () => {
    const store = memoryStore();
    store.setItem("gloss:document:sample", "keep");
    store.setItem(ANALYTICS_OPTOUT_KEY, "1");
    expect(visitAnalytics(new Date(), store)).toBeNull();
    expect(store.getItem(ANALYTICS_LOCAL_KEY)).toBeNull();
    store.removeItem(ANALYTICS_OPTOUT_KEY);
    const fullStore = { ...store, setItem: (_key: string, _value: string) => { throw new DOMException("full", "QuotaExceededError"); } } as Storage;
    expect(() => enqueueAnalytics({ event: "reader_first_seen" }, fullStore)).not.toThrow();
    expect(store.getItem("gloss:document:sample")).toBe("keep");
  });
});

describe("G-15b optout clears the queue", () => {
  it("drops queued records at the first check and never resends them after the switch is removed", () => {
    const store = memoryStore();
    visitAnalytics(new Date(2026, 8, 30), store);
    markAnalyticsImport("local-only-doc", new Date(2026, 8, 30), store);
    markAnalyticsOpen("local-only-doc", new Date(2026, 8, 30), store);
    enqueueAnalytics({ event: "report_error_click", sentenceIndex: 1 }, store);
    const before = readAnalyticsState(store)!;
    expect(before.outbox).toHaveLength(2);

    store.setItem(ANALYTICS_OPTOUT_KEY, "1");
    expect(pendingAnalytics(store)).toEqual([]);
    const cleared = readAnalyticsState(store)!;
    expect(cleared.outbox).toEqual([]);
    expect({ firstUseDay: cleared.firstUseDay, readerReturned: cleared.readerReturned, docs: cleared.docs })
      .toEqual({ firstUseDay: before.firstUseDay, readerReturned: before.readerReturned, docs: before.docs });
    expect(enqueueAnalytics({ event: "report_error_click", sentenceIndex: 2 }, store)).toBeNull();

    store.removeItem(ANALYTICS_OPTOUT_KEY);
    expect(pendingAnalytics(store)).toEqual([]);
  });

  it("reports whether the reader opted out and leaves an empty store unwritten", () => {
    const store = memoryStore();
    expect(enforceAnalyticsOptout(store)).toBe(false);
    store.setItem(ANALYTICS_OPTOUT_KEY, "1");
    expect(enforceAnalyticsOptout(store)).toBe(true);
    expect(store.getItem(ANALYTICS_LOCAL_KEY)).toBeNull();
  });
});

describe("G-15b shelf day bucket", () => {
  const opened = new Date(2026, 8, 30, 23, 59).getTime();
  const added = new Date(2026, 8, 20, 9, 0).getTime();
  it.each([
    [new Date(2026, 8, 30, 23, 59, 30), "0"],
    [new Date(2026, 9, 1, 0, 1), "1"],
    [new Date(2026, 9, 2), "2-7"],
    [new Date(2026, 9, 7), "2-7"],
    [new Date(2026, 9, 8), "8-30"],
    [new Date(2026, 9, 30), "8-30"],
    [new Date(2026, 9, 31), ">30"],
    [new Date(2026, 8, 29), "0"],
  ])("local day difference to %s is %s", (now, bucket) => {
    expect(daysSinceOpenBucket(opened, added, now)).toBe(bucket);
  });

  it.each([[undefined], [null], [Number.NaN], ["1700000000000"], [8.64e15 + 1]])("%s has no record", (value) => {
    expect(daysSinceOpenBucket(value, added, new Date(2026, 9, 1))).toBe("never");
  });

  it("导入后从未在阅读页打开（lastOpenedAt 等于 addedAt）记 never，差 1 毫秒即按天数分档", () => {
    const now = new Date(2026, 9, 1);
    expect(daysSinceOpenBucket(added, added, now)).toBe("never");
    expect(daysSinceOpenBucket(added + 1, added, now)).toBe("8-30");
    expect(daysSinceOpenBucket(opened, opened - 1, now)).toBe("1");
  });

  it.each([[undefined], [null], [Number.NaN], ["1700000000000"]])("addedAt 为 %s 时只按 lastOpenedAt 分档", (value) => {
    expect(daysSinceOpenBucket(opened, value, new Date(2026, 9, 1))).toBe("1");
  });
});

describe("G-15b reader entry marker", () => {
  it("is one-shot and only applies to the document it was set for", () => {
    markReaderEntry("doc-a", "shelf");
    expect(takeReaderEntrySource("doc-a")).toBe("shelf");
    expect(takeReaderEntrySource("doc-a")).toBe("direct");
    markReaderEntry("doc-a", "upload");
    expect(takeReaderEntrySource("doc-b")).toBe("direct");
    expect(takeReaderEntrySource("doc-a")).toBe("direct");
  });
});
