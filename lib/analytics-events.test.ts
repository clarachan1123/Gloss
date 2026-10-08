import { describe, expect, it } from "vitest";
import { CLIENT_EVENTS, glossCharsBucket, sentenceCharsBucket, validateAnalyticsEvent } from "./analytics-events";

const eventId = "00000000-0000-4000-8000-000000000000";
const valid: Record<string, Record<string, unknown>> = {
  deep_explain_click: { sentenceIndex: 3, source: "action_row" },
  deep_explain_blocked: { sentenceIndex: 3 },
  report_error_click: { sentenceIndex: 3 },
  gloss_save: { sentenceIndex: 3, edited: false },
  gloss_dismiss_early: { sentenceIndex: 3, visibleMs: 1_999 },
  reader_enter: { source: "shelf", positionRestored: true },
  landing_view: {},
  landing_cta_click: { target: "sample" },
  shelf_book_click: { entry: "cover", daysSinceOpenBucket: "2-7" },
};

describe("G-15b client event whitelist", () => {
  it.each(Object.entries(valid))("accepts %s with exactly its fields", (event, fields) => {
    expect(CLIENT_EVENTS.has(event)).toBe(true);
    expect(validateAnalyticsEvent({ event, eventId, ...fields }, true)).toBe(true);
  });

  it.each(Object.entries(valid))("rejects %s carrying text, title or docId", (event, fields) => {
    for (const extra of [{ sentence: "原句。" }, { gloss: "白话。" }, { title: "书名" }, { docId: "abc" }]) {
      expect(validateAnalyticsEvent({ event, eventId, ...fields, ...extra }, true)).toBe(false);
    }
  });

  it.each(Object.entries(valid))("rejects %s with a missing field", (event, fields) => {
    for (const key of Object.keys(fields)) {
      const partial = { ...fields };
      delete partial[key];
      expect(validateAnalyticsEvent({ event, eventId, ...partial }, true)).toBe(false);
    }
  });

  it.each([
    ["deep_explain_click", { sentenceIndex: 3, source: "右键" }],
    ["deep_explain_click", { sentenceIndex: 3, source: "retry" }],
    ["gloss_save", { sentenceIndex: 3, edited: true }],
    ["gloss_dismiss_early", { sentenceIndex: 3, visibleMs: 2_000 }],
    ["gloss_dismiss_early", { sentenceIndex: 3, visibleMs: -1 }],
    ["reader_enter", { source: "other", positionRestored: false }],
    ["landing_cta_click", { target: "other" }],
    ["reader_enter", { source: "direct", positionRestored: 1 }],
    ["shelf_book_click", { entry: "spine", daysSinceOpenBucket: "0" }],
    ["shelf_book_click", { entry: "start", daysSinceOpenBucket: "3" }],
    ["report_error_click", { sentenceIndex: "3" }],
  ])("rejects %s with an out-of-range value %j", (event, fields) => {
    expect(validateAnalyticsEvent({ event, eventId, ...fields }, true)).toBe(false);
  });

  it("server-only events stay out of browser batches", () => {
    expect(validateAnalyticsEvent({ event: "gloss_overlength", eventId, overlength: true,
      model: "m", promptVersion: "p" }, true)).toBe(false);
  });
});

describe("G-16a sample analytics", () => {
  const sampleFields: Record<string, Record<string, unknown>> = {
    sentence_click: { sentenceIndex: 5, sentenceCharsBucket: "41-80", cacheHit: false },
    sentence_reclick: { sentenceIndex: 5, reclickOrdinal: 2 },
    gloss_complete: { sentenceIndex: 5, cacheHit: false, durationMs: 900, glossCharsBucket: "51-100" },
    gloss_read_complete: { sentenceIndex: 5, visibleMs: 2000, bottomSeen: true, glossCharsBucket: "51-100" },
    gloss_dismiss_early: { sentenceIndex: 5, visibleMs: 500 },
    gloss_save: { sentenceIndex: 5, edited: false },
    deep_explain_click: { sentenceIndex: 5, source: "action_row" },
    deep_explain_blocked: { sentenceIndex: 5 },
    report_error_click: { sentenceIndex: 5 },
  };

  it.each(Object.entries(sampleFields))("accepts %s with or without optional sample field", (event, detail) => {
    expect(validateAnalyticsEvent({ event, eventId, ...detail }, true)).toBe(true);
    expect(validateAnalyticsEvent({ event, eventId, ...detail, sample: true }, true)).toBe(true);
    expect(validateAnalyticsEvent({ event, eventId, ...detail, sample: false }, true)).toBe(false);
    expect(validateAnalyticsEvent({ event, eventId, ...detail, sample: "true" }, true)).toBe(false);
  });

  it("sample_doc_enter accepts only shelf, landing or direct; other events reject sample", () => {
    expect(CLIENT_EVENTS.has("sample_doc_enter")).toBe(true);
    for (const from of ["shelf", "landing", "direct"]) {
      expect(validateAnalyticsEvent({ event: "sample_doc_enter", eventId, from }, true)).toBe(true);
    }
    expect(validateAnalyticsEvent({ event: "sample_doc_enter", eventId, from: "upload" }, true)).toBe(false);
    expect(validateAnalyticsEvent({ event: "reader_enter", eventId, source: "shelf", positionRestored: false, sample: true }, true)).toBe(false);
    expect(validateAnalyticsEvent({ event: "reader_enter", eventId, source: "landing", positionRestored: false }, true)).toBe(true);
  });
});

describe("G-50 length buckets", () => {
  it.each([
    [0, "0"], [1, "1-40"], [40, "1-40"], [41, "41-80"], [80, "41-80"],
    [81, "81-150"], [150, "81-150"], [151, ">150"],
  ])("sentenceCharsBucket(%i) is %s", (count, bucket) => {
    expect(sentenceCharsBucket(count)).toBe(bucket);
  });

  it.each([
    [0, "0"], [1, "1-50"], [50, "1-50"], [51, "51-100"], [100, "51-100"],
    [101, "101-150"], [150, "101-150"], [151, ">150"],
  ])("glossCharsBucket(%i) is %s", (count, bucket) => {
    expect(glossCharsBucket(count)).toBe(bucket);
  });

  it.each([
    ["sentence_click", { sentenceIndex: 0, sentenceCharsBucket: "1-40", cacheHit: false }, true],
    ["gloss_complete", { sentenceIndex: 0, cacheHit: false, durationMs: 10, glossCharsBucket: "1-50" }, true],
    ["gloss_read_complete", { sentenceIndex: 0, visibleMs: 2000, bottomSeen: true, glossCharsBucket: "101-150" }, true],
    ["gloss_overlength", { overlength: true, model: "m", promptVersion: "p" }, false],
  ] as const)("accepts %s with the new fields", (event, detail, clientOnly) => {
    expect(validateAnalyticsEvent({ event, eventId, ...detail }, clientOnly)).toBe(true);
  });

  it.each([
    ["sentence_click", { sentenceIndex: 0, sentenceChars: 3, cacheHit: false }, true],
    ["gloss_complete", { sentenceIndex: 0, cacheHit: false, durationMs: 10, glossChars: 3 }, true],
    ["gloss_read_complete", { sentenceIndex: 0, visibleMs: 2000, bottomSeen: true, glossChars: 3 }, true],
    ["gloss_overlength", { overlength: true, outputChars: 150, model: "m", promptVersion: "p" }, false],
  ] as const)("rejects %s with the old integer field", (event, detail, clientOnly) => {
    expect(validateAnalyticsEvent({ event, eventId, ...detail }, clientOnly)).toBe(false);
  });

  it.each([
    ["sentence_click", { sentenceIndex: 0, sentenceCharsBucket: "1-50", cacheHit: false }],
    ["gloss_complete", { sentenceIndex: 0, cacheHit: false, durationMs: 10, glossCharsBucket: "1-40" }],
    ["gloss_read_complete", { sentenceIndex: 0, visibleMs: 2000, bottomSeen: true, glossCharsBucket: "150" }],
  ])("rejects %s with an unlisted bucket", (event, detail) => {
    expect(validateAnalyticsEvent({ event, eventId, ...detail }, true)).toBe(false);
  });
});
