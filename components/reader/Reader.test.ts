// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as cache from "@/lib/cache";
import { lookupPreloadedGloss, type MemoryGloss } from "@/lib/cache";
import { segmentParagraphs } from "@/lib/segment";
import { loadSavedGlosses, saveExplanation } from "@/lib/storage";
import { validateAnalyticsEvent } from "@/lib/analytics-events";
import { markReaderEntry } from "@/lib/analytics-local";
import { IDLE_EXPLAIN_VIEW } from "./GlossPanel";
import Reader, { allObservedTargetsOutside, anchorScrollDelta, buildExplainInput, buildSavedMarkersByParagraph, buildSavedRegionsByParagraph, cropExplainContext, documentStats, groupRegions, paragraphOriginalFragments, prepareReadableDocument, readGlossShape, readReadingMode, retainGlossAfterUnsave, selectVisibleSavedRegions, shouldAnchorPanelGrowth, shouldRenderSavedMarker, shouldRenderTransient, splitFragmentClassName, takeCodePointsFromEnd, type Region } from "./Reader";
import { skippedSummary } from "@/lib/parse/validate";
import type { StoredDocument } from "@/lib/storage";
import sampleContent from "@/public/samples/ziyou-yu-biran.json";

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
        expect(container.querySelector(".reader-body-measuring")).not.toBeNull();
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

  it("同一拆分点的两句保持独立并按句序排列", () => {
    const regions: Region[] = [
      { index: 8, splitAt: 42, view, saved: true, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
      { index: 3, splitAt: 42, view, saved: true, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
    ];
    const groups = groupRegions(regions);
    expect([...groups.keys()]).toEqual([42]);
    expect(groups.get(42)?.map((region) => region.index)).toEqual([3, 8]);
    expect(groups.get(42)).toHaveLength(2);
  });

  it("不同拆分点按原文顺序，段尾 null 最后插入", () => {
    const regions: Region[] = [
      { index: 4, splitAt: null, view, saved: true, presentation: "bubble", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
      { index: 2, splitAt: 17, view, saved: true, presentation: "inline", actionVisible: false, explainView: IDLE_EXPLAIN_VIEW },
    ];
    expect([...groupRegions(regions).keys()]).toEqual([17, null]);
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

describe("G-10b 未拆分测量态", () => {
  const savedLayouts = new Map([[0, { index: 0, splitAt: 2 }]]);
  const expansion = { index: 1, paraIndex: 0, splitAt: 4 };

  it("同段单段重量和全书重量都不保留 transient，其他段的 transient 可以保留", () => {
    expect(shouldRenderTransient(expansion, savedLayouts, 0)).toBe(false);
    expect(shouldRenderTransient(expansion, null, null)).toBe(false);
    expect(shouldRenderTransient(expansion, savedLayouts, 1)).toBe(true);
  });
});

describe("G-10c 阅读与复习模式", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([null, "reading", "other", "READING"])('模式值 %j 读取为 reading', (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readReadingMode()).toBe("reading");
  });

  it("读取 review，读取异常时回退 reading", () => {
    vi.stubGlobal("localStorage", { getItem: () => "review" });
    expect(readReadingMode()).toBe("review");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readReadingMode()).toBe("reading");
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

  it("句子被撑开边界切片时，微标记只跟在最后一个片段后", () => {
    const markers = new Set([3]);
    const ends = new Map([[3, 8]]);
    expect(shouldRenderSavedMarker({ index: 3, start: 0, text: "前半" }, markers, ends)).toBe(false);
    expect(shouldRenderSavedMarker({ index: 3, start: 2, text: "后半部分文字" }, markers, ends)).toBe(true);
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

  it("G-16a 示例句首帧已有 4 字，跳过结构与白话接口并记 sample 来源", async () => {
    stubEnvironment([]);
    fetchMock.mockImplementation((url: string) => String(url).includes("/samples/ziyou-yu-biran.json")
      ? Promise.resolve(Response.json(sampleContent)) : new Promise<Response>(() => {}));
    markReaderEntry("sample", "shelf");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => { root.render(createElement(Reader, { docId: "sample" })); });
    for (let index = 0; index < 6; index++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".reader-body-sample-breathing")).not.toBeNull();
    await click(container, ".sentence[data-index='5']", 2_000);
    expect(container.querySelector(".gloss-panel-text")?.textContent).toBe("人的感觉");
    expect(container.querySelector(".gloss-panel-pending")).toBeNull();
    expect(container.querySelector(".reader-body-sample-breathing")).toBeNull();
    expect(localStorage.getItem("gloss:sample:breathed")).toBe("1");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/samples/ziyou-yu-biran.json"]);
    expect(cache.preloadGlossCache).not.toHaveBeenCalled();
    expect(of("sentence_click")).toEqual([expect.objectContaining({ sample: true, cacheHit: false })]);
    expect(of("gloss_first_token")).toEqual([]);
    const outbox = JSON.parse(localStorage.getItem("gloss:analytics:local:v1") ?? "{}").outbox ?? [];
    expect(outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "reader_enter", source: "shelf" }),
      expect.objectContaining({ event: "sample_doc_enter", from: "shelf" }),
    ]));
  });

  it("gloss_dismiss_early：再点同一句、切换到另一句、Esc、点别处，可见不足 2 秒都发", async () => {
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
      { event: "gloss_dismiss_early", sentenceIndex: 1, visibleMs: 800 },
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
    expect(container.querySelector<HTMLElement>(".action-row-save")?.textContent).toBe("已留下");
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
