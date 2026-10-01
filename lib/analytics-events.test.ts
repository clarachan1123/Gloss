import { describe, expect, it } from "vitest";
import { CLIENT_EVENTS, validateAnalyticsEvent } from "./analytics-events";

const eventId = "00000000-0000-4000-8000-000000000000";
const valid: Record<string, Record<string, unknown>> = {
  deep_explain_click: { sentenceIndex: 3, source: "action_row" },
  deep_explain_blocked: { sentenceIndex: 3 },
  report_error_click: { sentenceIndex: 3 },
  gloss_save: { sentenceIndex: 3, edited: false },
  gloss_dismiss_early: { sentenceIndex: 3, visibleMs: 1_999 },
  reader_enter: { source: "shelf", positionRestored: true },
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
    ["reader_enter", { source: "direct", positionRestored: 1 }],
    ["shelf_book_click", { entry: "spine", daysSinceOpenBucket: "0" }],
    ["shelf_book_click", { entry: "start", daysSinceOpenBucket: "3" }],
    ["report_error_click", { sentenceIndex: "3" }],
  ])("rejects %s with an out-of-range value %j", (event, fields) => {
    expect(validateAnalyticsEvent({ event, eventId, ...fields }, true)).toBe(false);
  });

  it("server-only events stay out of browser batches", () => {
    expect(validateAnalyticsEvent({ event: "gloss_overlength", eventId, overlength: true, outputChars: 1,
      model: "m", promptVersion: "p" }, true)).toBe(false);
  });
});
