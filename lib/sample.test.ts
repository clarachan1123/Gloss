// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import content from "../public/samples/shan-yu-e.json";
import { SAMPLE_BREATHED_KEY, SAMPLE_REMOVED_KEY, SAMPLE_SENTENCE_COUNT, hasSampleBreathed,
  isSampleRemoved, markSampleBreathed, parseSampleContent, removeSampleFromShelf } from "./sample";
import { segmentParagraphs } from "./segment";

describe("G-16a 随书内容", () => {
  afterEach(() => localStorage.clear());

  it("定稿内容用当前切句器得到 12 句，且每句恰好有一条白话", () => {
    const book = parseSampleContent(content);
    expect(book).not.toBeNull();
    const sentences = segmentParagraphs(book!.doc.paragraphs).sentences;
    expect(sentences).toHaveLength(SAMPLE_SENTENCE_COUNT);
    expect(book!.content.glosses).toHaveLength(sentences.length);
    expect(book!.content.placeholder).toBe(false);
    expect(book!.content.breatheSentenceIndex).toBe(10);
  });

  it("句数或白话数改变时拒绝整份示例，避免错位显示", () => {
    expect(parseSampleContent({ ...content, glosses: content.glosses.slice(1) })).toBeNull();
    expect(parseSampleContent({ ...content, paragraphs: ["只有一句。"] })).toBeNull();
  });

  it("书架移除与呼吸状态是独立持久键", () => {
    expect(isSampleRemoved()).toBe(false);
    expect(hasSampleBreathed()).toBe(false);
    expect(removeSampleFromShelf()).toBe(true);
    markSampleBreathed();
    expect(localStorage.getItem(SAMPLE_REMOVED_KEY)).toBe("1");
    expect(localStorage.getItem(SAMPLE_BREATHED_KEY)).toBe("1");
    expect(isSampleRemoved()).toBe(true);
    expect(hasSampleBreathed()).toBe(true);
  });
});
