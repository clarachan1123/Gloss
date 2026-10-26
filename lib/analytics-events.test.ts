import { describe, expect, it } from "vitest";
import { CLIENT_EVENTS, parseCharsBucket, sentenceCountBucket, glossCharsBucket, sentenceCharsBucket, validateAnalyticsEvent } from "./analytics-events";

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


describe("G-61 import buckets", () => {
  it.each([[50000,"20001-50000"],[50001,"50001-100000"],[100000,"50001-100000"],[100001,"100001-200000"],[200000,"100001-200000"]] as const)("parseCharsBucket(%i) is %s", (n, bucket) => {
    expect(parseCharsBucket(n)).toBe(bucket);
  });
  it.each([[2000,"501-2000"],[2001,"2001-5000"],[5000,"2001-5000"],[5001,">5000"]] as const)("sentenceCountBucket(%i) is %s", (n, bucket) => {
    expect(sentenceCountBucket(n)).toBe(bucket);
  });
  it("导入事件白名单同时接受新旧分档", () => {
    for (const parseCharsBucket of ["50001-100000", "100001-200000", ">50000"]) {
      for (const sentenceCountBucket of ["2001-5000", ">5000", ">2000"]) {
        const event = { event: "doc_parse_complete", eventId, format: "paste", fileSizeBucket: null,
          parseCharsBucket, sentenceCountBucket, parseMs: 1, aiSegmented: false, warningCodes: [] };
        expect(validateAnalyticsEvent(event, true)).toBe(true);
        expect(validateAnalyticsEvent(event, false)).toBe(true);
      }
    }
  });
});
describe("划选服务端调用类型", () => {
  const detail = { event:"ai_call", eventId, attempt:1, outcome:"done", model:"deepseek-flash", promptVersion:"term-v0",
    durationMs:100,firstChunkMs:20,cacheHitTokens:1,cacheMissTokens:2,completionTokens:3,usageKnown:true,failureCode:null,abortPhase:null };
  it.each(["term","range"])("接收服务端 %s，但不加入客户端白名单",callKind=>{
    expect(validateAnalyticsEvent({...detail,callKind})).toBe(true);
    expect(validateAnalyticsEvent({...detail,callKind},true)).toBe(false);
    for(const extra of [{sentence:"源句"},{text:"结果"},{docId:"书"},{title:"书名"}]) expect(validateAnalyticsEvent({...detail,callKind,...extra})).toBe(false);
  });
  it("既有调用类型及严格字段保持不变",()=>{
    for(const callKind of ["gloss","structure","explain"]) expect(validateAnalyticsEvent({...detail,callKind})).toBe(true);
    expect(validateAnalyticsEvent({...detail,callKind:"selection"})).toBe(false);
  });
});

describe("G-64a 划选客户端白名单",()=>{
  const base={eventId};
  const cases=[
    {event:"selection_mode_enter",pointer:"touch"},
    {event:"selection_confirm",resultKind:"term",charsBucket:"1-12",sentenceCountBucket:"1"},
    {event:"selection_result",resultKind:"range",outcome:"cached"},
    {event:"selection_save",resultKind:"term"},
  ];
  it.each(cases)("只接受 $event 指定字段",detail=>{
    expect(CLIENT_EVENTS.has(detail.event)).toBe(true);expect(validateAnalyticsEvent({...base,...detail},true)).toBe(true);
    for(const extra of [{text:"原文"},{docId:"文档"},{start:0},{sourceHash:"hash"}])expect(validateAnalyticsEvent({...base,...detail,...extra},true)).toBe(false);
  });
  it("退出开关丢弃新事件队列",async()=>{
    const {enqueueAnalytics}=await import("./analytics-local");
    const memory=new Map<string,string>([["gloss:analytics:optout","1"]]);
    const store={getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>void memory.set(k,v),removeItem:(k:string)=>void memory.delete(k)} as Storage;
    for(const detail of cases)expect(enqueueAnalytics(detail,store)).toBeNull();
  });
});
