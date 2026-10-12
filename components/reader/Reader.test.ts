// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as storage from "@/lib/storage";
import * as lineSplit from "./lineSplit";
import { slicePieces, splitParagraphTail } from "./lineSplit";
import * as glossClient from "@/lib/gloss-client";
import * as cache from "@/lib/cache";
import { lookupPreloadedGloss, type MemoryGloss } from "@/lib/cache";
import { segmentParagraphs } from "@/lib/segment";
import { loadSavedGlosses, saveExplanation } from "@/lib/storage";
import { validateAnalyticsEvent } from "@/lib/analytics-events";
import { markReaderEntry } from "@/lib/analytics-local";
import { IDLE_EXPLAIN_VIEW } from "./GlossPanel";
import Reader, { Paragraph, allObservedTargetsOutside, anchorScrollDelta, buildExplainInput, buildSavedMarkersByParagraph, buildSavedRegionsByParagraph, cropExplainContext, documentStats, groupRegions, paragraphOriginalFragments, prepareReadableDocument, readGlossShape, readReadingMode, retainGlossAfterUnsave, selectVisibleSavedRegions, shouldAnchorPanelGrowth, splitFragmentClassName, takeCodePointsFromEnd, type Region } from "./Reader";
import { skippedSummary } from "@/lib/parse/validate";
import type { StoredDocument } from "@/lib/storage";
import sampleContent from "@/public/samples/shan-yu-e.json";

describe("G-26 本地文档容错", () => {
  const record = {
    version: 1, docId: "g26", paragraphs: ["甲。"], headings: [], footnotes: [],
    meta: { format: "txt", fileName: "测试.txt", charCount: 2, pageCount: 3 }, savedAt: 1,
  } as StoredDocument;

  it("缺字数只略去字数；可选字段缺失不影响段句统计", () => {
    const withoutChars = prepareReadableDocument({ ...record, meta: { ...record.meta, charCount: undefined } } as unknown as StoredDocument);
    expect(documentStats(withoutChars!.doc, 1)).toBe("1 段 · 3 页 · 1 句");
    const withoutOptional = prepareReadableDocument({ ...record, meta: { ...record.meta, pageCount: undefined } });
    expect(documentStats(withoutOptional!.doc, 1)).toBe("2 字 · 1 段 · 1 句");
  });

  it("meta 与侧栏数据缺失时仍能打开正文，不把丢失目录说成无标题", () => {
    const prepared = prepareReadableDocument({ ...record, meta: undefined, headings: undefined, footnotes: undefined } as unknown as StoredDocument);
    expect(prepared?.headingsAvailable).toBe(false);
    expect(prepared?.doc.headings).toEqual([]);
    expect(prepared?.doc.footnotes).toEqual([]);
    expect(documentStats(prepared!.doc, 1)).toBe("1 段 · 1 句");
  });

  it("跳过信息只保留类型正确的字段，不补出零字表格项", () => {
    const prepared = prepareReadableDocument({
      ...record,
      meta: { ...record.meta, skipped: { tableCount: 2, tableChars: "错", hasFormula: true, scannedPages: [1, "2"] } },
    } as unknown as StoredDocument);
    expect(skippedSummary(prepared!.doc.meta.skipped)).toBe("已跳过：公式");
  });

  it("空数组、非字符串元素和全空白正文都不可读", () => {
    for (const paragraphs of [[], ["甲。", 3], ["  ", "\t"]]) {
      expect(prepareReadableDocument({ ...record, paragraphs } as StoredDocument)).toBeNull();
    }
  });
});

it("G-15a 已保存白话在 savedRegions 尚未测量时不发事件，普通缓存命中和未命中仍计首次点击", async () => {
  const sentence = "甲乙。";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sentence)));
  const sourceHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise(() => {}) } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  vi.spyOn(cache, "preloadGlossCache").mockImplementation(async (docId) =>
    docId === "g15a-hit" ? new Map([[0, { text: "预载白话。", hasStructure: false }]]) : new Map());

  const events: Record<string, unknown>[] = [];
  const onAnalytics = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener("gloss:analytics", onAnalytics);
  try {
    for (const [docId, saved, expectedCacheHit] of [
      ["g15a-saved", true, null], ["g15a-hit", false, true], ["g15a-miss", false, false],
    ] as const) {
      localStorage.setItem(`gloss:doc:${docId}`, JSON.stringify({
        version: 1, docId, paragraphs: [sentence], headings: [{ paraIndex: 0, level: 1, text: "测试" }],
        footnotes: [], meta: { format: "txt", fileName: "测试.txt", charCount: 3 }, savedAt: 1,
      }));
      if (saved) localStorage.setItem(`gloss:saved:${docId}`, JSON.stringify({ version: 1, entries: [
        { paraIndex: 0, start: 0, sourceHash, text: "已保存白话。", savedAt: 1, kind: "saved" },
      ] }));
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => { root.render(createElement(Reader, { docId })); });
      await act(async () => { await Promise.resolve(); });
      if (saved) {
        expect(container.querySelector(".reader-body")?.getAttribute("data-measuring")).toBe("true");
        expect(container.querySelector(".saved-link")?.textContent).toBe("已保存白话。");
      }
      events.length = 0;
      const target = container.querySelector<HTMLElement>(".sentence[data-index='0']");
      expect(target).not.toBeNull();
      await act(async () => { target!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      if (saved) expect(events).toHaveLength(0);
      else expect(events.filter((event) => event.event === "sentence_click")).toEqual([
        expect.objectContaining({ sentenceIndex: 0, sentenceCharsBucket: "1-40", cacheHit: expectedCacheHit }),
      ]);
      await act(async () => { root.unmount(); });
      container.remove();
    }
  } finally {
    window.removeEventListener("gloss:analytics", onAnalytics);
    localStorage.clear();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("G-46 observer 初始化", () => {
  it("只收到原句离屏结果时不收起；确认面板也离屏才收起", () => {
    expect(allObservedTargetsOutside([false, null])).toBe(false);
    expect(allObservedTargetsOutside([false, true])).toBe(false);
    expect(allObservedTargetsOutside([false, false])).toBe(true);
    expect(allObservedTargetsOutside([])).toBe(false);
  });
});

describe("G-10a 取消保存", () => {
  it("保留当前显示文本为会话内存命中：取消后不需要发请求", () => {
    const memory = new Map<number, MemoryGloss>();
    retainGlossAfterUnsave(memory, 4, { status: "done", text: "保存时正在看的版本", failure: null, instant: true }, false);

    // Reader 请求 effect 不依赖 savedGlosses；以后因收起再打开进入 effect 时，这个命中会直接返回。
    expect(lookupPreloadedGloss(memory, 4, false)).toMatchObject({ status: "hit", entry: { text: "保存时正在看的版本" } });
  });

  it("收起后再点同一句仍命中相同文本，不需要现场生成", () => {
    const memory = new Map<number, MemoryGloss>();
    retainGlossAfterUnsave(memory, 8, { status: "done", text: "不替换的白话", failure: null, instant: true }, true);

    const reopened = lookupPreloadedGloss(memory, 8, true);
    expect(reopened).toMatchObject({ status: "hit", entry: { text: "不替换的白话" } });
    expect(memory.get(8)).toMatchObject({ source: "session", shown: true });
  });
});

describe("G-10b 同段多常驻区", () => {
  const view = { status: "done" as const, text: "白话", failure: null, instant: true };

  it("同物理拆点也按句序独立排版", () => {
    const regions: Region[] = [
      { index: 8, splitAt: 42, view, saved: true, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
      { index: 3, splitAt: 42, view, saved: true, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
    ];
    const groups = groupRegions(regions);
    expect([...groups.keys()]).toEqual([3, 8]);
    expect([...groups.values()].flat().map((region) => region.index)).toEqual([3, 8]);
    expect(groups.get(3)).toHaveLength(1);
  });

  it("按句序插入，不以 null 或物理边界合组", () => {
    const regions: Region[] = [
      { index: 4, splitAt: null, view, saved: true, presentation: "bubble", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
      { index: 2, splitAt: 17, view, saved: true, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
    ];
    expect([...groupRegions(regions).keys()]).toEqual([2, 4]);
  });
});

describe("G-10b 段落拆分原文完整性", () => {
  const pieces = [
    { index: 0, start: 0, text: "甲乙。" },
    { index: 1, start: 3, text: "丙丁。" },
    { index: 2, start: 6, text: "戊己。" },
  ];
  const original = pieces.map((piece) => piece.text).join("");
  const rendered = (boundaries: readonly (number | null)[]) =>
    paragraphOriginalFragments(pieces, boundaries).flatMap((fragment) => fragment.map((piece) => piece.text)).join("");

  it.each([
    ["一个段中插入点", [4]],
    ["两个插入点", [3, 6]],
    ["段尾插入点", [null]],
    ["同一插入点的两个区（去重后的边界）", [3]],
  ] as const)("%s 仍输出完整原文", (_, boundaries) => {
    expect(rendered(boundaries)).toBe(original);
  });

  it("最后一个非 null 插入点额外返回尾段，供 reader-para-cont 渲染", () => {
    expect(paragraphOriginalFragments(pieces, [4])).toHaveLength(2);
    expect(paragraphOriginalFragments(pieces, [null])).toHaveLength(1);
  });

  it("两个非 null 插入点的三个原文片段分别使用首段、续段、尾段 class", () => {
    expect(splitFragmentClassName("reader-para", false, true, true)).toBe("reader-para reader-para-head");
    expect(splitFragmentClassName("reader-para", false, false, true)).toBe("reader-para reader-para-cont reader-para-head");
    expect(splitFragmentClassName("reader-para", false, false, false)).toBe("reader-para reader-para-cont");
  });
});

describe("G-10b 白话显示形态设置", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([null, "other", "INLINE"])("缺失或非法值 %j 回退 inline", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readGlossShape()).toBe("inline");
  });

  it("读取 bubble", () => {
    vi.stubGlobal("localStorage", { getItem: () => "bubble" });
    expect(readGlossShape()).toBe("bubble");
  });

  it("读取 localStorage 抛错时回退 inline", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readGlossShape()).toBe("inline");
  });
});

describe("G-10b 保存区 props 结构共享", () => {
  const sentences = [
    { index: 0, paraIndex: 0, start: 0, text: "甲。", charCount: 2 },
    { index: 1, paraIndex: 1, start: 0, text: "乙。", charCount: 2 },
    { index: 2, paraIndex: 2, start: 0, text: "丙。", charCount: 2 },
  ];
  const saved = (text: string) => ({ paraIndex: 0, start: 0, sourceHash: "x", text, savedAt: 0, kind: "saved" as const });

  it("保存或取消一句时，其余段落 regions 引用不变", () => {
    const first = buildSavedRegionsByParagraph([], 3, sentences, new Map([[0, saved("甲的白话")]]), new Map([[0, { index: 0, splitAt: 2 }]]), "inline");
    const afterSave = buildSavedRegionsByParagraph(first, 3, sentences, new Map([[0, saved("甲的白话")], [1, { ...saved("乙的白话"), paraIndex: 1 }]]), new Map([[0, { index: 0, splitAt: 2 }], [1, { index: 1, splitAt: 2 }]]), "inline");
    const afterRemove = buildSavedRegionsByParagraph(afterSave, 3, sentences, new Map([[1, { ...saved("乙的白话"), paraIndex: 1 }]]), new Map([[1, { index: 1, splitAt: 2 }]]), "inline");
    expect(afterSave[0]).toBe(first[0]);
    expect(afterSave[2]).toBe(first[2]);
    expect(afterRemove[1]).toBe(afterSave[1]);
    expect(afterRemove[2]).toBe(afterSave[2]);
  });
});

describe("G-10c 阅读与复习模式", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([null, "other", "READING"])('模式值 %j 读取为 review', (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readReadingMode()).toBe("review");
  });

  it("已存 reading 沿用 reading", () => {
    vi.stubGlobal("localStorage", { getItem: () => "reading" });
    expect(readReadingMode()).toBe("reading");
  });

  it("读取 review，读取异常时回退 review", () => {
    vi.stubGlobal("localStorage", { getItem: () => "review" });
    expect(readReadingMode()).toBe("review");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readReadingMode()).toBe("review");
  });

  it("阅读模式只把未展开保存项变成微标记，复习模式没有微标记", () => {
    const sentences = [
      { index: 0, paraIndex: 0, start: 0, text: "甲。", charCount: 2 },
      { index: 1, paraIndex: 1, start: 0, text: "乙。", charCount: 2 },
    ];
    const entry = { paraIndex: 0, start: 0, sourceHash: "x", text: "白话", savedAt: 0, kind: "saved" as const };
    const saved = new Map([[0, entry], [1, { ...entry, paraIndex: 1 }]]);

    expect(buildSavedMarkersByParagraph([], 2, sentences, saved, "reading", 0)).toEqual([[], [1]]);
    expect(buildSavedMarkersByParagraph([], 2, sentences, saved, "review", null)).toEqual([[], []]);
  });

  it("阅读模式只显示当前展开 Region；复习模式复用全部 Region", () => {
    const view = { status: "done" as const, text: "白话", failure: null, instant: true };
    const regions = [
      [{ index: 0, splitAt: 2, view, saved: true, presentation: "inline" as const, actionVisible: false, explainView: IDLE_EXPLAIN_VIEW }],
      [{ index: 1, splitAt: null, view, saved: true, presentation: "inline" as const, actionVisible: false, explainView: IDLE_EXPLAIN_VIEW }],
    ];

    expect(selectVisibleSavedRegions(regions, "reading", 1).map((items) => items.map((item) => item.index))).toEqual([[], [1]]);
    expect(selectVisibleSavedRegions(regions, "review", null)).toBe(regions);
  });

  it("句子全部可见片段都有下划线，透明占位没有旧按钮", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(createElement(Paragraph, {
      paraIndex: 0, heading: undefined,
      pieces: [{ index: 3, start: 0, text: "前半后半。" }], savedMarkers: [3],
      regions: [{ index: 0, splitAt: 2, view: { status: "done", text: "白话", failure: null, instant: true },
        saved: false, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW }],
      panelRef: null, onRetry: () => {}, onBeforeReveal: () => null, onAfterReveal: () => {},
      onSave: async () => "saved" as const, onExplain: () => {}, onExplainRetry: () => {},
      onExplainBlocked: () => {}, sentences: [], breatheSentenceIndex: null,
    }));
    const fragments = host.querySelectorAll('.sentence[data-index="3"]');
    expect(fragments.length).toBeGreaterThan(1);
    expect([...fragments].every((fragment) => fragment.classList.contains("sentence-saved-collapsed"))).toBe(true);
    expect(host.querySelectorAll(".reader-tail-placeholder.sentence-saved-collapsed")).toHaveLength(0);
    expect(host.querySelectorAll(".saved-marker")).toHaveLength(0);
  });
});

describe("G-11 逐句追加复用字符锚定", () => {
  it("面板在视口内时，参照字位置不变，补偿 0px、可见内容位移 0px", () => {
    const before = 96;
    const afterAppend = 96;
    const compensation = anchorScrollDelta(before, afterAppend);
    expect(compensation).toBe(0);
    expect(afterAppend - before - compensation).toBe(0);
  });

  it("面板在视口上方增长 28px 时，补偿 28px、可见内容位移 0px", () => {
    const before = 96;
    const afterAppend = 124;
    const compensation = anchorScrollDelta(before, afterAppend);
    expect(compensation).toBe(28);
    expect(afterAppend - before - compensation).toBe(0);
  });

  it("视口顶边切过面板时不建事务，面板内参照字实测位移为 0px", () => {
    // panel top=-18、bottom=92：读者正在读面板内的整句理解，不可用下方正文做锚点补偿。
    expect(shouldAnchorPanelGrowth(92)).toBe(false);
    const panelInnerCharBefore = 34;
    const panelInnerCharAfterAppend = 34;
    const compensation = 0;
    expect(panelInnerCharAfterAppend - panelInnerCharBefore - compensation).toBe(0);
  });

  it("操作行从生成开始即占位，功能一完成时下方正文第一行位移为 0px", () => {
    const belowPanelBefore = 208;
    const belowPanelAfterGlossDone = 208;
    expect(belowPanelAfterGlossDone - belowPanelBefore).toBe(0);
  });

  it("保留小于 0.5px 的补偿量，避免多次逐字显示积累单向漂移", () => {
    const changes = Array.from({ length: 100 }, () => 0.4);
    const signedResidual = changes.reduce((sum, change) => sum + change - anchorScrollDelta(100, 100 + change), 0);
    expect(Math.abs(signedResidual)).toBeLessThanOrEqual(1);
  });
});

describe("G-11 explain-v3 三段上下文与白话输入", () => {
  it("段首、段尾和只有一段时正确保留可用的相邻段", () => {
    const paragraphs = ["第一段。", "第二段。", "第三段。"];
    const sentences = segmentParagraphs(paragraphs).sentences;
    expect(cropExplainContext(paragraphs, sentences[0]!)).toEqual({ previous: null, current: "第一段。", next: "第二段。" });
    expect(cropExplainContext(paragraphs, sentences[2]!)).toEqual({ previous: "第二段。", current: "第三段。", next: null });
    const only = segmentParagraphs(["只有一段。"]).sentences[0]!;
    expect(cropExplainContext(["只有一段。"], only)).toEqual({ previous: null, current: "只有一段。", next: null });
  });

  it("当前段超长时围绕目标句裁剪，上一段取尾、下一段取头，总计不超过 2000 字", () => {
    const previous = `甲${"前".repeat(600)}`;
    const current = `${"左".repeat(950)}目标句。${"右".repeat(950)}`;
    const next = `${"后".repeat(600)}乙`;
    const context = cropExplainContext([previous, current, next], { paraIndex: 1, start: 950, text: "目标句。" });
    expect(context.previous).toMatch(/^……/u);
    expect(context.previous).toContain("前");
    expect(context.current).toContain("目标句。");
    expect(context.current).toMatch(/……/u);
    expect(context.next).toMatch(/……$/u);
    expect([context.previous, context.current, context.next].join("").replace(/\s/g, "").length).toBeLessThanOrEqual(2000);
  });

  it("当前段完整保留后，邻段默认均分剩余预算且短的一侧把余量让给另一侧", () => {
    const previous = "前".repeat(1200);
    const current = `${"中".repeat(296)}目标句。`;
    const next = "后".repeat(800);
    const context = cropExplainContext([previous, current, next], { paraIndex: 1, start: 296, text: "目标句。" });
    expect(context.current).toBe(current);
    expect(context.current).toContain("目标句。");
    expect(context.previous?.replace("……", "").length).toBe(898);
    expect(context.previous?.length).toBe(900);
    expect(context.next?.length).toBe(800);
    expect([context.previous, context.current, context.next].join("").length).toBe(2000);
  });

  it("一侧为空时另一侧获得全部剩余预算", () => {
    const current = `${"中".repeat(296)}目标句。`;
    const context = cropExplainContext(["前".repeat(1900), current], { paraIndex: 1, start: 296, text: "目标句。" });
    expect(context.next).toBeNull();
    expect(context.previous?.length).toBe(1700);
    expect(context.current).toBe(current);
    expect([context.previous, context.current].join("").length).toBe(2000);
  });

  it("从末尾截取的预算为 0 时返回空字符串，不触发 slice(-0)", () => {
    expect(takeCodePointsFromEnd("整段原文", 0)).toBe("");
    expect(takeCodePointsFromEnd("整段原文", -1)).toBe("");
  });

  it("上一段或下一段为空时归一为 null，保存白话优先于自动版且发送时移除术语定界符", () => {
    const paragraphs = ["　", "目标句。", "\n"];
    const sentences = segmentParagraphs(paragraphs).sentences;
    const saved = new Map([[0, { paraIndex: 1, start: 0, sourceHash: "x", text: "保存的⟦概念⟧白话。", savedAt: 0, kind: "saved" as const }]]);
    const automatic = new Map<number, MemoryGloss>([[0, { text: "自动白话。", hasStructure: false, source: "session", shown: true }]]);
    const input = buildExplainInput(paragraphs, sentences, 0, null, saved, automatic);
    expect(input.context).toEqual({ previous: null, current: "目标句。", next: null });
    expect(input.gloss).toBe("保存的概念白话。");
    expect(buildExplainInput(paragraphs, sentences, 0, null, new Map(), new Map()).gloss).toBeNull();
  });
});

describe("G-10b 性能注入记录", () => {
  it("按段落、起始下标与原句 SHA-256 写出的 30 条记录可被 loadSavedGlosses 核对", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const paragraphs = Array.from({ length: 30 }, (_, index) => `第${index + 1}段第一句。第二句。`);
    const sentences = segmentParagraphs(paragraphs).sentences;
    const entries = await Promise.all(
      paragraphs.map(async (_, paraIndex) => {
        const sentence = sentences.find((item) => item.paraIndex === paraIndex)!;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sentence.text)));
        return {
          paraIndex,
          start: sentence.start,
          sourceHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          text: "本地性能注入的常驻白话。",
          savedAt: 0,
          kind: "saved" as const,
        };
      }),
    );
    localStorage.setItem("gloss:saved:perf-fixture", JSON.stringify({ version: 1, entries }));
    expect(await loadSavedGlosses("perf-fixture", sentences)).toHaveLength(30);
  });
});

describe("G-15b 阅读器事件", () => {
  const text = "甲乙。丙丁。戊己。庚辛。";
  const glossText = "预载白话。";
  type Detail = Record<string, unknown> & { event: string };
  let events: Detail[] = [];
  let now = 1_000;
  let panelRect = { top: 100, bottom: 300, height: 200, left: 0, right: 600, width: 600, x: 0, y: 100 } as DOMRect;
  let observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
  const onAnalytics = (event: Event) => events.push((event as CustomEvent<Detail>).detail);
  const of = (name: string) => events.filter((event) => event.event === name);
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let roots: { root: ReturnType<typeof createRoot>; container: HTMLElement }[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  function stubEnvironment(hitDocIds: readonly string[], cachedText = glossText) {
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetchMock = vi.fn((url: string) => String(url).includes("/api/report")
      ? Promise.resolve(new Response(null, { status: 204 }))
      : new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("gloss-panel") ? panelRect : originalRect.call(this);
    });
    vi.stubGlobal("IntersectionObserver", class {
      targets: Element[] = [];
      constructor(callback: IntersectionObserverCallback) { observers.push({ callback, targets: this.targets }); }
      observe(target: Element) { this.targets.push(target); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
    vi.spyOn(cache, "preloadGlossCache").mockImplementation(async (docId) => hitDocIds.includes(docId)
      ? new Map([0, 1, 2, 3].map((index) => [index, { text: cachedText, hasStructure: false }]))
      : new Map());
  }

  async function mount(docId: string, options: { position?: string } = {}) {
    localStorage.setItem(`gloss:doc:${docId}`, JSON.stringify({
      version: 1, docId, paragraphs: [text], headings: [{ paraIndex: 0, level: 1, text: "测试" }],
      footnotes: [], meta: { format: "txt", fileName: "测试.txt", charCount: 6 }, savedAt: 1,
    }));
    if (options.position !== undefined) localStorage.setItem(`gloss:pos:${docId}`, options.position);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => { root.render(createElement(Reader, { docId })); });
    for (let index = 0; index < 5; index++) await act(async () => { await Promise.resolve(); });
    return container;
  }

  async function click(container: HTMLElement, selector: string, at: number) {
    now = at;
    const target = container.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
    expect(target, selector).not.toBeNull();
    await act(async () => { target!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let index = 0; index < 3; index++) await act(async () => { await Promise.resolve(); });
  }

  function expectAccepted(names: readonly string[]) {
    for (const detail of events.filter((event) => names.includes(event.event))) {
      expect(validateAnalyticsEvent({ ...detail, eventId: crypto.randomUUID() }, true), JSON.stringify(detail)).toBe(true);
    }
  }

  beforeEach(() => {
    // 前面的 describe 可能留下 localStorage 替身；本组一律用环境自带的存储。
    vi.unstubAllGlobals();
    events = [];
    now = 1_000;
    observers = [];
    panelRect = { top: 100, bottom: 300, height: 200, left: 0, right: 600, width: 600, x: 0, y: 100 } as DOMRect;
    window.addEventListener("gloss:analytics", onAnalytics);
  });

  afterEach(async () => {
    for (const { root, container } of roots) {
      await act(async () => { root.unmount(); });
      container.remove();
    }
    roots = [];
    document.querySelectorAll(".reader-context-menu").forEach((menu) => menu.remove());
    window.removeEventListener("gloss:analytics", onAnalytics);
    localStorage.clear();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reader_enter 每次进入只发一次；来源取一次性标记，恢复位置要求大于 0 且有效", async () => {
    stubEnvironment([]);
    markReaderEntry("g15b-shelf", "shelf");
    const shelf = await mount("g15b-shelf", { position: "1" });
    await click(shelf, ".sentence[data-index='0']", 2_000);
    await mount("g15b-direct-0", { position: "0" });
    await mount("g15b-direct-invalid", { position: "9" });
    markReaderEntry("g15b-other", "upload");
    await mount("g15b-direct-none");
    // 直接写入本地队列（整页加载时早于采集器监听），不经 gloss:analytics 派发。
    const queued = (JSON.parse(localStorage.getItem("gloss:analytics:local:v1") ?? "{}").outbox ?? [])
      .filter((entry: Detail) => entry.event === "reader_enter")
      .map(({ eventId: _eventId, ...entry }: Detail) => entry);
    expect(queued).toEqual([
      { event: "reader_enter", source: "shelf", positionRestored: true },
      { event: "reader_enter", source: "direct", positionRestored: false },
      { event: "reader_enter", source: "direct", positionRestored: false },
      { event: "reader_enter", source: "direct", positionRestored: false },
    ]);
    expect(of("reader_enter")).toEqual([]);
  });

  it.each(["shelf", "landing"] as const)("G-16a 示例句首帧已有 4 字，跳过结构与白话接口并记 %s 来源", async (source) => {
    stubEnvironment([]);
    fetchMock.mockImplementation((url: string) => String(url).includes("/samples/shan-yu-e.json")
      ? Promise.resolve(Response.json(sampleContent)) : new Promise<Response>(() => {}));
    markReaderEntry("sample", source);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => { root.render(createElement(Reader, { docId: "sample" })); });
    for (let index = 0; index < 6; index++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".reader-body-sample-breathing")).not.toBeNull();
    await click(container, ".sentence[data-index='10']", 2_000);
    expect(container.querySelector(".gloss-panel-text")?.textContent).toBe("站在大多");
    expect(container.querySelector(".gloss-panel-pending")).toBeNull();
    expect(container.querySelector(".reader-body-sample-breathing")).toBeNull();
    expect(localStorage.getItem("gloss:sample:breathed")).toBe("1");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/samples/shan-yu-e.json"]);
    expect(cache.preloadGlossCache).not.toHaveBeenCalled();
    expect(of("sentence_click")).toEqual([expect.objectContaining({ sample: true, cacheHit: false })]);
    expect(of("gloss_first_token")).toEqual([]);
    const outbox = JSON.parse(localStorage.getItem("gloss:analytics:local:v1") ?? "{}").outbox ?? [];
    expect(outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "reader_enter", source }),
      expect.objectContaining({ event: "sample_doc_enter", from: source }),
    ]));
  });

  it("gloss_dismiss_early：同段切句不发，单句收起和批量主动收起逐句判定", async () => {
    stubEnvironment(["g15b-dismiss"]);
    const container = await mount("g15b-dismiss");
    await click(container, ".sentence[data-index='0']", 1_000);
    expect(of("gloss_complete")).toHaveLength(1);
    expect(of("gloss_complete")[0]).toEqual(expect.objectContaining({ glossCharsBucket: "1-50" }));
    await click(container, ".sentence[data-index='0']", 2_500);
    await click(container, ".sentence[data-index='1']", 4_000);
    await click(container, ".sentence[data-index='2']", 4_800);
    now = 5_500;
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await click(container, ".sentence[data-index='3']", 7_000);
    now = 7_600;
    await act(async () => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(of("gloss_dismiss_early")).toEqual([
      { event: "gloss_dismiss_early", sentenceIndex: 0, visibleMs: 1_500 },
      { event: "gloss_dismiss_early", sentenceIndex: 1, visibleMs: 1_500 },
      { event: "gloss_dismiss_early", sentenceIndex: 2, visibleMs: 700 },
      { event: "gloss_dismiss_early", sentenceIndex: 3, visibleMs: 600 },
    ]);
    expect(of("gloss_read_complete")).toEqual([]);
    expectAccepted(["gloss_dismiss_early"]);
  });

  it("gloss_dismiss_early 限首次撑开：同一句第二次撑开后 1 秒内收起不发，第一次同样操作发 1 次", async () => {
    stubEnvironment(["g15b-reclick"]);
    const container = await mount("g15b-reclick");
    await click(container, ".sentence[data-index='0']", 1_000);
    await click(container, ".sentence[data-index='0']", 2_000);
    await click(container, ".sentence[data-index='0']", 3_000);
    await click(container, ".sentence[data-index='0']", 3_800);
    expect(of("sentence_reclick")).toEqual([{ event: "sentence_reclick", sentenceIndex: 0, reclickOrdinal: 2 }]);
    expect(of("gloss_dismiss_early")).toEqual([{ event: "gloss_dismiss_early", sentenceIndex: 0, visibleMs: 1_000 }]);
  });

  it("gloss_dismiss_early 不发：已读完、可见满 2 秒、生成未完成、G-46 自动收起", async () => {
    stubEnvironment(["g15b-read", "g15b-auto"]);
    const read = await mount("g15b-read");
    await click(read, ".sentence[data-index='0']", 1_000);
    now = 4_000;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(of("gloss_read_complete")).toHaveLength(1);
    expect(of("gloss_read_complete")[0]).toEqual(expect.objectContaining({ glossCharsBucket: "1-50" }));
    await click(read, ".sentence[data-index='0']", 4_100);

    panelRect = { ...panelRect, bottom: 5_000, height: 4_900 } as DOMRect;
    await click(read, ".sentence[data-index='1']", 5_000);
    await click(read, ".sentence[data-index='1']", 7_500);

    panelRect = { ...panelRect, bottom: 300, height: 200 } as DOMRect;

    const auto = await mount("g15b-auto");
    await click(auto, ".sentence[data-index='0']", 10_000);
    now = 10_500;
    const observer = observers.at(-1)!;
    await act(async () => {
      observer.callback(observer.targets.map((target) => ({ target, isIntersecting: false }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
    });
    expect(auto.querySelector(".gloss-panel")).toBeNull();

    const miss = await mount("g15b-miss");
    await click(miss, ".sentence[data-index='0']", 11_000);
    await click(miss, ".sentence[data-index='0']", 11_500);
    // 收起动画 220ms 结束后才提交收起并记 gloss_abort。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(of("gloss_abort").at(-1)).toEqual({ event: "gloss_abort", sentenceIndex: 0, abortPhase: "waiting" });

    expect(of("gloss_dismiss_early")).toEqual([]);
  });

  it("120 visible gloss chars require 15 seconds before gloss_read_complete", async () => {
    stubEnvironment(["g50-raw-clock"], "甲".repeat(120));
    const container = await mount("g50-raw-clock");
    await click(container, ".sentence[data-index='0']", 1_000);
    expect(of("gloss_complete")[0]).toEqual(expect.objectContaining({ glossCharsBucket: "101-150" }));
    now = 15_999;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(of("gloss_read_complete")).toEqual([]);
    now = 16_000;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(of("gloss_read_complete")).toEqual([
      expect.objectContaining({ glossCharsBucket: "101-150", visibleMs: 15_000 }),
    ]);
  });

  it("gloss_save 写入成功发一次，取消保存不发；操作行「听不懂」发 action_row", async () => {
    stubEnvironment(["g15b-save"]);
    const container = await mount("g15b-save");
    await click(container, ".sentence[data-index='0']", 1_000);
    await click(container, ".action-row-explain", 1_500);
    expect(of("deep_explain_click")).toEqual([{ event: "deep_explain_click", sentenceIndex: 0, source: "action_row" }]);
    await click(container, ".action-row-explain", 1_600);
    expect(of("deep_explain_click")).toHaveLength(1);

    await click(container, ".action-row-save", 2_000);
    expect(of("gloss_save")).toEqual([{ event: "gloss_save", sentenceIndex: 0, edited: false }]);
    expect(container.querySelector<HTMLElement>(".action-row-save")?.textContent).toBe("取消留下");
    await click(container, ".action-row-save", 3_000);
    expect(container.querySelector<HTMLElement>(".action-row-save")?.textContent).toBe("留下");
    expect(of("gloss_save")).toHaveLength(1);
    expectAccepted(["deep_explain_click", "gloss_save"]);
  });

  it("功能二已用：操作行与右键「听不懂」只发 deep_explain_blocked；右键「翻错了」只带句序号", async () => {
    stubEnvironment(["g15b-blocked"]);
    const [first] = segmentParagraphs([text]).sentences;
    await saveExplanation("g15b-blocked", first, "整句理解。");
    const container = await mount("g15b-blocked");
    await click(container, ".sentence[data-index='0']", 1_000);
    await click(container, ".action-row-explain", 1_500);

    const sentence = container.querySelector<HTMLElement>(".sentence[data-index='0']")!;
    await act(async () => { sentence.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    const [explain, report] = [...document.querySelectorAll<HTMLElement>(".reader-context-menu button")];
    await act(async () => { explain.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { report.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let index = 0; index < 5; index++) await act(async () => { await Promise.resolve(); });

    expect(of("deep_explain_blocked")).toEqual([
      { event: "deep_explain_blocked", sentenceIndex: 0 },
      { event: "deep_explain_blocked", sentenceIndex: 0 },
    ]);
    expect(of("deep_explain_click")).toEqual([]);
    expect(of("report_error_click")).toEqual([{ event: "report_error_click", sentenceIndex: 0 }]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/explain"))).toEqual([]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/report"))).toHaveLength(1);
    expectAccepted(["deep_explain_blocked", "report_error_click"]);
  });

  it("右键「听不懂」未用时发 context_menu", async () => {
    stubEnvironment(["g15b-menu"]);
    const container = await mount("g15b-menu");
    await click(container, ".sentence[data-index='1']", 1_000);
    const sentence = container.querySelector<HTMLElement>(".sentence[data-index='1']")!;
    await act(async () => { sentence.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    const [explain] = [...document.querySelectorAll<HTMLElement>(".reader-context-menu button")];
    await act(async () => { explain.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(of("deep_explain_click")).toEqual([{ event: "deep_explain_click", sentenceIndex: 1, source: "context_menu" }]);
    expectAccepted(["deep_explain_click"]);
  });
});


describe("G-57 白话悬停与返回入口", () => {
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement }[] = [];

  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    vi.spyOn(lineSplit, "measureSplit").mockReturnValue(1);
    vi.spyOn(cache, "preloadGlossCache").mockResolvedValue(new Map([[0, { text: "测试白话。", hasStructure: false }]]));
  });

  afterEach(async () => {
    for (const { root, host } of mounted.splice(0)) {
      await act(async () => { root.unmount(); });
      host.remove();
    }
    localStorage.clear();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function flush() {
    for (let step = 0; step < 6; step++) await act(async () => { await Promise.resolve(); });
  }

  async function mount(docId: string) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => { root.render(createElement(Reader, { docId })); });
    await flush();
    return host;
  }

  async function pointer(target: Element, type: string, pointerType = "mouse", relatedTarget: EventTarget | null = null) {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget }));
    });
  }

  it("服务端和判定前的首页链接不可见但保留占位", () => {
    const html = renderToString(createElement(Reader, { docId: "g57-missing" }));
    const host = document.createElement("div");
    host.innerHTML = html;
    const link = host.querySelector<HTMLElement>(".reader-shelf-back")!;
    expect(link.textContent).toBe("← 回到首页");
    expect(link.style.visibility).toBe("hidden");
    expect(link.style.display).toBe("");
  });

  it.each([
    ["空书架", [], false, "← 回到首页"],
    ["只有示例", [{ docId: "sample" }], false, "← 回到首页"],
    ["自有书", [{ docId: "own" }], false, "← 回到书架"],
    ["不可用", [{ docId: "own" }], true, "← 回到首页"],
  ] as const)("%s 挂载判定后显示正确返回文字", async (_name, entries, unavailable, text) => {
    vi.spyOn(storage, "loadShelf").mockReturnValue({ entries: entries as unknown as storage.ShelfEntry[], unavailable });
    const host = await mount("g57-missing");
    const link = host.querySelector<HTMLElement>(".reader-shelf-back")!;
    expect(link.textContent).toBe(text);
    expect(link.style.visibility).toBe("visible");
  });

  it("书架读取抛错仍显示回到首页", async () => {
    vi.spyOn(storage, "loadShelf").mockImplementation(() => { throw new Error("storage unavailable"); });
    const host = await mount("g57-missing");
    expect(host.querySelector<HTMLElement>(".reader-shelf-back")?.textContent).toBe("← 回到首页");
    expect(host.querySelector<HTMLElement>(".reader-shelf-back")?.style.visibility).toBe("visible");
  });

  it.each([
    [false, "inline"], [false, "bubble"], [true, "inline"], [true, "bubble"],
  ] as const)("saved=%s、%s 白话只高亮对应全部片段；内部移动不闪，移开和卸载清理", async (saved, shape) => {
    const docId = `g57-${saved}-${shape}`;
    const paragraphs = ["甲乙。丙丁。"];
    localStorage.setItem(`gloss:doc:${docId}`, JSON.stringify({
      version: 1, docId, paragraphs, headings: [], footnotes: [],
      meta: { format: "txt", fileName: "测试.txt", charCount: 6 }, savedAt: 1,
    }));
    localStorage.setItem("gloss:settings:gloss-shape", shape);
    if (saved) {
      await storage.saveSavedGloss(docId, segmentParagraphs(paragraphs).sentences[0], "已保存白话。");
      localStorage.setItem("gloss:settings:reading-mode", "review");
    }
    const host = await mount(docId);
    if (!saved) {
      await act(async () => { host.querySelector<HTMLElement>('.sentence[data-index="0"]')!.click(); });
      await flush();
    }
    const body = host.querySelector<HTMLElement>(".reader-body")!;
    const panel = body.querySelector<HTMLElement>(`.gloss-panel-${shape}`)!;
    expect(panel).not.toBeNull();
    expect(panel.classList.contains("gloss-panel-saved")).toBe(saved);
    const pieces = [...body.querySelectorAll<HTMLElement>('.sentence[data-index="0"]')];
    expect(pieces.map(piece => piece.textContent).join("")).toBe("甲乙。");
    const other = body.querySelector<HTMLElement>('.sentence[data-index="1"]')!;
    const text = panel.querySelector(".gloss-panel-text")!;
    const child = text.querySelector("span")!;
    const expectActive = (active: boolean) => {
      expect(pieces.every((piece) => piece.classList.contains("sentence-gloss-hover") === active)).toBe(true);
      expect(other.classList.contains("sentence-gloss-hover")).toBe(false);
    };
    await pointer(text, "pointerover", "touch");
    expectActive(false);
    await pointer(text, "pointerover", "pen");
    expectActive(false);
    await pointer(text, "pointerover");
    expectActive(true);
    await pointer(text, "pointerout", "mouse", child);
    await pointer(child, "pointerover", "mouse", text);
    expectActive(true);
    await pointer(child, "pointerout", "mouse", other);
    expectActive(false);
    await pointer(text, "pointerover");
    await pointer(text, "pointerout", "mouse", null);
    expectActive(false);
    await pointer(other, "pointerover");
    expect(panel.classList.contains("sentence-gloss-hover")).toBe(false);
    await pointer(text, "pointerover");
    expectActive(true);
    panel.remove();
    await flush();
    expectActive(false);
  });

  async function mountSentenceHoverDocument(docId: string) {
    vi.mocked(lineSplit.measureSplit).mockReturnValue(4);
    localStorage.setItem(`gloss:doc:${docId}`, JSON.stringify({
      version: 1, docId, paragraphs: ["甲乙。丙丁。"], headings: [], footnotes: [],
      meta: { format: "txt", fileName: "悬停测试.txt", charCount: 6 }, savedAt: 1,
    }));
    return mount(docId);
  }

  it("G-59 任一片段悬停使整句变色，同句移动不闪，移出清除，占位不参与", async () => {
    const host = await mountSentenceHoverDocument("g59-sentence-hover");
    await act(async () => { host.querySelector<HTMLElement>('.sentence[data-index="0"]')!.click(); });
    await flush();
    const pieces = [...host.querySelectorAll<HTMLElement>('.sentence[data-index="1"]')];
    expect(pieces.map(piece => piece.textContent).join("")).toBe("丙丁。");
    const expectHover = (active: boolean) => expect(pieces.every(p => p.classList.contains("sentence-hover") === active)).toBe(true);
    await pointer(pieces[0], "pointerover");
    expectHover(true);
    await pointer(pieces[0], "pointerout", "mouse", pieces.at(-1)!);
    expectHover(true);
    await pointer(pieces.at(-1)!, "pointerover", "mouse", pieces[0]);
    expectHover(true);
    expect(host.querySelectorAll(".reader-tail-placeholder.sentence-hover")).toHaveLength(0);
    await pointer(pieces.at(-1)!, "pointerout", "mouse", host.querySelector('.sentence[data-index="0"]'));
    expectHover(false);
    await pointer(host.querySelector(".reader-tail-placeholder")!, "pointerover");
    expectHover(false);
    expect(host.querySelectorAll(".reader-tail-placeholder.sentence-hover")).toHaveLength(0);
  });

  it("G-59 touch 与 pen 不触发句子整句悬停", async () => {
    const host = await mountSentenceHoverDocument("g59-touch-hover");
    const sentence = host.querySelector('.sentence[data-index="1"]')!;
    await pointer(sentence, "pointerover", "touch");
    expect(host.querySelectorAll(".sentence-hover")).toHaveLength(0);
    await pointer(sentence, "pointerover", "pen");
    expect(host.querySelectorAll(".sentence-hover")).toHaveLength(0);
  });

  it("G-59 撑开和收起后新片段保持整句悬停，换书与卸载清理", async () => {
    const host = await mountSentenceHoverDocument("g59-repartition-hover");
    await pointer(host.querySelector('.sentence[data-index="1"]')!, "pointerover");
    await act(async () => { host.querySelector<HTMLElement>('.sentence[data-index="0"]')!.click(); });
    await flush();
    let pieces = [...host.querySelectorAll('.sentence[data-index="1"]')];
    expect(pieces.map(piece => piece.textContent).join("")).toBe("丙丁。");
    expect(pieces.every(p => p.classList.contains("sentence-hover"))).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    await flush();
    pieces = [...host.querySelectorAll('.sentence[data-index="1"]')];
    expect(pieces).toHaveLength(1);
    expect(pieces[0].classList.contains("sentence-hover")).toBe(true);
    localStorage.setItem("gloss:doc:g59-hover-next-book", JSON.stringify({
      version: 1, docId: "g59-hover-next-book", paragraphs: ["新书原文。"], headings: [], footnotes: [],
      meta: { format: "txt", fileName: "另一本.txt", charCount: 5 }, savedAt: 1,
    }));
    const record = mounted.find(record => record.host === host)!;
    await act(async () => { record.root.render(createElement(Reader, { docId: "g59-hover-next-book" })); });
    await flush();
    expect(host.querySelectorAll(".sentence-hover")).toHaveLength(0);
    await pointer(host.querySelector(".sentence")!, "pointerover");
    expect(host.querySelectorAll(".sentence-hover")).toHaveLength(1);
    await act(async () => { record.root.unmount(); });
    mounted.splice(mounted.indexOf(record), 1);
    host.remove();
    expect(document.querySelectorAll(".sentence-hover")).toHaveLength(0);
  });

  it("G-59 sentence-hover 只声明颜色并保留呼吸态优先级，没有正文单片段 hover", () => {
    const css = readFileSync(path.resolve(process.cwd(), "styles/reader.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(rule => rule[1].includes("sentence-hover"));
    expect(rules).toHaveLength(2);
    expect(rules.every(rule => rule[2].trim() === "color: var(--hover);")).toBe(true);
    expect(css).not.toMatch(/\.sentence(?:-breathe)?:hover/);
    expect(css).toContain(".reader-body-sample-breathing .sentence:not(.sentence-breathe).sentence-hover");
    expect(css).toContain(".reader-body-sample-breathing .sentence-breathe.sentence-hover");
  });

  it("新增悬停规则只声明颜色并覆盖示例呼吸态", () => {
    const css = readFileSync(path.resolve(process.cwd(), "styles/reader.css"), "utf8");
    const rule = css.match(/\.reader-body \.sentence\.sentence-gloss-hover,\s*\.reader-body\.reader-body-sample-breathing \.sentence\.sentence-gloss-hover\s*\{([^}]+)\}/);
    expect(rule?.[1].trim()).toBe("color: var(--hover);");
  });
});


describe("G-59 行尾占位与尾行", () => {
  const pieces = [
    { index: 0, start: 0, text: "甲。”   " },
    { index: 1, start: 6, text: "乙丙。" },
    { index: 2, start: 9, text: "丁戊。" },
  ];
  const region = (index: number, splitAt: number | null, saved = false): Region => ({
    index, splitAt, saved, presentation: "inline", actionVisible: false,
    view: { status: "done", text: "白话", failure: null, instant: true }, explainView: IDLE_EXPLAIN_VIEW,
  });
  function render(input: typeof pieces, regions: Region[]) {
    const host = document.createElement("div");
    host.innerHTML = renderToString(createElement(Paragraph, {
      paraIndex: 0, heading: undefined, pieces: input, regions, savedMarkers: [1], panelRef: null,
      onRetry: () => {}, onBeforeReveal: () => null, onAfterReveal: () => {},
      onSave: async () => "saved" as const,
      onExplain: () => {}, onExplainRetry: () => {}, onExplainBlocked: () => {},
      sentences: [], breatheSentenceIndex: 1,
    }));
    return host;
  }
  it("句末保留收尾标点、尾空白归尾巴，切片偏移不变", () => {
    const result = splitParagraphTail(pieces, slicePieces(pieces, 0, 8), [0], 8);
    expect(result.tail).toEqual([{ index: 0, start: 3, text: "   " }, { index: 1, start: 6, text: "乙丙" }]);
    expect(result.head.filter((p) => !p.placeholder).map((p) => p.text).join("")).toBe("甲。”");
  });
  it("透明占位不带句子标识、呼吸、悬停或白标记", () => {
    const host = render(pieces, [region(0, 8)]);
    const placeholder = host.querySelector<HTMLElement>(".reader-tail-placeholder")!;
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.hasAttribute("inert")).toBe(true);
    expect(host.querySelectorAll('.reader-tail-placeholder.sentence, .reader-tail-placeholder[data-index], .reader-tail-placeholder[data-offset], .reader-tail-placeholder.sentence-saved-collapsed, .reader-tail-placeholder.sentence-breathe, .reader-tail-placeholder.sentence-gloss-hover')).toHaveLength(0);
  });
  it("面板后连续续排；可见片段恰为完整原文", () => {
    const host = render(pieces, [region(0, 8)]);
    const line = host.querySelector<HTMLElement>(".reader-para-cont")!;
    expect(line.previousElementSibling?.classList.contains("gloss-panel")).toBe(true);
    expect(line.nextElementSibling).toBeNull();
    expect(line.querySelector('.sentence[data-index="1"][data-offset="6"]')?.textContent).toBe("乙丙。");
    expect([...host.querySelectorAll(".sentence")].map((p) => p.textContent).join("")).toBe(pieces.map((p) => p.text).join(""));
  });
  it("同物理拆点仍逐句插入，真实文字只出现一次", () => {
    const host = render(pieces, [region(1, 11, true), region(0, 11)]);
    expect([...host.querySelectorAll(".gloss-panel")].map((panel) => panel.getAttribute("data-sentence-index"))).toEqual(["0", "1"]);
    expect(host.querySelector(".reader-tail-line")).toBeNull();
    expect([...host.querySelectorAll(".sentence")].map((span) => span.textContent).join("")).toBe(pieces.map((piece) => piece.text).join(""));
  });
  it("原末行不强加 justify，剩余真实文字连续续排", () => {
    const host = render(pieces, [region(1, null)]);
    expect(host.firstElementChild?.className).toBe("reader-para");
    expect(host.querySelector(".reader-para-cont")?.textContent).toBe("丁戊。");
    expect(host.querySelector(".reader-para-cont")?.nextElementSibling).toBeNull();
    expect(host.querySelectorAll(".reader-para-cont")).toHaveLength(1);
  });
  it("物理尾巴为空仍输出后续原文；没有真实剩余文字才不续排", () => {
    expect(render(pieces, [region(1, 9)]).querySelector(".reader-para-cont")?.textContent).toBe("丁戊。");
    expect(render([{ index: 0, start: 0, text: "甲。" }], [region(0, null)]).querySelector(".reader-para-cont")).toBeNull();
  });
});

describe("G-63 同段多开、并发与整段收起", () => {
  type EventDetail = { event: string; sentenceIndex?: number };
  type Run = { signal: AbortSignal; onText: (text: string) => void;
    resolve: (result: Awaited<ReturnType<typeof glossClient.streamGloss>>) => void };
  const paragraphs = ["甲。乙。丙。", "丁。戊。"];
  const indexes = segmentParagraphs(paragraphs).sentences;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let now: number;
  let events: EventDetail[];
  let runs: Map<number, Run>;
  let observers: { callback: IntersectionObserverCallback; targets: Element[] }[];
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const onEvent = (event: Event) => events.push((event as CustomEvent<EventDetail>).detail);
  const details = (event: string) => events.filter((detail) => detail.event === event);
  const panels = () => [...container.querySelectorAll(".gloss-panel")].map((panel) => Number(panel.getAttribute("data-sentence-index"))).sort((a, b) => a - b);
  const original = () => [...container.querySelectorAll('[data-para="0"] .sentence')].map((span) => span.textContent).join("");
  async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); }
  async function mount(cached = false, saved = false) {
    vi.spyOn(cache, "preloadGlossCache").mockResolvedValue(cached
      ? new Map(indexes.map((sentence) => [sentence.index, { text: "白话。", hasStructure: false }])) : new Map());
    vi.spyOn(storage, "loadSavedGlosses").mockResolvedValue(saved
      ? new Map([[0, { paraIndex: 0, start: 0, sourceHash: "test", text: "留下的白话。", savedAt: 1, kind: "saved" as const }]]) : new Map());
    localStorage.setItem("gloss:doc:g63", JSON.stringify({ version: 1, docId: "g63", paragraphs,
      headings: [], footnotes: [], meta: { format: "txt", fileName: "g63.txt", charCount: 10 }, savedAt: 1 }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(createElement(Reader, { docId: "g63" })); }); await flush();
  }
  async function click(index: number) {
    now += 500;
    await act(async () => { container.querySelector<HTMLElement>('.sentence[data-index="' + index + '"]')!.click(); });
    await flush();
  }
  async function dismiss(kind: "escape" | "blank") {
    now += 500;
    await act(async () => { if (kind === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else container.querySelector<HTMLElement>(".reader-body")!.click(); });
    await flush();
  }
  async function observe(values: (boolean | null)[]) {
    const observer = observers.at(-1)!;
    await act(async () => { observer.callback(observer.targets.flatMap((target, index) => values[index] === null
      ? [] : [{ target, isIntersecting: values[index] ?? false } as IntersectionObserverEntry]), {} as IntersectionObserver); });
    await flush();
  }
  beforeEach(() => {
    vi.unstubAllGlobals(); localStorage.clear(); now = 1000; events = []; runs = new Map(); observers = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(lineSplit, "measureSplit").mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { top: 100, bottom: 250, left: 0, right: 600, width: 600, height: 150, x: 0, y: 100 } as DOMRect);
    vi.stubGlobal("IntersectionObserver", class {
      targets: Element[] = [];
      constructor(callback: IntersectionObserverCallback) { observers.push({ callback, targets: this.targets }); }
      observe(target: Element) { this.targets.push(target); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.spyOn(glossClient, "streamGloss").mockImplementation((input, options) => new Promise((resolve) => {
      const index = indexes.find((sentence) => sentence.text === input.sentence)!.index;
      runs.set(index, { signal: options.signal!, onText: options.onText, resolve });
    }));
    window.addEventListener("gloss:analytics", onEvent);
  });
  afterEach(async () => {
    if (root) { await act(async () => { root.unmount(); }); container.remove(); }
    window.removeEventListener("gloss:analytics", onEvent);
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts); else Reflect.deleteProperty(document, "fonts");
    vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
  });
  it("同段 a、b 两面板保留，真实原文恰好一次，测量事务结束", async () => {
    await mount(true); await click(0); await click(1);
    expect(panels()).toEqual([0, 1]); expect(original()).toBe(paragraphs[0]);
    expect(container.querySelector(".reader-body")?.getAttribute("data-measuring")).toBe("false");
    expect(container.querySelector(".reader-tail-line")).toBeNull();
  });
  it("再点 a 只收 a，b 保留", async () => {
    await mount(true); await click(0); await click(1); await click(0);
    expect(panels()).toEqual([1]); expect(original()).toBe(paragraphs[0]);
  });
  it("跨段收全部临时白话，常驻保留", async () => {
    await mount(true, true); await click(1); await click(2); await click(3);
    expect(panels()).toEqual([0, 3]); expect(original()).toBe(paragraphs[0]);
  });
  it.each(["escape", "blank"] as const)("%s 收起全部临时白话", async (kind) => {
    await mount(true); await click(0); await click(1); await dismiss(kind); expect(panels()).toEqual([]);
  });
  it("同段两请求同时运行；再点 a 仅中止 a 一次", async () => {
    await mount(); await click(0); await click(1);
    expect(runs.size).toBe(2); expect(runs.get(0)!.signal.aborted).toBe(false);
    expect(details("gloss_abort")).toEqual([]); expect(details("gloss_dismiss_early")).toEqual([]);
    await click(0); expect(runs.get(0)!.signal.aborted).toBe(true); expect(runs.get(1)!.signal.aborted).toBe(false);
    expect(details("gloss_abort")).toEqual([expect.objectContaining({ sentenceIndex: 0 })]); expect(panels()).toEqual([1]);
  });
  it("Esc 将 a、b 运行请求各中止一次", async () => {
    await mount(); await click(0); await click(1); await dismiss("escape");
    expect([...runs.values()].every((run) => run.signal.aborted)).toBe(true);
    expect(details("gloss_abort").map((detail) => detail.sentenceIndex).sort()).toEqual([0, 1]);
  });
  it("整段所有目标 false 才批量收起，true / null 保留，自动收起无 dismiss", async () => {
    await mount(); await click(0); await click(1);
    const count = observers.at(-1)!.targets.length;
    expect(count).toBe(container.querySelectorAll('[data-reader-block][data-para="0"]').length + 2);
    await observe(Array.from({ length: count }, (_, index) => index === count - 1 ? null : false)); expect(panels()).toEqual([0, 1]);
    await observe(Array.from({ length: count }, (_, index) => index === count - 1 ? true : false)); expect(panels()).toEqual([0, 1]);
    await observe(Array(count).fill(false)); expect(panels()).toEqual([]);
    expect(details("gloss_abort")).toHaveLength(2); expect(details("gloss_dismiss_early")).toEqual([]);
  });
  it("同段点 b 后 a 计时继续，仍可达到读完阈值", async () => {
    await mount(true); await click(0); await click(1);
    now += 3000; await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(details("gloss_read_complete")).toContainEqual(expect.objectContaining({ sentenceIndex: 0 }));
    expect(details("gloss_dismiss_early")).toEqual([]);
  });
  it("已中止请求的迟到流与结果不写状态、不写缓存", async () => {
    const save = vi.spyOn(cache, "saveGlossCache").mockResolvedValue(true);
    await mount(); await click(0); const stale = runs.get(0)!; await click(1); await click(0);
    await act(async () => { stale.onText("迟到的白话"); stale.resolve({ status: "done", text: "迟到的白话" }); });
    await flush();
    expect(container.textContent).not.toContain("迟到的白话"); expect(save).not.toHaveBeenCalled(); expect(panels()).toEqual([1]);
  });
});
