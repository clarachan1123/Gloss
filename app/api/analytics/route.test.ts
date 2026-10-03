import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_MAX_BODY_BYTES, ANALYTICS_MAX_BATCH } from "@/lib/analytics-events";
import { createAnalyticsPost } from "./route";

const event = () => ({ event: "reader_first_seen", eventId: crypto.randomUUID() });
const request = (value: unknown) => new Request("http://localhost/api/analytics", { method: "POST", body: JSON.stringify(value) });

describe("POST /api/analytics", () => {
  it("validates while disabled and writes nothing", async () => {
    const set = vi.fn(async () => "OK");
    const post = createAnalyticsPost({ enabled: () => false, store: () => ({ set }) });
    expect((await post(request({ events: [event()] }))).status).toBe(204);
    expect((await post(request({ events: [{ ...event(), sentence: "private text" }] }))).status).toBe(400);
    expect(set).toHaveBeenCalledTimes(0);
  });

  it("rejects an oversized body and overfull batch as whole requests", async () => {
    const set = vi.fn(async () => "OK");
    const post = createAnalyticsPost({ enabled: () => true, store: () => ({ set }) });
    expect((await post(request({ events: Array.from({ length: ANALYTICS_MAX_BATCH + 1 }, event) }))).status).toBe(400);
    const oversized = new Request("http://localhost/api/analytics", { method: "POST", body: "x".repeat(ANALYTICS_MAX_BODY_BYTES + 1) });
    expect((await post(oversized)).status).toBe(413);
    expect(set).toHaveBeenCalledTimes(0);
  });

  it("rejects a batch containing one old integer event without writing its valid neighbor", async () => {
    const set = vi.fn(async () => "OK");
    const post = createAnalyticsPost({ enabled: () => true, store: () => ({ set }) });
    const valid = { event: "sentence_click", eventId: crypto.randomUUID(), sentenceIndex: 0, sentenceCharsBucket: "1-40", cacheHit: false };
    const old = { event: "sentence_click", eventId: crypto.randomUUID(), sentenceIndex: 1, sentenceChars: 3, cacheHit: false };
    expect((await post(request({ events: [valid, old] }))).status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it("sets one event key with NX and a 60-day TTL", async () => {
    const set = vi.fn(async () => "OK");
    const post = createAnalyticsPost({ enabled: () => true, store: () => ({ set }) });
    const entry = event();
    expect((await post(request({ events: [entry] }))).status).toBe(204);
    expect(set).toHaveBeenCalledWith(`gloss:analytics:v1:${entry.eventId}`,
      expect.objectContaining({ ...entry, createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/) }),
      { ex: 5_184_000, nx: true });
  });
});
