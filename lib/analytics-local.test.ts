import { describe, expect, it } from "vitest";
import { ANALYTICS_LOCAL_KEY, ANALYTICS_OPTOUT_KEY, nextAnalyticsBatch } from "./analytics-events";
import { enqueueAnalytics, markAnalyticsImport, markAnalyticsOpen, readAnalyticsState, visitAnalytics } from "./analytics-local";

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
