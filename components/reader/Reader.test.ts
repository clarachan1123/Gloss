import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupPreloadedGloss, type MemoryGloss } from "@/lib/cache";
import { segmentParagraphs } from "@/lib/segment";
import { loadSavedGlosses } from "@/lib/storage";
import { IDLE_EXPLAIN_VIEW } from "./GlossPanel";
import { anchorScrollDelta, buildSavedMarkersByParagraph, buildSavedRegionsByParagraph, groupRegions, paragraphOriginalFragments, readGlossShape, readReadingMode, retainGlossAfterUnsave, selectVisibleSavedRegions, shouldRenderSavedMarker, shouldRenderTransient, splitFragmentClassName, type Region } from "./Reader";

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
