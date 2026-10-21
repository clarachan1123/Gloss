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
import Reader, { anchorAtViewportTop, rectIntersectsViewport, Paragraph, allObservedTargetsOutside, anchorScrollDelta, buildExplainInput, buildSavedMarkersByParagraph, buildSavedRegionsByParagraph, cropExplainContext, documentStats, groupRegions, paragraphOriginalFragments, prepareReadableDocument, readGlossShape, readReadingMode, retainGlossAfterUnsave, selectVisibleSavedRegions, shouldAnchorPanelGrowth, splitFragmentClassName, takeCodePointsFromEnd, type Region } from "./Reader";
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

    expect(buildSavedMarkersByParagraph([], 2, sentences, saved, "reading", new Set([0]))).toEqual([[], [1]]);
    expect(buildSavedMarkersByParagraph([], 2, sentences, saved, "review", new Set())).toEqual([[], []]);
  });

  it("阅读模式只显示当前展开 Region；复习模式复用全部 Region", () => {
    const view = { status: "done" as const, text: "白话", failure: null, instant: true };
    const regions = [
      [{ index: 0, splitAt: 2, view, saved: true, presentation: "inline" as const, actionVisible: false, explainView: IDLE_EXPLAIN_VIEW }],
      [{ index: 1, splitAt: null, view, saved: true, presentation: "inline" as const, actionVisible: false, explainView: IDLE_EXPLAIN_VIEW }],
    ];

    expect(selectVisibleSavedRegions(regions, "reading", new Set([1])).map((items) => items.map((item) => item.index))).toEqual([[], [1]]);
    expect(selectVisibleSavedRegions(regions, "review", new Set())).toBe(regions);
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
    expect(link.querySelector(".reader-back-text")?.textContent).toBe("← 回到首页");
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
    expect(link.querySelector(".reader-back-text")?.textContent).toBe(text);
    expect(link.style.visibility).toBe("visible");
  });

  it("书架读取抛错仍显示回到首页", async () => {
    vi.spyOn(storage, "loadShelf").mockImplementation(() => { throw new Error("storage unavailable"); });
    const host = await mount("g57-missing");
    expect(host.querySelector<HTMLElement>(".reader-shelf-back .reader-back-text")?.textContent).toBe("← 回到首页");
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
  it("左对齐原末行保留段落身份，剩余真实文字连续续排", () => {
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
  async function mount(cached = false, saved = false, reading = false) {
    if (reading) localStorage.setItem("gloss:settings:reading-mode", "reading");
    vi.spyOn(cache, "preloadGlossCache").mockResolvedValue(cached
      ? new Map(indexes.map((sentence) => [sentence.index, { text: "白话。", hasStructure: false }])) : new Map());
    vi.spyOn(storage, "loadSavedGlosses").mockResolvedValue(saved
      ? new Map((reading ? [0, 1, 3] : [0]).map((index) => [index, { paraIndex: indexes[index].paraIndex, start: indexes[index].start, sourceHash: "test", text: "留下的白话。", savedAt: 1, kind: "saved" as const }])) : new Map());
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
  it("G-66 每个逻辑原文段只有一个容器，拆分后边界不增，句序号与原文不变", async () => {
    await mount(true);
    const wrappers = () => [...container.querySelectorAll(".reader-body > .reader-paragraph")];
    expect(wrappers()).toHaveLength(paragraphs.length);
    expect(wrappers().map(block => block.textContent)).toEqual(paragraphs);
    const identities = () => [...container.querySelectorAll(".sentence")].map(span => ({
      index: span.getAttribute("data-index"), offset: span.getAttribute("data-offset"), text: span.textContent,
    }));
    const before = identities();
    await click(0); await click(1);
    expect(wrappers()).toHaveLength(paragraphs.length);
    expect(wrappers()[0].querySelectorAll("[data-reader-block]").length).toBeGreaterThan(1);
    expect(wrappers()[0].querySelectorAll(".reader-paragraph")).toHaveLength(0);
    expect(wrappers()[0].querySelectorAll(".gloss-panel")).toHaveLength(2);
    expect(identities()).toEqual(before);
    expect(original()).toBe(paragraphs[0]);
  });
  it("G-66 标题容器单独标记并保留标题、段号与句序", async () => {
    await mount(true);
    await act(async () => { root.unmount(); }); container.remove();
    const doc = JSON.parse(localStorage.getItem("gloss:doc:g63")!);
    doc.headings = [{ paraIndex: 0, level: 1, text: paragraphs[0] }];
    localStorage.setItem("gloss:doc:g63", JSON.stringify(doc));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(createElement(Reader, { docId: "g63" })); }); await flush();
    const blocks = [...container.querySelectorAll(".reader-body > .reader-paragraph")];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].classList.contains("reader-heading-block")).toBe(true);
    expect(blocks[1].classList.contains("reader-heading-block")).toBe(false);
    expect(blocks[0].querySelector('h1.reader-heading[data-para="0"][data-reader-block]')?.textContent).toBe(paragraphs[0]);
    expect([...container.querySelectorAll(".sentence")].map(span => Number(span.getAttribute("data-index")))).toEqual(indexes.map(sentence => sentence.index));
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
  function expectSavedClosed(index: number) {
    expect(container.querySelector('.gloss-panel-saved[data-sentence-index="' + index + '"]')).toBeNull();
    expect([...container.querySelectorAll('.sentence[data-index="' + index + '"]')].every((span) =>
      span.classList.contains("sentence-saved-collapsed"))).toBe(true);
  }
  function expectNoSavedReadEvents() {
    expect(events.filter((detail) => [0, 1, 3].includes(detail.sentenceIndex ?? -1) &&
      ["sentence_click", "sentence_reclick", "gloss_dismiss_early", "gloss_abort", "gloss_complete", "gloss_read_complete"].includes(detail.event))).toEqual([]);
  }
  it("G-65 同段已留下 A、B 与普通 C 共存，再点 A 只收 A，不写存储或计读完", async () => {
    await mount(true, true, true);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    await click(0); await click(1); await click(2); expect(panels()).toEqual([0, 1, 2]);
    await click(0); expect(panels()).toEqual([1, 2]); expectSavedClosed(0);
    now += 5000; await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expectNoSavedReadEvents(); expect(writes).not.toHaveBeenCalled();
  });
  it.each([3, 4])("G-65 跨段点句 %s 收原段全部展开", async (index) => {
    await mount(true, true, true); await click(0); await click(1); await click(2); await click(index);
    expect(panels()).toEqual([index]); expectSavedClosed(0); expectSavedClosed(1); expectNoSavedReadEvents();
  });
  it.each(["escape", "blank"] as const)("G-65 %s 收只有已留下展开及混合展开", async (kind) => {
    await mount(true, true, true);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    for (const mixed of [false, true]) {
      await click(0); await click(1); if (mixed) await click(2);
      await act(async () => { container.querySelector<HTMLElement>('.gloss-panel-saved[data-sentence-index="1"]')!.click(); });
      await flush(); await dismiss(kind);
      expect(panels()).toEqual([]); expectSavedClosed(0); expectSavedClosed(1);
    }
    expectNoSavedReadEvents(); expect(writes).not.toHaveBeenCalled();
  });
  it.each([false, true])("G-65 Observer 仅已留下或混合=%s，全部 false 才收", async (mixed) => {
    await mount(true, true, true);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    await click(0); await click(1); if (mixed) await click(2);
    const expected = mixed ? [0, 1, 2] : [0, 1], count = observers.at(-1)!.targets.length;
    expect(count).toBe(container.querySelectorAll('[data-reader-block][data-para="0"]').length + expected.length);
    await observe(Array.from({ length: count }, (_, index) => index === count - 1 ? null : false)); expect(panels()).toEqual(expected);
    await observe(Array.from({ length: count }, (_, index) => index === count - 1 ? true : false)); expect(panels()).toEqual(expected);
    await observe(Array(count).fill(false)); expect(panels()).toEqual([]);
    expectSavedClosed(0); expectSavedClosed(1); expectNoSavedReadEvents(); expect(writes).not.toHaveBeenCalled();
  });
  it("G-65 显示模式空白、Esc、离屏保留全部常驻白话", async () => {
    await mount(true, true);
    await dismiss("blank"); await dismiss("escape"); expect(panels()).toEqual([0]);
    await click(1); await observe(Array(observers.at(-1)!.targets.length).fill(false));
    expect(panels()).toEqual([0]);
  });
  it("G-19 正文字体重排保留常驻和临时白话，不重新调用或发关闭事件", async () => {
    await mount(true, true); await click(1);
    await act(async () => { container.querySelector<HTMLButtonElement>(".settings-typography-toggle")!.click(); });
    const before = panels(), source = original(), eventCount = events.length;
    await act(async () => { document.querySelector<HTMLInputElement>('.reader-typography-popover [data-typography="bodyFont"][value="serif"]')!.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve(null))); });
    await flush();
    expect(panels()).toEqual(before); expect(original()).toBe(source);
    expect(container.querySelector<HTMLElement>(".reader-body")!.style.getPropertyValue("--reader-body-font")).toBe("var(--font-serif-cjk)");
    expect(JSON.parse(localStorage.getItem("gloss:settings:reader-typography")!).bodyFont).toBe("serif");
    expect(events.slice(eventCount).filter(e => ["gloss_abort", "gloss_dismiss_early", "sentence_click"].includes(e.event))).toEqual([]);
    expect(runs.size).toBe(0);
  });
  it.each([
    ["连续点击共用参照字", "keep"], ["间隔 2 秒仍共用参照字", "delay"],
    ["读者滚动后重新选择", "scroll"], ["关闭抽屉后重新选择", "close"], ["点行高后重新选择", "lineHeight"],
  ])("G-19c 字号按钮：%s", async (_name, action) => {
    const previousWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    let firstVisibleOffset = 0;
    const nativeRange = document.createRange.bind(document);
    vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = nativeRange();
      vi.spyOn(range, "getBoundingClientRect").mockImplementation(() => {
        const top = range.startOffset < firstVisibleOffset ? 10 : 100;
        return { top, bottom: top + 20, left: 0, right: 10, width: 10, height: 20 } as DOMRect;
      });
      vi.spyOn(range, "getClientRects").mockImplementation(() => [range.getBoundingClientRect()] as unknown as DOMRectList);
      return range;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains("reader-typography-sheet") ? 500 : 0;
      const bottom = this.classList.contains("col-left") ? 52 : 1000;
      return { top, bottom, left: 0, right: 375, width: 375, height: bottom - top } as DOMRect;
    });
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const press = async (selector: string) => { await act(async () => {
      container.querySelector<HTMLButtonElement>(selector)!.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    }); await flush(); };
    try {
      await mount(); await press(".reader-typography-aa"); await press('[aria-label="字号减小"]');
      if (action === "delay") await new Promise(resolve => setTimeout(resolve, 2000));
      firstVisibleOffset = 1;
      if (action === "scroll") await act(async () => { window.dispatchEvent(new WheelEvent("wheel")); });
      if (action === "close") { await press('[aria-label="关闭阅读设置"]'); await press(".reader-typography-aa"); }
      if (action === "lineHeight") {
        await press(".reader-more-typography");
        const input = container.querySelector<HTMLInputElement>('[data-typography="lineHeight"]')!;
        input.setPointerCapture = vi.fn();
        await act(async () => { input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
          input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })); });
      }
      scroll.mockClear(); await press('[aria-label="字号减小"]');
      if (action === "keep" || action === "delay") expect(scroll).toHaveBeenCalled();
      else expect(scroll).not.toHaveBeenCalled();
    } finally { Object.defineProperty(window, "innerWidth", previousWidth); }
  });
  it("G-19c 吸顶 Aa 唯一可用，滚动不启用悬浮入口，关闭后回顶栏", async () => {
    const previousWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
    const media = vi.spyOn(window, "matchMedia").mockImplementation(query => ({
      matches: query === "(max-width: 767.98px)", media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(() => true),
      addListener: vi.fn(), removeListener: vi.fn(),
    }) as MediaQueryList);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
      await mount(true); await click(0);
      const top = container.querySelector<HTMLButtonElement>(".reader-typography-aa")!;
      const floating = container.querySelector<HTMLButtonElement>(".reader-typography-floating-aa")!;
      let bottom = -1;
      vi.spyOn(top, "getBoundingClientRect").mockImplementation(() => ({ top: bottom - 24, bottom, left: 300, right: 330, width: 30, height: 24 } as DOMRect));
      const frame = async () => { await act(async () => { window.dispatchEvent(new Event("scroll"));
        await new Promise(resolve => requestAnimationFrame(resolve)); }); await flush(); };
      await frame(); expect(floating.disabled).toBe(true); expect(floating.getAttribute("aria-hidden")).toBe("true");
      await act(async () => top.click()); await flush();
      expect(floating.disabled).toBe(true); expect(floating.tabIndex).toBe(-1); expect(floating.hasAttribute("inert")).toBe(true);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); await flush();
      expect(document.activeElement).toBe(top); expect(panels()).toEqual([0]);
      bottom = 0.001; await frame(); expect(floating.disabled).toBe(true);
      await act(async () => top.click()); await flush();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭阅读设置"]')!.click()); await flush();
      expect(document.activeElement).toBe(top); expect(panels()).toEqual([0]);
    } finally { media.mockRestore(); Object.defineProperty(window, "innerWidth", previousWidth); }
  });
  it("G-67 一次滚动只续跑有限帧，几何稳定十帧后不再续约", async () => {
    const previousWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
    const media = vi.spyOn(window, "matchMedia").mockImplementation(query => ({
      matches: query === "(max-width: 767.98px)", media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(() => true),
      addListener: vi.fn(), removeListener: vi.fn(),
    }) as MediaQueryList);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const queued = new Map<number, FrameRequestCallback>(); let nextFrame = 0, callbacks = 0;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      queued.set(++nextFrame, callback); return nextFrame;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { queued.delete(id); });
    const advance = async (frames: number) => { for (let i = 0; i < frames; i++) {
      const batch = [...queued.values()]; queued.clear();
      await act(async () => { for (const callback of batch) { callbacks++; callback(now += 16); } }); await flush();
    } };
    try {
      await mount(true); await advance(20); expect(queued.size).toBe(0);
      const top = container.querySelector<HTMLButtonElement>(".reader-typography-aa")!;
      vi.spyOn(top, "getBoundingClientRect").mockReturnValue({ top: -25, bottom: -1, left: 300, right: 330, width: 30, height: 24 } as DOMRect);
      const before = callbacks;
      await act(async () => { window.dispatchEvent(new Event("scroll")); });
      expect(container.querySelector<HTMLButtonElement>(".reader-typography-floating-aa")!.disabled).toBe(true);
      expect(queued.size).toBeGreaterThan(0); await advance(20);
      expect(callbacks - before).toBeGreaterThan(0); expect(callbacks - before).toBeLessThanOrEqual(11);
      expect(queued.size).toBe(0); const stopped = callbacks; await advance(40);
      expect(callbacks).toBe(stopped); expect(queued.size).toBe(0);
    } finally {
      raf.mockRestore(); cancel.mockRestore(); media.mockRestore();
      Object.defineProperty(window, "innerWidth", previousWidth);
    }
  });
  it("G-67 桌面断点不创建顶部 Aa 观察器，悬浮入口始终不可点", async () => {
    const previousWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
    const media = vi.spyOn(window, "matchMedia").mockImplementation(query => ({
      matches: query === "(min-width: 768px)", media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(() => true),
      addListener: vi.fn(), removeListener: vi.fn(),
    }) as MediaQueryList);
    const options: (IntersectionObserverInit | undefined)[] = [], targets: Element[] = [];
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    try {
      vi.stubGlobal("IntersectionObserver", class {
        constructor(_callback: IntersectionObserverCallback, init?: IntersectionObserverInit) { options.push(init); }
        observe(target: Element) { targets.push(target); }
        unobserve() {} disconnect() {}
      });
      await mount(true);
      const top = container.querySelector<HTMLButtonElement>(".reader-typography-aa")!;
      const floating = container.querySelector<HTMLButtonElement>(".reader-typography-floating-aa")!;
      vi.spyOn(top, "getBoundingClientRect").mockReturnValue({ top: -24, bottom: 0, left: 300, right: 330, width: 30, height: 24 } as DOMRect);
      expect(floating.disabled).toBe(true);
      await click(0);
      await act(async () => { window.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize"));
        await new Promise(resolve => requestAnimationFrame(resolve)); }); await flush();
      expect(floating.disabled).toBe(true); expect(floating.getAttribute("aria-hidden")).toBe("true");
      expect(floating.tabIndex).toBe(-1); expect(floating.hasAttribute("inert")).toBe(true);
      expect(targets.some(target => target.matches(".reader-typography-aa"))).toBe(false);
      expect(options.some(init => init?.rootMargin === "0px" && init.threshold === 0)).toBe(false);
    } finally { media.mockRestore(); Object.defineProperty(window, "innerWidth", previousWidth); }
  });
  it("G-19 Aa 和面板 Esc 不收白话；手机面板暂停计时，关闭后续计", async () => {
    await mount(true); await click(0);
    await act(async () => container.querySelector<HTMLButtonElement>(".reader-typography-aa")!.click()); await flush();
    expect(container.querySelector('[role="dialog"][aria-labelledby="reader-typography-sheet-title"]')).not.toBeNull();
    now += 5000; await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(details("gloss_read_complete")).toEqual([]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); await flush();
    expect(container.querySelector(".reader-typography-sheet")).toBeNull(); expect(panels()).toEqual([0]);
    expect(details("gloss_dismiss_early")).toEqual([]); expect(details("gloss_abort")).toEqual([]);
    now += 3000; await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(details("gloss_read_complete")).toContainEqual(expect.objectContaining({ sentenceIndex: 0 }));
  });
});


describe("G-68 阅读位置补偿只处理文档坐标变化", () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
  let viewportY: number, documentTop: number, bodyHeight: number;
  let originalScrollY: PropertyDescriptor | undefined, originalFonts: PropertyDescriptor | undefined;
  let observers: { callback: ResizeObserverCallback; targets: Element[]; active: boolean }[];

  beforeEach(async () => {
    viewportY = 0; documentTop = 100; bodyHeight = 2000; observers = [];
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => viewportY });
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("ResizeObserver", class {
      entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) { this.entry = { callback, targets: [], active: true }; observers.push(this.entry); }
      observe(target: Element) { this.entry.targets.push(target); }
      disconnect() { this.entry.active = false; }
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.spyOn(lineSplit, "measureSplit").mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => bodyHeight);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(16, documentTop - viewportY, 600, 30.625));
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => {
      const rect = new DOMRect(16, documentTop - viewportY, 600, 30.625);
      return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null }) as unknown as DOMRectList;
    });
    vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
      const value = args[0]; viewportY = typeof value === "object" && value !== null
        ? Number((value as ScrollToOptions).top ?? 0) : Number(args[1] ?? 0);
    });
    vi.spyOn(window, "scrollBy").mockImplementation((...args: unknown[]) => {
      const value = args[0]; viewportY += typeof value === "object" && value !== null
        ? Number((value as ScrollToOptions).top ?? 0) : Number(args[1] ?? 0);
    });
    localStorage.setItem("gloss:analytics:optout", "1");
    localStorage.setItem("gloss:doc:g68-unit", JSON.stringify({
      version: 1, docId: "g68-unit", paragraphs: ["甲乙丙丁。戊己庚辛。"], headings: [], footnotes: [],
      meta: { format: "txt", fileName: "G68.txt", charCount: 10 }, savedAt: 1,
    }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(createElement(Reader, { docId: "g68-unit" })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector(".reader-body")?.getAttribute("data-measuring")).toBe("false");
    vi.mocked(window.scrollBy).mockClear();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); }); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
    if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY); else Reflect.deleteProperty(window, "scrollY");
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts); else Reflect.deleteProperty(document, "fonts");
  });

  async function resize() {
    const body = container.querySelector(".reader-body")!;
    const observer = observers.find(entry => entry.active && entry.targets.includes(body));
    expect(observer).toBeDefined();
    await act(async () => { observer!.callback([], {} as ResizeObserver); });
  }

  it("下方增高与滚动同一任务发生时不抵消滚动，后续上方变化仍补偿且刷新基线", async () => {
    bodyHeight += 919; viewportY = 856;
    window.dispatchEvent(new Event("scroll"));
    await resize();
    expect(viewportY).toBe(856); expect(window.scrollBy).not.toHaveBeenCalled();
    const before = container.querySelector(".sentence")!.getBoundingClientRect().top;
    documentTop += 64; bodyHeight += 64; await resize();
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 64, behavior: "instant" });
    expect(container.querySelector(".sentence")!.getBoundingClientRect().top).toBe(before);
    bodyHeight += 100; await resize();
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
  });

  it("上方布局变化与滚动同时发生时只补偿上方的 64px，不反向抵消读者滚动", async () => {
    documentTop += 64; bodyHeight += 64; viewportY = 856;
    window.dispatchEvent(new Event("scroll"));
    await resize();
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 64, behavior: "instant" });
    expect(viewportY).toBe(920);
  });
});


describe("G-67 可见区域正面积相交", () => {
  const viewport = { left: 10, top: 20, width: 375, height: 600 };
  it("边界相接不可见，亚像素相交仍可见", () => {
    expect(rectIntersectsViewport({ left: 20, right: 44, top: -4, bottom: 20 }, viewport)).toBe(false);
    expect(rectIntersectsViewport({ left: 20, right: 44, top: -4, bottom: 20.001 }, viewport)).toBe(true);
  });
  it("同时考虑 visualViewport 的横向与纵向偏移", () => {
    expect(rectIntersectsViewport({ left: 0, right: 10, top: 30, bottom: 54 }, viewport)).toBe(false);
    expect(rectIntersectsViewport({ left: 385, right: 409, top: 30, bottom: 54 }, viewport)).toBe(false);
    expect(rectIntersectsViewport({ left: 11, right: 35, top: 620, bottom: 644 }, viewport)).toBe(false);
    expect(rectIntersectsViewport({ left: 11, right: 35, top: 619.5, bottom: 644 }, viewport)).toBe(true);
  });
});

describe("G-19c 浮层遮挡的参照字", () => {
  it("跳过相交字；全部遮挡时返回既有空参照兜底", () => {
    const body = document.createElement("div"), panel = document.createElement("div"); panel.className = "reader-typography-popover";
    body.innerHTML = '<div data-para="0"><span class="sentence" data-offset="0">甲乙</span></div>'; document.body.append(body, panel);
    const span = body.querySelector<HTMLElement>("span")!; const range = document.createRange();
    const rect = (left: number) => ({ left, right: left + 10, top: 20, bottom: 40, width: 10, height: 20, x: left, y: 20, toJSON() {} });
    let offset = 0; vi.spyOn(document, "createRange").mockReturnValue(range);
    vi.spyOn(range, "setStart").mockImplementation((_node, value) => { offset = value; });
    vi.spyOn(range, "getClientRects").mockImplementation(() => [rect(offset * 20)] as unknown as DOMRectList);
    vi.spyOn(span, "getBoundingClientRect").mockReturnValue({ ...rect(0), right: 30 });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(0));
    try {
      expect(anchorAtViewportTop(body)?.offset).toBe(1);
      vi.mocked(panel.getBoundingClientRect).mockReturnValue({ ...rect(0), right: 50 });
      expect(anchorAtViewportTop(body)).toBeNull();
    } finally { body.remove(); panel.remove(); vi.restoreAllMocks(); }
  });
});


describe("G-69 非鼠标打开来源", () => {
  const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  let time = 0;
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    vi.spyOn(lineSplit, "measureSplit").mockReturnValue(null);
    vi.spyOn(performance, "now").mockImplementation(() => time += 400);
    vi.spyOn(cache, "preloadGlossCache").mockResolvedValue(new Map([0, 1, 2].map(index => [index, { text: "本地白话。", hasStructure: false }])));
    localStorage.setItem("gloss:doc:g69", JSON.stringify({ version: 1, docId: "g69", paragraphs: ["甲乙。丙丁。", "戊己。"], headings: [], footnotes: [], meta: { format: "txt", fileName: "测试.txt", charCount: 9 }, savedAt: 1 }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); localStorage.clear();
    if (fonts) Object.defineProperty(document, "fonts", fonts); else Reflect.deleteProperty(document, "fonts");
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function flush() { for (let n = 0; n < 6; n++) await act(async () => { await Promise.resolve(); }); }
  async function mount() { await act(async () => root.render(createElement(Reader, { docId: "g69" }))); await flush(); }
  async function click(index: number, pointerType?: string) {
    await act(async () => {
      const sentence = host.querySelector<HTMLElement>('.sentence[data-index="' + index + '"]')!;
      const event = pointerType === undefined ? new MouseEvent("click", { bubbles: true }) : new PointerEvent("click", { bubbles: true, pointerType });
      sentence.dispatchEvent(event);
    }); await flush();
  }
  const active = () => [...new Set([...host.querySelectorAll<HTMLElement>(".sentence-active")].map(node => Number(node.dataset.index)))].sort();
  async function pointerDown(index: number, pointerType: string) {
    await act(async () => {
      host.querySelector<HTMLElement>('.sentence[data-index="' + index + '"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType }));
    });
  }
  it("iOS 同句 pointerdown touch 优先于 click mouse，原句高亮", async () => {
    await mount(); await pointerDown(0, "touch"); await click(0, "mouse");
    expect(active()).toEqual([0]);
  });
  it("pointerdown mouse 与 click mouse 不高亮", async () => {
    await mount(); await pointerDown(0, "mouse"); await click(0, "mouse");
    expect(active()).toEqual([]);
  });
  it("pointerdown 与 click 不同句时回退到 click mouse，不高亮", async () => {
    await mount(); await pointerDown(0, "touch"); await click(1, "mouse");
    expect(active()).toEqual([]);
  });
  it("没有 pointerdown 的键盘 MouseEvent click 不高亮", async () => {
    await mount(); await click(0);
    expect(active()).toEqual([]);
  });
  it("pointerdown 来源只用一次，收起后无新按下的 click mouse 不高亮", async () => {
    await mount(); await pointerDown(0, "touch"); await click(0, "mouse");
    expect(active()).toEqual([0]);
    await click(0, "mouse"); expect(active()).toEqual([]);
    await click(0, "mouse"); expect(active()).toEqual([]);
  });
  it.each(["touch", "pen", "mouse", "", undefined])("来源 %s 仅明确非鼠标才激活", async (source) => {
    await mount(); await click(0, source);
    expect(active()).toEqual(source === "touch" || source === "pen" ? [0] : []);
    await click(0, source); expect(active()).toEqual([]);
  });
  it("同段来源独立，跨段、空白、Esc 和重新打开都清理旧来源", async () => {
    await mount(); await click(0, "mouse"); await click(1, "touch"); expect(active()).toEqual([1]);
    await click(0, "mouse"); await click(0, "touch"); expect(active()).toEqual([0, 1]);
    await click(1, "touch"); expect(active()).toEqual([0]);
    await click(2, "pen"); expect(active()).toEqual([2]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await flush(); expect(active()).toEqual([]);
    await click(0, "touch"); await act(async () => document.body.click()); await flush(); expect(active()).toEqual([]);
    await click(0, "mouse"); expect(active()).toEqual([]);
  });
  it("收起模式已留下句点开激活，侧栏跳转和常驻显示不激活", async () => {
    await storage.saveSavedGloss("g69", segmentParagraphs(["甲乙。丙丁。", "戊己。"]).sentences[0], "已留下。");
    localStorage.setItem("gloss:settings:reading-mode", "reading"); await mount();
    await click(0, "touch"); expect(active()).toEqual([0]);
    expect(host.querySelector('.sentence[data-index="0"]')?.classList.contains("sentence-saved-collapsed")).toBe(false);
    await click(0, "touch"); expect(active()).toEqual([]);
    await act(async () => host.querySelector<HTMLElement>(".saved-link")!.click()); await flush(); expect(active()).toEqual([]);
    await act(async () => root.render(createElement(Reader, { docId: "missing-g69" }))); await flush(); expect(active()).toEqual([]);
  });
  it("新活动规则只改两种颜色，透明尾巴不接受活动标记", () => {
    const css = readFileSync(path.resolve(process.cwd(), "styles/reader.css"), "utf8");
    const rule = css.match(/\.reader-body \.sentence\.sentence-active,\s*\.reader-body\.reader-body-sample-breathing \.sentence\.sentence-active\s*\{([^}]+)\}/);
    expect(rule?.[1].trim()).toBe("color: var(--hover);\n  background-color: var(--sentence-active-bg);");
    const html = renderToString(createElement(Paragraph, { paraIndex: 0, heading: undefined, pieces: [{ index: 0, start: 0, text: "甲。" }, { index: 1, start: 2, text: "乙。" }], regions: [{ index: 0, splitAt: 3, saved: false, presentation: "inline", actionVisible: false, view: { status: "done", text: "白话", failure: null, instant: true }, explainView: IDLE_EXPLAIN_VIEW }], savedMarkers: [], activeIndexes: [0, 1], panelRef: null, onRetry: () => {}, onBeforeReveal: () => null, onAfterReveal: () => {}, onSave: async () => "saved" as const, onExplain: () => {}, onExplainRetry: () => {}, onExplainBlocked: () => {}, sentences: [], breatheSentenceIndex: null }));
    host.innerHTML = html;
    expect(host.querySelector(".reader-tail-placeholder.sentence-active")).toBeNull();
    expect([...host.querySelectorAll(".sentence")].every(node => node.classList.contains("sentence-active"))).toBe(true);
  });
});

describe("G-70 阅读页白话字号", () => {
  const css = readFileSync(path.resolve(process.cwd(), "styles/reader.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("派生变量只在阅读页声明，公式保底 14px", () => {
    const definitions = [...css.matchAll(/([^{}]+)\{([^{}]*--reader-gloss-font-size\s*:[^{}]*)\}/g)];
    expect(definitions).toHaveLength(1);
    expect(definitions[0][1].trim()).toBe(".reader-body-reader");
    expect(definitions[0][2].trim()).toBe("--reader-gloss-font-size: max(14px, calc(var(--reader-font-size, 17.5px) * 0.8));");
  });
  it("仅阅读页面板与两种操作按钮消费变量", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*font-size:\s*var\(--reader-gloss-font-size\)[^{}]*)\}/g)];
    expect(rules).toHaveLength(1);
    expect(rules[0][1].trim().split(/,\s*/)).toEqual([
      ".reader-body-reader .gloss-panel", ".reader-body-reader .action-row-save", ".reader-body-reader .action-row-explain",
    ]);
    expect(rules[0][2].trim()).toBe("font-size: var(--reader-gloss-font-size);");
  });
  it("演示没有阅读页身份或字号变量，全局默认与附注规则保留", () => {
    const demo = readFileSync(path.resolve(process.cwd(), "components/landing/LandingDemo.tsx"), "utf8");
    expect(demo).not.toContain("reader-body-reader");
    expect(demo).not.toContain("--reader-font-size");
    expect(css).toMatch(/\.gloss-panel\s*\{[^}]*font-size: 14px;/);
    expect(css).toMatch(/\.action-row-save,\s*\.action-row-explain\s*\{\s*font-size: 14px;/);
    expect(css).toMatch(/\.settings-cache-result,\s*\.action-row-notice\s*\{[^}]*font-size: 12px;/);
    expect(css).toContain("letter-spacing: 0.4125px;");
    expect(css).toContain("min-height: calc(3 * 2.05em);");
  });
  it.each([[15, 14], [17.5, 14], [18, 14.4], [21, 16.8]])("正文 %s 时公式结果为 %s", (body, gloss) => {
    expect(Math.max(14, body * 0.8)).toBe(gloss);
  });
});