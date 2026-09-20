"use client";

import Link from "next/link";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import Notice from "@/components/Notice";
import SettingsPanel from "@/components/settings/SettingsPanel";
import {
  lookupPreloadedGloss,
  mergePreloadedGlosses,
  preloadGlossCache,
  saveGlossCache,
  type MemoryGloss,
} from "@/lib/cache";
import { MAX_AFTER, MAX_BEFORE, MAX_EXPLAIN_CONTEXT_CHARS } from "@/lib/context";
import { streamExplain, type ExplainInput } from "@/lib/explain-client";
import { fetchStructure, streamGloss } from "@/lib/gloss-client";
import { countChars, skippedSummary, type ParsedHeading } from "@/lib/parse/validate";
import { TERM_CLOSE, TERM_OPEN } from "@/lib/prompts/gloss";
import { STRUCTURE_PROMPT_VERSION } from "@/lib/prompts/structure";
import { segmentParagraphs, type Sentence as SentenceData } from "@/lib/segment";
import {
  StorageError,
  loadDocument,
  loadExplanations,
  loadReadingPosition,
  loadSavedGlosses,
  loadStructure,
  removeSavedGloss,
  saveSavedGloss,
  saveReadingPosition,
  saveExplanation,
  saveStructure,
  touchShelfEntry,
  type SavedGloss,
  type StorageErrorCode,
  type StoredDocument,
} from "@/lib/storage";
import GlossPanel, { IDLE_EXPLAIN_VIEW, LOADING_VIEW, type ExplainView, type GlossView } from "./GlossPanel";
import Sentence from "./Sentence";

/** 滚动停下多久后保存阅读位置 */
const SAVE_DELAY_MS = 300;

/** 句首离视口顶端在这个距离内，就算「已到顶」（吸收滚动后的亚像素误差） */
const TOP_TOLERANCE_PX = 2;

/** G1：同一句 300ms 内的重复点击只算一次 */
const CLICK_DEBOUNCE_MS = 300;

/** 撑开 / 收起动画时长 */
const ANIMATION_MS = 220;

/** G6：自动微调滚动时，句首与撑开区底边离视口边缘至少留出的距离 */
const VISIBLE_MARGIN_PX = 16;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; doc: StoredDocument; savedGlosses: Map<number, SavedGloss> }
  | { status: "missing" }
  | { status: "unavailable" };

const HEADING_TAGS: ElementType[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** 段内的一个句子片段：显示文本，以及它在段落显示文本中的起始偏移 */
interface Piece {
  index: number;
  start: number;
  text: string;
}

/**
 * 当前撑开的句子（同时只有一个非锁定撑开态）。
 * splitAt：段落在这个偏移处拆开——它是「句子最后一个字所在行」的下一行行首；
 * null 表示句子在段落最后一行结束（或是标题），撑开区直接放在整段之后。
 */
interface Expansion {
  index: number;
  paraIndex: number;
  splitAt: number | null;
}

type GlossShape = "inline" | "bubble";
type ReadingMode = "reading" | "review";

interface SavedRegion {
  index: number;
  splitAt: number | null;
}

interface PendingOpen {
  index: number;
  anchor: CharAnchor | null;
  animateOpen: boolean;
}

interface SaveContext {
  activeIndex: number | null;
  docId: string;
  expansion: Expansion | null;
  glossView: GlossView;
  savedGlosses: ReadonlyMap<number, SavedGloss>;
  savedRegions: ReadonlyMap<number, SavedRegion> | null;
  readingMode: ReadingMode;
  sentences: readonly SentenceData[];
}

/** 同段多处插入都来自未拆分原文的一次测量。 */
export interface Region {
  index: number;
  splitAt: number | null;
  view: GlossView;
  saved: boolean;
  presentation: GlossShape;
  actionVisible: boolean;
  explainView: ExplainView;
}

/** 视口锚点：段内某个字在 DOM 变化前的视口纵坐标。DOM 变化后把这个字滚回原位 */
interface CharAnchor {
  paraIndex: number;
  offset: number;
  viewportTop: number;
}

interface Transaction {
  anchor: CharAnchor | null;
  animateOpen: boolean;
  /** false 时只维护视口锚点，不重复执行首次展开的 G6 可见性微调。 */
  adjustVisibility?: boolean;
}

/** 阅读位置锚：视口顶部所在的句子，及其首行在视口中的纵坐标 */
interface PositionAnchor {
  index: number;
  offset: number;
  layout: string;
  measure: string;
}

interface Animation {
  elements: HTMLElement[];
  panel: HTMLElement | null;
  timer?: number;
}

const EMPTY_SAVED_GLOSSES = new Map<number, SavedGloss>();
const EMPTY_EXPLAIN_VIEWS = new Map<number, ExplainView>();
const GLOSS_SHAPE_KEY = "gloss:settings:gloss-shape";
const READING_MODE_KEY = "gloss:settings:reading-mode";

export function readGlossShape(): GlossShape {
  try {
    return globalThis.localStorage?.getItem(GLOSS_SHAPE_KEY) === "bubble" ? "bubble" : "inline";
  } catch {
    return "inline";
  }
}

export function readReadingMode(): ReadingMode {
  try {
    return globalThis.localStorage?.getItem(READING_MODE_KEY) === "review" ? "review" : "reading";
  } catch {
    return "reading";
  }
}

/** 取消保存后保留正在看的版本，仅供本会话再次打开命中；绝不写入 IndexedDB。 */
export function retainGlossAfterUnsave(
  memory: Map<number, MemoryGloss>,
  index: number,
  view: GlossView,
  hasStructure: boolean,
): void {
  if (!memory.has(index) && view.status === "done") {
    memory.set(index, { text: view.text, hasStructure, source: "session", shown: true });
  }
}

export default function Reader({ docId }: { docId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [expansion, setExpansion] = useState<Expansion | null>(null);
  const [savedRegions, setSavedRegions] = useState<ReadonlyMap<number, SavedRegion> | null>(null);
  const [measuringParaIndex, setMeasuringParaIndex] = useState<number | null>(null);
  const [activeSavedIndex, setActiveSavedIndex] = useState<number | null>(null);
  const [expandedSavedIndex, setExpandedSavedIndex] = useState<number | null>(null);
  const [glossShape, setGlossShape] = useState<GlossShape>("inline");
  const [readingMode, setReadingMode] = useState<ReadingMode>("reading");
  const [fontsReady, setFontsReady] = useState(false);
  const bodyRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<PositionAnchor>({ index: 0, offset: 0, layout: "", measure: "" });
  const transactionRef = useRef<Transaction | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const collapseTimerRef = useRef<number | undefined>(undefined);
  const lastToggleRef = useRef<{ index: number; time: number } | null>(null);
  const restoredDocRef = useRef<string | null>(null);
  const pendingOpenRef = useRef<PendingOpen | null>(null);
  /** 宽度／字体导致全书重量时，事务必须留到最终（已插回）布局才消费。 */
  const pendingMeasureTransactionRef = useRef<Transaction | null>(null);
  const savedRegionArraysRef = useRef<readonly (readonly Region[])[]>([]);
  const savedMarkerArraysRef = useRef<readonly (readonly number[])[]>([]);
  const pendingSavedJumpRef = useRef<number | null>(null);
  // Paragraph 是 memo；保存操作的回调也必须恒定，不能因为当前句或保存集合改变而让全书失效。
  const saveContextRef = useRef<SaveContext | null>(null);

  // 功能二请求属于 Reader，不属于可能随收起卸载的 GlossPanel。
  const [explainViews, setExplainViews] = useState<ReadonlyMap<number, ExplainView>>(EMPTY_EXPLAIN_VIEWS);
  const explainViewsRef = useRef<ReadonlyMap<number, ExplainView>>(EMPTY_EXPLAIN_VIEWS);
  const explainRunsRef = useRef(new Map<string, number>());
  const explainRunIdRef = useRef(0);
  const explainContextRef = useRef<{ docId: string; sentences: readonly SentenceData[]; paragraphs: readonly string[] }>({ docId, sentences: [], paragraphs: [] });
  const mountedRef = useRef(false);

  // 功能一（G-07）
  const [gloss, setGloss] = useState<{ index: number; view: GlossView } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  /** 本次会话与 IndexedDB 预载的自动白话；只放 ref，预载完成不触发段落重渲染。 */
  const glossMemoRef = useRef(new Map<number, MemoryGloss>());
  /** 保存区更新只供点击与请求 effect 查询；不会因保存／取消保存重跑请求 effect。 */
  const savedGlossesRef = useRef<Map<number, SavedGloss>>(EMPTY_SAVED_GLOSSES);
  const glossAbortRef = useRef<AbortController | null>(null);
  /** 全书结构摘要；开书时后台算，算好之前为 null */
  const structureRef = useRef<string | null>(null);
  const cachePreloadTokenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 不在本卡中止请求：SPA 离开后 Promise 可以完成并写入原文档 localStorage，
      // 但下面所有 UI 更新都先检查 mountedRef，避免触碰已卸载组件。完整离页中止归 G-29。
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    savedGlossesRef.current = EMPTY_SAVED_GLOSSES;
    explainViewsRef.current = EMPTY_EXPLAIN_VIEWS;
    setExplainViews(EMPTY_EXPLAIN_VIEWS);
    setSavedRegions(null);
    setMeasuringParaIndex(null);
    setActiveSavedIndex(null);
    setExpandedSavedIndex(null);
    setFontsReady(false);
    setReadingMode(readReadingMode());
    try {
      const doc = loadDocument(docId);
      if (!doc) {
        setState({ status: "missing" });
        return;
      }
      // Web Crypto 的身份核对完成前不提交正文，避免先出现原文、随后插入保存白话。
      const currentSentences = segmentParagraphs(doc.paragraphs).sentences;
      setGlossShape(readGlossShape());
      void Promise.all([loadSavedGlosses(docId, currentSentences), loadExplanations(docId, currentSentences)])
        .then(([savedGlosses, explanations]) => {
          if (cancelled) return;
          savedGlossesRef.current = savedGlosses;
          const loadedViews = new Map<number, ExplainView>(
            [...explanations].map(([index, entry]) => [
              index,
              { status: "done", text: entry.text, sentenceCount: countCompleteSentences(entry.text), failure: null },
            ]),
          );
          explainViewsRef.current = loadedViews;
          setExplainViews(loadedViews);
          setState({ status: "ready", doc, savedGlosses });
        })
        .catch(() => {
          if (cancelled) return;
          // 保存区损坏或核对失败不能阻塞阅读；本次按空保存区继续，原记录仍不删除。
          savedGlossesRef.current = EMPTY_SAVED_GLOSSES;
          explainViewsRef.current = EMPTY_EXPLAIN_VIEWS;
          setExplainViews(EMPTY_EXPLAIN_VIEWS);
          setState({ status: "ready", doc, savedGlosses: EMPTY_SAVED_GLOSSES });
        });
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      setState({ status: "unavailable" });
    }
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const doc = state.status === "ready" ? state.doc : null;
  const savedGlosses = state.status === "ready" ? state.savedGlosses : EMPTY_SAVED_GLOSSES;

  // G-13：只有文档已成功载入才计作一次打开，避免无效路由污染最近阅读。
  useEffect(() => {
    if (doc) touchShelfEntry(docId);
  }, [doc, docId]);

  // 本机中文字体没有可可靠等待的浏览器事件；这里只等 Next 注入的拉丁字体完成，
  // 实际拆行永远读取真实正文 DOM 的 getClientRects()，不把 fonts.ready 当作中文字体证明。
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const fonts = document.fonts;
    if (!fonts) {
      setFontsReady(true);
      return;
    }
    void fonts.ready.finally(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // 不存 sentences，每次加载重算（G-03 保证确定性）
  const sentences = useMemo(() => (doc ? segmentParagraphs(doc.paragraphs).sentences : []), [doc]);
  explainContextRef.current = { docId, sentences, paragraphs: doc?.paragraphs ?? [] };
  explainViewsRef.current = explainViews;

  const piecesByParagraph = useMemo(() => {
    const groups: Piece[][] = (doc?.paragraphs ?? []).map(() => []);
    for (const s of sentences) {
      const group = groups[s.paraIndex];
      if (!group) continue;
      const previous = group[group.length - 1];
      // 原文段首的全角空格不渲染，缩进由 CSS 的 text-indent 承担
      group.push(
        previous
          ? { index: s.index, start: previous.start + previous.text.length, text: s.text }
          : { index: s.index, start: 0, text: s.text.replace(/^\s+/, "") },
      );
    }
    return groups;
  }, [doc, sentences]);

  const headingByParagraph = useMemo(
    () => new Map((doc?.headings ?? []).map((h) => [h.paraIndex, h])),
    [doc],
  );

  /**
   * G-10b：只在真实、未拆分的正文上量全部保存句。savedRegions 为 null 时 Paragraph
   * 故意不插任何区；这个 layout effect 在绘制前把测量结果同步提交，正文 CSS 同时保持隐藏。
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const initialMeasure = savedRegions === null;
    if (!doc || !body || !fontsReady || (!initialMeasure && measuringParaIndex === null)) return;
    performance.mark("g10b:measure:start");
    const next = new Map(savedRegions ?? []);
    const pending = pendingOpenRef.current;
    const measureIndexes = new Set<number>();
    for (const [index] of savedGlosses) {
      if (initialMeasure || sentences[index]?.paraIndex === measuringParaIndex) measureIndexes.add(index);
    }
    if (pending) measureIndexes.add(pending.index);
    // 全书重测时，正在展开的句子也必须在同一份未拆分 DOM 上取得新 splitAt。
    if (initialMeasure && expansion) measureIndexes.add(expansion.index);
    if (!initialMeasure && measuringParaIndex !== null) {
      for (const [index] of next) {
        if (sentences[index]?.paraIndex === measuringParaIndex) next.delete(index);
      }
    }
    let pendingSplit: number | null | undefined;
    let expansionSplit: number | null | undefined;
    for (const index of measureIndexes) {
      const sentence = sentences[index];
      if (!sentence) continue;
      const splitAt = headingByParagraph.has(sentence.paraIndex) ? null : measureSplit(body, sentence.paraIndex, index);
      if (pendingOpenRef.current?.index === index) pendingSplit = splitAt;
      if (expansion?.index === index) expansionSplit = splitAt;
      if (!savedGlosses.has(index)) continue;
      next.set(index, {
        index,
        splitAt,
      });
    }
    performance.mark("g10b:measure:end");
    performance.measure("g10b:measure", "g10b:measure:start", "g10b:measure:end");
    setSavedRegions(next);
    setMeasuringParaIndex(null);
    pendingOpenRef.current = null;
    if (pending) {
      const sentence = sentences[pending.index];
      if (sentence) {
        const cacheLookup = lookupPreloadedGloss(glossMemoRef.current, pending.index, structureRef.current !== null);
        if (cacheLookup.status === "hit") {
          setGloss({ index: pending.index, view: { status: "done", text: cacheLookup.entry.text, failure: null, instant: true } });
        }
        transactionRef.current = { anchor: pending.anchor, animateOpen: pending.animateOpen };
        setActiveSavedIndex(null);
        setExpansion({ index: pending.index, paraIndex: sentence.paraIndex, splitAt: pendingSplit ?? null });
      }
    } else if (initialMeasure) {
      transactionRef.current = pendingMeasureTransactionRef.current;
      pendingMeasureTransactionRef.current = null;
      if (expansion) {
        setExpansion({ ...expansion, splitAt: expansionSplit === undefined ? expansion.splitAt : expansionSplit });
      }
    }
  }, [doc, expansion, fontsReady, headingByParagraph, measuringParaIndex, savedGlosses, savedRegions, sentences]);

  const cacheInputs = useMemo(
    () => sentences.map((_, index) => ({ index, input: glossInput(sentences, index, null) })),
    [sentences],
  );

  const savedRegionsByParagraph = useMemo(() => {
    const next = buildSavedRegionsByParagraph(
      savedRegionArraysRef.current,
      doc?.paragraphs.length ?? 0,
      sentences,
      savedGlosses,
      savedRegions,
      glossShape,
      explainViews,
    );
    savedRegionArraysRef.current = next;
    return next;
  }, [doc, explainViews, glossShape, savedGlosses, savedRegions, sentences]);

  const visibleSavedRegionsByParagraph = useMemo(() => {
    return selectVisibleSavedRegions(savedRegionsByParagraph, readingMode, expandedSavedIndex);
  }, [expandedSavedIndex, readingMode, savedRegionsByParagraph]);

  const savedMarkersByParagraph = useMemo(() => {
    const next = buildSavedMarkersByParagraph(
      savedMarkerArraysRef.current,
      doc?.paragraphs.length ?? 0,
      sentences,
      savedGlosses,
      readingMode,
      expandedSavedIndex,
    );
    savedMarkerArraysRef.current = next;
    return next;
  }, [doc, expandedSavedIndex, readingMode, savedGlosses, sentences]);

  const regionsByParagraph = useMemo(() => {
    if (!expansion && activeSavedIndex === null && measuringParaIndex === null) return visibleSavedRegionsByParagraph;
    const groups = visibleSavedRegionsByParagraph.slice();
    if (measuringParaIndex !== null) groups[measuringParaIndex] = NO_REGIONS;
    if (activeSavedIndex !== null) {
      const sentence = sentences[activeSavedIndex];
      if (sentence) {
        const regions = groups[sentence.paraIndex] ?? NO_REGIONS;
        groups[sentence.paraIndex] = regions.map((region) =>
          region.index === activeSavedIndex ? { ...region, actionVisible: true } : region,
        );
      }
    }
    if (shouldRenderTransient(expansion, savedRegions, measuringParaIndex)) {
      groups[expansion.paraIndex] = [...(groups[expansion.paraIndex] ?? NO_REGIONS), {
        index: expansion.index,
        splitAt: expansion.splitAt,
        view: gloss && gloss.index === expansion.index ? gloss.view : LOADING_VIEW,
        saved: false,
        presentation: glossShape,
        actionVisible: true,
        explainView: explainViews.get(expansion.index) ?? IDLE_EXPLAIN_VIEW,
      }];
    }
    return groups;
  }, [activeSavedIndex, expansion, explainViews, gloss, glossShape, measuringParaIndex, savedRegions, sentences, visibleSavedRegionsByParagraph]);

  const preloadAutoGloss = useCallback(
    (structure: string | null) => {
      const token = ++cachePreloadTokenRef.current;
      performance.mark("gloss:preload:start");
      void preloadGlossCache(docId, cacheInputs, structure).then((entries) => {
        if (cachePreloadTokenRef.current === token) mergePreloadedGlosses(glossMemoRef.current, entries);
        performance.mark("gloss:preload:end");
      });
    },
    [cacheInputs, docId],
  );

  // 阅读位置：恢复到保存的句子；滚动时记录视口顶部所在的句子；布局变化时保持它在视口中的位置
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!doc || !body || sentences.length === 0 || (savedGlosses.size > 0 && savedRegions === null)) return;

    history.scrollRestoration = "manual";
    const position = positionRef.current;
    if (restoredDocRef.current !== docId) {
      const saved = loadReadingPosition(docId);
      const initial = saved !== null && saved < sentences.length ? saved : 0;
      scrollToSentence(body, initial);
      position.index = initial;
      position.offset = sentenceTop(body, initial);
      position.layout = layoutKey(body);
      position.measure = layoutMeasureKey(body);
      restoredDocRef.current = docId;
    } else {
      const drift = sentenceTop(body, position.index) - position.offset;
      if (Math.abs(drift) > 1) window.scrollBy({ top: drift, behavior: "instant" });
      position.offset = sentenceTop(body, position.index);
      position.layout = layoutKey(body);
      position.measure = layoutMeasureKey(body);
    }

    let timer: number | undefined;
    const flush = () => {
      window.clearTimeout(timer);
      saveReadingPosition(docId, positionRef.current.index);
    };
    const onScroll = () => {
      // 布局刚变过：这次滚动由浏览器保持像素位置造成，不是用户在读，交给 ResizeObserver 处理
      if (layoutKey(body) !== positionRef.current.layout) return;
      rememberTopSentence(body, positionRef.current);
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, SAVE_DELAY_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const observer = new ResizeObserver(() => {
      const current = positionRef.current;
      const key = layoutKey(body);
      const measure = layoutMeasureKey(body);
      // 撑开 / 收起已经自己锚定过视口（见下方事务），这里不再二次校正
      if (key === current.layout) return;
      if (measure !== current.measure && savedGlosses.size > 0) {
        // 测量提交不消费本事务；量完、常驻区与 transient 都插回后才由事务 effect 锚定。
        pendingMeasureTransactionRef.current = { anchor: anchorAtViewportTop(body), animateOpen: false };
        setSavedRegions(null);
        return;
      }
      current.layout = key;
      current.measure = measure;
      // 保持锚句在视口中的位置（不强行对齐到顶端）：窗口宽度、字体加载等布局变化都不带动正在读的内容
      const drift = sentenceTop(body, current.index) - current.offset;
      if (Math.abs(drift) > 1) window.scrollBy({ top: drift, behavior: "instant" });
    });

    observer.observe(body);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [doc, docId, savedGlosses, savedRegions, sentences.length]);

  /* ---------------- 撑开 / 收起 ---------------- */

  function clearAnimation() {
    const animation = animationRef.current;
    if (!animation) return;
    window.clearTimeout(animation.timer);
    for (const el of animation.elements) {
      el.style.transition = "";
      el.style.transform = "";
      el.style.willChange = "";
    }
    if (animation.panel) {
      animation.panel.style.transition = "";
      animation.panel.style.opacity = "";
    }
    animationRef.current = null;
  }

  function cancelPendingCollapse() {
    if (collapseTimerRef.current === undefined) return;
    window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = undefined;
    clearAnimation();
  }

  /**
   * 产品不变量：正在读的内容，永远不因为别处的变化而移动。
   * 所有改变撑开状态（从而改变文档高度）的路径都只能经由这里提交——撑开、点击收起、切换时前一个收起、
   * 点别处 / Esc / 滚出视口自动收起，以及以后新增的任何路径。这里先记下视口参照物
   * （调用方给定时用它，例如被点击的那个字；否则默认取视口顶端第一个完整可见的字），
   * 提交后、绘制前由下方的事务把它滚回原位。
   */
  function commit(next: Expansion | null, options: { anchor?: CharAnchor | null; animateOpen?: boolean } = {}) {
    const body = bodyRef.current;
    transactionRef.current = {
      anchor: options.anchor ?? (body ? anchorAtViewportTop(body) : null),
      animateOpen: options.animateOpen ?? false,
    };
    setActiveSavedIndex(null);
    setExpansion(next);
  }

  function commitSaved(index: number | null, options: { anchor?: CharAnchor | null } = {}) {
    const body = bodyRef.current;
    transactionRef.current = {
      anchor: options.anchor ?? (body ? anchorAtViewportTop(body) : null),
      animateOpen: false,
    };
    setExpansion(null);
    setActiveSavedIndex(index);
  }

  function expandSaved(index: number, options: { anchor?: CharAnchor | null; showActions?: boolean } = {}) {
    const body = bodyRef.current;
    transactionRef.current = {
      anchor: options.anchor ?? (body ? anchorAtViewportTop(body) : null),
      animateOpen: false,
    };
    setExpansion(null);
    setExpandedSavedIndex(index);
    setActiveSavedIndex(options.showActions ? index : null);
  }

  function open(index: number, target: HTMLElement, clientX: number, clientY: number) {
    const body = bodyRef.current;
    const sentence = sentences[index];
    if (!body || !sentence) return;

    cancelPendingCollapse();
    const anchor = anchorAtClick(target, clientX, clientY);
    // 同段已有常驻区时，先在同一同步链里回到未拆分真实 DOM，再量保存区和新临时区。
    const paragraphHasSaved = [...(savedRegions ?? []).keys()].some((savedIndex) => sentences[savedIndex]?.paraIndex === sentence.paraIndex);
    if (paragraphHasSaved) {
      pendingOpenRef.current = { index, anchor, animateOpen: !prefersReducedMotion() };
      setMeasuringParaIndex(sentence.paraIndex);
      return;
    }
    const splitAt = headingByParagraph.has(sentence.paraIndex)
      ? null
      : measureSplit(body, sentence.paraIndex, index);
    // 命中必须和撑开状态同一批 React 更新：第一次 DOM 更新直接放完整白话，不先经过加载态。
    const saved = savedGlosses.get(index);
    if (saved) {
      setGloss({ index, view: { status: "done", text: saved.text, failure: null, instant: true } });
    } else {
      const cacheLookup = lookupPreloadedGloss(glossMemoRef.current, index, structureRef.current !== null);
      if (cacheLookup.status === "hit") {
        const entry = glossMemoRef.current.get(index);
        if (entry) entry.shown = true;
        setGloss({ index, view: { status: "done", text: cacheLookup.entry.text, failure: null, instant: true } });
      }
    }
    // 切换句子时，前一个撑开区在同一次提交里直接移除（不播收起动画），参照物是新点的这一行
    commit(
      { index, paraIndex: sentence.paraIndex, splitAt },
      { anchor, animateOpen: !prefersReducedMotion() },
    );
  }

  function collapse(animate: boolean) {
    const panel = panelRef.current;
    if (!expansion || !panel || collapseTimerRef.current !== undefined) return;

    // D3：生成中收起立即中止请求，不等收起动画放完
    glossAbortRef.current?.abort();

    const rect = panel.getBoundingClientRect();
    // 只在撑开区整体位于视口顶端之下时播动画；其余情况（如自动收起时它已在视口上方）直接移除，由锚定保证可见内容不动
    const canAnimate = animate && !prefersReducedMotion() && rect.top >= 0 && rect.top < window.innerHeight;
    if (!canAnimate) {
      commit(null);
      return;
    }

    // 下方可见内容上滑盖住撑开区，结束后再移除。参照物在移除那一刻才取：
    // 此时下方元素已处于 transform 终点，与移除后的自然位置一致；期间用户滚动也不会让参照物过期
    const shift = panelShift(panel);
    const elements = elementsBelow(panel, shift, 0);
    clearAnimation();
    slide(elements, 0, -shift);
    fade(panel, 1, 0);
    animationRef.current = { elements, panel };
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = undefined;
      commit(null);
    }, ANIMATION_MS);
  }

  function handleBodyClick(event: ReactMouseEvent<HTMLElement>) {
    // G5：用户划选了文字（复制原文），松开鼠标不触发撑开
    if (hasTextSelection()) return;
    const eventTarget = event.target as Element;
    const savedPanel = eventTarget.closest<HTMLElement>(".gloss-panel-saved");
    if (savedPanel && !eventTarget.closest("button")) {
      const index = Number(savedPanel.dataset.savedIndex);
      if (Number.isInteger(index)) commitSaved(activeSavedIndex === index ? null : index);
      return;
    }
    const target = eventTarget.closest<HTMLElement>(".sentence");
    if (!target) return;
    const index = Number(target.dataset.index);

    const now = performance.now();
    const last = lastToggleRef.current;
    if (last && last.index === index && now - last.time < CLICK_DEBOUNCE_MS) return;
    lastToggleRef.current = { index, time: now };

    if (savedRegions?.has(index)) {
      const anchor = anchorAtClick(target, event.clientX, event.clientY);
      if (readingMode === "reading" && expandedSavedIndex !== index) {
        expandSaved(index, { anchor, showActions: true });
      } else {
        commitSaved(activeSavedIndex === index ? null : index, { anchor });
      }
    } else if (expansion?.index === index && collapseTimerRef.current === undefined) {
      collapse(true);
    } else {
      open(index, target, event.clientX, event.clientY);
    }
  }

  // 每次撑开 / 收起提交后、浏览器绘制前：锚定视口 → 自动微调滚动 → 启动动画
  useLayoutEffect(() => {
    const body = bodyRef.current;
    // 真实未拆分 DOM 只供测量，不能在这一次中间提交消费锚定事务。
    if (!body || savedRegions === null || measuringParaIndex !== null) return;
    const transaction = transactionRef.current;
    const pendingSavedJump = pendingSavedJumpRef.current;
    transactionRef.current = null;
    pendingSavedJumpRef.current = null;
    if (!transaction && pendingSavedJump === null) return;

    clearAnimation();

    // ① 视口锚定（产品不变量）：把参照字滚回 DOM 变化前的位置。
    //    改动在参照字下方时补偿为 0（D13 保证上方的行不重排）；改动在上方时，补偿恰好抵消文档高度的变化
    if (transaction?.anchor) {
      const top = charTop(body, transaction.anchor.paraIndex, transaction.anchor.offset);
      if (top !== null) {
        const delta = anchorScrollDelta(transaction.anchor.viewportTop, top);
        if (delta !== 0) window.scrollBy({ top: delta, behavior: "instant" });
      }
    }
    rememberTopSentence(body, positionRef.current);
    positionRef.current.layout = layoutKey(body);
    positionRef.current.measure = layoutMeasureKey(body);

    if (pendingSavedJump !== null) {
      body.querySelector<HTMLElement>(`.sentence[data-index="${pendingSavedJump}"]`)?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "instant" : "smooth",
      });
    }

    // 功能二逐句增长只做字符锚定：不能像首次展开那样追着不断变长的面板自动滚动。
    if (transaction?.adjustVisibility === false) return;

    const panel = panelRef.current;
    if (!expansion || !panel) return;

    // ② G6：整句或撑开区被视口截断时才微调；否则点击行纹丝不动
    const adjustment = visibilityAdjustment(body, expansion.index, panel);

    // ③ 动画：撑开区一次性插入到最终高度（只触发这一次重排），
    //    再让视口内原本就在它下方的元素从旧位置 transform 回来——每帧只动合成层
    if (transaction?.animateOpen) {
      const shift = panelShift(panel);
      const elements = elementsBelow(panel, shift, Math.max(adjustment, 0));
      slide(elements, -shift, 0);
      fade(panel, 0, 1);
      const animation: Animation = { elements, panel };
      animation.timer = window.setTimeout(() => {
        if (animationRef.current === animation) clearAnimation();
      }, ANIMATION_MS + 50);
      animationRef.current = animation;
    }

    if (adjustment !== 0) {
      window.scrollBy({ top: adjustment, behavior: prefersReducedMotion() ? "instant" : "smooth" });
    }
  }, [activeSavedIndex, expandedSavedIndex, explainViews, expansion, glossShape, measuringParaIndex, readingMode, savedRegions]);

  // 收起条件：点别处、Esc（PRD 3.7）、该句滚出视口（G3）
  useEffect(() => {
    const body = bodyRef.current;
    const activeIndexForDismiss = expansion?.index ?? activeSavedIndex;
    if (activeIndexForDismiss === null || !body) return;
    const dismiss = () => {
      if (activeSavedIndex !== null) commitSaved(null);
      else collapse(true);
    };

    const onDocumentClick = (event: MouseEvent) => {
      if (hasTextSelection()) return;
      const target = event.target as Element | null;
      if (target?.closest?.(".sentence, .gloss-panel")) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };

    const visible = new Set<Element>();
    let initialized = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      if (initialized && visible.size === 0) {
        if (activeSavedIndex !== null) commitSaved(null);
        else collapse(false);
      }
      initialized = true;
    });
    body.querySelectorAll(`[data-index="${activeIndexForDismiss}"]`).forEach((span) => observer.observe(span));

    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  });

  useEffect(
    () => () => {
      window.clearTimeout(collapseTimerRef.current);
      clearAnimation();
    },
    [],
  );

  /* ---------------- 功能一：白话（G-07） ---------------- */

  // 全书结构摘要：开书时后台算一次，按 docId 缓存。算好之前的点击不带摘要照常发，不让第一次点击等待
  useEffect(() => {
    structureRef.current = null;
    if (!doc) return;
    const cached = loadStructure(docId, STRUCTURE_PROMPT_VERSION);
    if (cached) {
      structureRef.current = cached;
      preloadAutoGloss(cached);
      return;
    }
    const controller = new AbortController();
    const input = {
      title: doc.meta.fileName?.replace(/\.[^.]+$/, "") || null,
      headings: doc.headings.map((h) => h.text.trim()),
      paragraphs: doc.paragraphs,
    };
    void fetchStructure(input, controller.signal).then((result) => {
      if (!result || controller.signal.aborted) return;
      structureRef.current = result.structure;
      saveStructure(docId, result.prompt, result.structure);
      preloadAutoGloss(result.structure);
    });
    return () => controller.abort();
  }, [doc, docId, preloadAutoGloss]);

  useEffect(() => {
    // 预载尚未完成的点击按未命中处理；这里不写 state，段落不会因预载重渲染。
    preloadAutoGloss(structureRef.current);
  }, [preloadAutoGloss]);

  // 撑开一句就请求它的白话；收起、切换句子、离开页面时中止（D3 / D4）
  const activeIndex = expansion?.index ?? null;
  useEffect(() => {
    if (activeIndex === null) return;
    // 保存区优先于预载缓存；命中时既不读缓存，也不请求接口。
    if (savedGlossesRef.current.has(activeIndex)) return;
    const cacheLookup = lookupPreloadedGloss(glossMemoRef.current, activeIndex, structureRef.current !== null);
    if (cacheLookup.status === "hit") {
      return;
    }

    const controller = new AbortController();
    glossAbortRef.current = controller;
    setGloss({ index: activeIndex, view: LOADING_VIEW });
    const show = (view: GlossView) => setGloss({ index: activeIndex, view });
    const input = glossInput(sentences, activeIndex, structureRef.current);
    void streamGloss(input, {
      signal: controller.signal,
      onText: (text) => show({ status: "streaming", text, failure: null, instant: false }),
    }).then((result) => {
      if (result.status === "aborted" || controller.signal.aborted) return;
      if (result.status === "done") {
        const remembered = { text: result.text, hasStructure: input.structure !== null, source: "session" as const, shown: true };
        glossMemoRef.current.set(activeIndex, remembered);
        void saveGlossCache(docId, input, result.text);
        show({ status: "done", text: result.text, failure: null, instant: false });
      } else {
        show({ status: "failed", text: result.text, failure: result.failure, instant: false });
      }
    });
    return () => controller.abort();
  }, [activeIndex, docId, retryCount, sentences]);

  const retryGloss = useCallback(() => setRetryCount((n) => n + 1), []);

  /**
   * 只有整块面板已经在视口上方时才建立字符锚定：视口顶边切在面板内时，
   * 读者正看的是整句理解，追加必须只向下生长，不能反向滚动这块内容。
   */
  const stageExplainView = useCallback((runDocId: string, index: number, view: ExplainView) => {
    if (!mountedRef.current || explainContextRef.current.docId !== runDocId) return;
    const body = bodyRef.current;
    const panel = body?.querySelector<HTMLElement>(`.gloss-panel[data-sentence-index="${index}"]`);
    if (body && panel && shouldAnchorExplainMutation(panel.getBoundingClientRect().bottom)) {
      transactionRef.current = { anchor: anchorAtViewportTop(body), animateOpen: false, adjustVisibility: false };
    }
    const next = new Map(explainViewsRef.current).set(index, view);
    explainViewsRef.current = next;
    setExplainViews(next);
  }, []);

  const startExplainFor = useCallback((index: number, force = false) => {
    const context = explainContextRef.current;
    const sentence = context.sentences[index];
    if (!sentence) return;
    const current = explainViewsRef.current.get(index) ?? IDLE_EXPLAIN_VIEW;
    if (!force && (current.status === "loading" || current.status === "streaming" || current.status === "done")) return;

    const key = `${context.docId}:${index}`;
    const runId = ++explainRunIdRef.current;
    explainRunsRef.current.set(key, runId);
    stageExplainView(context.docId, index, { status: "loading", text: "", sentenceCount: 0, failure: null });
    const input = buildExplainInput(
      context.paragraphs,
      context.sentences,
      index,
      structureRef.current,
      savedGlossesRef.current,
      glossMemoRef.current,
    );

    void streamExplain(input, (_sentence, fullText) => {
      if (explainRunsRef.current.get(key) !== runId) return;
      stageExplainView(context.docId, index, {
        status: "streaming",
        text: fullText,
        sentenceCount: countCompleteSentences(fullText),
        failure: null,
      });
    })
      .then(async (result) => {
        if (explainRunsRef.current.get(key) !== runId) return;
        if (result.status === "done") {
          try {
            // 即使 Reader 已卸载也写原 docId；只跳过 React 状态更新。SPA 返回首页后仍能记下结果。
            await saveExplanation(context.docId, sentence, result.text);
            stageExplainView(context.docId, index, {
              status: "done",
              text: result.text,
              sentenceCount: countCompleteSentences(result.text),
              failure: null,
            });
          } catch (error) {
            if (!(error instanceof StorageError)) throw error;
            stageExplainView(context.docId, index, {
              status: "failed",
              text: result.text,
              sentenceCount: countCompleteSentences(result.text),
              failure: "storage",
            });
          }
        } else {
          stageExplainView(context.docId, index, {
            status: "failed",
            text: result.text,
            sentenceCount: countCompleteSentences(result.text),
            failure: result.failure,
          });
        }
      })
      .catch(() => {
        if (explainRunsRef.current.get(key) !== runId) return;
        stageExplainView(context.docId, index, {
          status: "failed",
          text: explainViewsRef.current.get(index)?.text ?? "",
          sentenceCount: explainViewsRef.current.get(index)?.sentenceCount ?? 0,
          failure: "unavailable",
        });
      })
      .finally(() => {
        if (explainRunsRef.current.get(key) === runId) explainRunsRef.current.delete(key);
      });
  }, [stageExplainView]);

  const retryExplainFor = useCallback((index: number) => startExplainFor(index, true), [startExplainFor]);
  const recordExplainBlocked = useCallback((index: number) => {
    window.dispatchEvent(new CustomEvent("gloss:analytics", {
      detail: { event: "deep_explain_blocked", sentenceIndex: index },
    }));
  }, []);

  const glossView = gloss && gloss.index === activeIndex ? gloss.view : LOADING_VIEW;
  saveContextRef.current = { activeIndex, docId, expansion, glossView, readingMode, savedGlosses, savedRegions, sentences };
  const toggleSavedGlossFor = useCallback(async (index: number): Promise<"saved" | "removed" | StorageErrorCode> => {
    const context = saveContextRef.current;
    if (!context) return "E2";
    const { activeIndex, docId, expansion, glossView, readingMode, savedGlosses, savedRegions, sentences } = context;
    const sentence = sentences[index];
    if (!sentence) return "E2";

    try {
      if (savedGlosses.has(index)) {
        await removeSavedGloss(docId, sentence);
        const saved = savedGlosses.get(index);
        const retained: GlossView = { status: "done", text: saved?.text ?? "", failure: null, instant: true };
        retainGlossAfterUnsave(glossMemoRef.current, index, retained, structureRef.current !== null);
        // 与 transient state 同一批提交，禁止先挂载 LOADING_VIEW／三行预留再命中会话缓存。
        setGloss({ index, view: retained });
        const next = new Map(savedGlossesRef.current);
        next.delete(index);
        savedGlossesRef.current = next;
        const region = savedRegions?.get(index);
        // 异步写入结束时才抓锚：期间读者可能已经滚到别处。
        const anchor = bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null;
        setState((current) => {
          if (current.status !== "ready") return current;
          return { ...current, savedGlosses: next };
        });
        setSavedRegions((current) => {
          if (!current) return current;
          const layouts = new Map(current);
          layouts.delete(index);
          return layouts;
        });
        setExpandedSavedIndex((current) => current === index ? null : current);
        commit(
          { index, paraIndex: sentence.paraIndex, splitAt: region?.splitAt ?? null },
          { anchor, animateOpen: false },
        );
        return "removed";
      }
      if (index !== activeIndex || glossView.status !== "done" || !expansion) return "E2";
      const entry = await saveSavedGloss(docId, sentence, glossView.text);
      const next = new Map(savedGlossesRef.current).set(index, entry);
      savedGlossesRef.current = next;
      const anchor = bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null;
      setState((current) => {
        if (current.status !== "ready") return current;
        return { ...current, savedGlosses: next };
      });
      setSavedRegions((current) => new Map(current).set(index, { index, splitAt: expansion.splitAt }));
      if (readingMode === "reading") setExpandedSavedIndex(index);
      commitSaved(index, { anchor });
      return "saved";
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      return err.code;
    }
  }, []);
  // 每次重试换一个 key，撑开区重新挂载，逐块放字的进度从头开始
  const glossKey = `${activeIndex}:${retryCount}`;

  const minHeadingLevel = Math.min(...(doc?.headings ?? []).map((h) => h.level));
  // 左栏常驻信息（G-25）：全部来自已存的记录，不随滚动变化，不新增状态
  const skippedLine = skippedSummary(doc?.meta.skipped);
  const changeGlossShape = useCallback((next: GlossShape) => {
    if (next === glossShape) return;
    const body = bodyRef.current;
    transactionRef.current = { anchor: body ? anchorAtViewportTop(body) : null, animateOpen: false };
    try {
      globalThis.localStorage?.setItem(GLOSS_SHAPE_KEY, next);
    } catch {
      // 设置写入失败不妨碍本次阅读；下次仍回退默认形态。
    }
    setGlossShape(next);
  }, [glossShape]);
  const changeReadingMode = useCallback((next: ReadingMode) => {
    if (next === readingMode) return;
    const body = bodyRef.current;
    transactionRef.current = { anchor: body ? anchorAtViewportTop(body) : null, animateOpen: false };
    try {
      globalThis.localStorage?.setItem(READING_MODE_KEY, next);
    } catch {
      // 设置写入失败不妨碍本次阅读；下次仍回退默认阅读模式。
    }
    setActiveSavedIndex(null);
    setExpandedSavedIndex(null);
    setReadingMode(next);
  }, [readingMode]);
  const expandSavedFromMarker = useCallback((index: number) => {
    expandSaved(index);
  }, []);
  const jumpToSaved = useCallback((index: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const needsExpand = readingMode === "reading" && expandedSavedIndex !== index;
    if (needsExpand || activeSavedIndex !== null) {
      pendingSavedJumpRef.current = index;
      transactionRef.current = { anchor: null, animateOpen: false };
      setActiveSavedIndex(null);
      if (needsExpand) {
        setExpansion(null);
        setExpandedSavedIndex(index);
      }
      return;
    }
    body.querySelector<HTMLElement>(`.sentence[data-index="${index}"]`)?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "instant" : "smooth",
    });
  }, [activeSavedIndex, expandedSavedIndex, readingMode]);
  const measuringSavedLayout = savedGlosses.size > 0 && (savedRegions === null || !fontsReady);

  return (
    <div className="shell">
      <aside className="col col-left">
        <Link href="/" className="wordmark">Gloss</Link>
        <Link href="/" className="reader-shelf-back">← 回到书架</Link>

        <div className="mode-switch" role="group" aria-label="白话阅读模式">
          <button
            type="button"
            className="mode-option"
            aria-pressed={readingMode === "reading"}
            onClick={() => changeReadingMode("reading")}
          >
            阅读态
          </button>
          <button
            type="button"
            className="mode-option"
            aria-pressed={readingMode === "review"}
            onClick={() => changeReadingMode("review")}
          >
            复习态
          </button>
        </div>

        {doc && (
          <section className="side-section" aria-labelledby="doc-title">
            <h2 id="doc-title" className="side-title">
              这份文档
            </h2>
            {doc.meta.fileName && <p className="side-file">{doc.meta.fileName}</p>}
            <p className="side-stats">{documentStats(doc, sentences.length)}</p>
            {skippedLine && <p className="side-skipped">{skippedLine}</p>}
          </section>
        )}

        <section className="side-section" aria-labelledby="toc-title">
          <h2 id="toc-title" className="side-title">
            目录
          </h2>
          {doc && doc.headings.length > 0 && (
            <ol className="toc">
              {doc.headings.map((h) => (
                <li key={h.paraIndex} style={{ paddingInlineStart: `${h.level - minHeadingLevel}em` }}>
                  <button
                    type="button"
                    className="toc-link"
                    onClick={() => document.getElementById(`para-${h.paraIndex}`)?.scrollIntoView()}
                  >
                    {h.text.trim()}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {/* 目录块始终在原位：时有时无会让读者困惑，状态自己说明自己（G-25） */}
          {doc && doc.headings.length === 0 && <p className="side-empty">这份文档没有标题层级</p>}
        </section>

        <section className="side-section" aria-labelledby="saved-title">
          <h2 id="saved-title" className="side-title">
            本文沉淀
          </h2>
          {savedGlosses.size === 0 ? (
            <p className="side-empty">还没有保存的白话</p>
          ) : (
            <ol className="saved-list">
              {[...savedGlosses.entries()].sort(([a], [b]) => a - b).map(([index, saved]) => (
                <li key={index}>
                  <button type="button" className="saved-link" onClick={() => jumpToSaved(index)}>
                    {saved.text}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>

      <main className="col col-main">
        {state.status === "missing" && (
          <div className="reader-status">
            <Notice tone="block" message="找不到这份文档。它可能保存在另一个浏览器里，或者本地数据已被清除。" />
            <Link href="/" className="reader-back">
              返回首页重新上传
            </Link>
          </div>
        )}
        {state.status === "unavailable" && (
          <div className="reader-status">
            <Notice tone="block" message="当前浏览器禁止本地存储，无法打开这份文档。" />
          </div>
        )}

        {doc && (
          <article
            ref={bodyRef}
            className={measuringSavedLayout ? "reader-body reader-body-measuring" : "reader-body"}
            lang="zh-CN"
            onClick={handleBodyClick}
          >
            {doc.paragraphs.map((_, paraIndex) => {
              return (
                <Paragraph
                  key={paraIndex}
                  paraIndex={paraIndex}
                  heading={headingByParagraph.get(paraIndex)}
                  pieces={piecesByParagraph[paraIndex] ?? NO_PIECES}
                  regions={regionsByParagraph[paraIndex] ?? NO_REGIONS}
                  savedMarkers={savedRegions === null || measuringParaIndex === paraIndex
                    ? NO_INDEXES
                    : savedMarkersByParagraph[paraIndex] ?? NO_INDEXES}
                  panelRef={panelRef}
                  glossKey={expansion?.paraIndex === paraIndex ? glossKey : undefined}
                  onRetry={retryGloss}
                  onSave={toggleSavedGlossFor}
                  onExpandSaved={expandSavedFromMarker}
                  onExplain={startExplainFor}
                  onExplainRetry={retryExplainFor}
                  onExplainBlocked={recordExplainBlocked}
                  sentences={sentences}
                />
              );
            })}

            {doc.footnotes.length > 0 && (
              <section className="reader-notes" aria-label="脚注">
                <ol>
                  {doc.footnotes.map((f) => (
                    <li key={f.marker}>{f.text}</li>
                  ))}
                </ol>
              </section>
            )}
          </article>
        )}
      </main>

      <aside className="col col-right" aria-labelledby="settings-title">
          <SettingsPanel glossShape={glossShape} onGlossShapeChange={changeGlossShape} />
      </aside>
    </div>
  );
}

/* ---------------- 渲染辅助 ---------------- */

const NO_PIECES: Piece[] = [];
const NO_REGIONS: readonly Region[] = [];
const NO_INDEXES: readonly number[] = [];

export function countCompleteSentences(text: string): number {
  return [...text].filter((char) => char === "。" || char === "！" || char === "？").length;
}

/** 实际锚定与单元测试共用：补偿后参照字的可见位移应为 0。 */
export function anchorScrollDelta(previousViewportTop: number, nextViewportTop: number): number {
  const delta = nextViewportTop - previousViewportTop;
  return Math.abs(delta) > 0.5 ? delta : 0;
}

/** 功能二追加只在整块面板已经离开视口上方时补偿正文字符锚点。 */
export function shouldAnchorExplainMutation(panelBottom: number): boolean {
  return panelBottom <= 0;
}

/** 测量中的段落必须保持为原始、未拆分 DOM，不能残留 transient 插入区。 */
export function shouldRenderTransient(
  expansion: Expansion | null,
  savedRegions: ReadonlyMap<number, SavedRegion> | null,
  measuringParaIndex: number | null,
): expansion is Expansion {
  return expansion !== null && savedRegions !== null && measuringParaIndex !== expansion.paraIndex;
}

/**
 * 保存区按段结构共享：空段永远拿同一个 NO_REGIONS；保存／取消一条时，未变段继续复用
 * 上一次数组引用，Paragraph.memo 因而不会被全书无意义的空数组击穿。
 */
export function buildSavedRegionsByParagraph(
  previous: readonly (readonly Region[])[],
  paragraphCount: number,
  sentences: readonly SentenceData[],
  savedGlosses: ReadonlyMap<number, SavedGloss>,
  savedRegions: ReadonlyMap<number, SavedRegion> | null,
  glossShape: GlossShape,
  explainViews: ReadonlyMap<number, ExplainView> = EMPTY_EXPLAIN_VIEWS,
): readonly (readonly Region[])[] {
  if (savedRegions === null) return Array.from({ length: paragraphCount }, () => NO_REGIONS);
  const candidates: Region[][] = Array.from({ length: paragraphCount }, () => []);
  for (const [index, layout] of savedRegions) {
    const sentence = sentences[index];
    const saved = savedGlosses.get(index);
    if (!sentence || !saved) continue;
    const explainView = explainViews.get(index) ?? IDLE_EXPLAIN_VIEW;
    const old = previous[sentence.paraIndex]?.find((region) => region.index === index);
    candidates[sentence.paraIndex]?.push(
    old && old.splitAt === layout.splitAt && old.view.text === saved.text && old.presentation === glossShape && old.explainView === explainView
        ? old
        : {
            index,
            splitAt: layout.splitAt,
            view: { status: "done", text: saved.text, failure: null, instant: true },
            saved: true,
            presentation: glossShape,
            actionVisible: false,
            explainView,
          },
    );
  }
  return candidates.map((regions, paraIndex) => {
    if (regions.length === 0) return NO_REGIONS;
    regions.sort((a, b) => a.index - b.index);
    const old = previous[paraIndex];
    return old?.length === regions.length && old.every((region, index) => region === regions[index]) ? old : regions;
  });
}

export function buildSavedMarkersByParagraph(
  previous: readonly (readonly number[])[],
  paragraphCount: number,
  sentences: readonly SentenceData[],
  savedGlosses: ReadonlyMap<number, SavedGloss>,
  readingMode: ReadingMode,
  expandedSavedIndex: number | null,
): readonly (readonly number[])[] {
  const candidates: number[][] = Array.from({ length: paragraphCount }, () => []);
  if (readingMode === "reading") {
    for (const [index] of savedGlosses) {
      const sentence = sentences[index];
      if (sentence && index !== expandedSavedIndex) candidates[sentence.paraIndex]?.push(index);
    }
  }
  return candidates.map((indexes, paraIndex) => {
    if (indexes.length === 0) return NO_INDEXES;
    indexes.sort((a, b) => a - b);
    const old = previous[paraIndex];
    return old?.length === indexes.length && old.every((index, offset) => index === indexes[offset]) ? old : indexes;
  });
}

export function selectVisibleSavedRegions(
  regionsByParagraph: readonly (readonly Region[])[],
  readingMode: ReadingMode,
  expandedSavedIndex: number | null,
): readonly (readonly Region[])[] {
  if (readingMode === "review") return regionsByParagraph;
  return regionsByParagraph.map((regions) => {
    const visible = regions.filter((region) => region.index === expandedSavedIndex);
    return visible.length === 0 ? NO_REGIONS : visible;
  });
}

/** 左栏第二行：字数 · 段数 ·（PDF 才有的）页数 · 句数。数字口径与上传页一致 */
function documentStats(doc: StoredDocument, sentenceCount: number): string {
  const n = (value: number) => value.toLocaleString("zh-CN");
  const parts = [`${n(doc.meta.charCount)} 字`, `${n(doc.paragraphs.length)} 段`];
  if (doc.meta.pageCount !== undefined) parts.push(`${n(doc.meta.pageCount)} 页`);
  parts.push(`${n(sentenceCount)} 句`);
  return parts.join(" · ");
}

interface ParagraphProps {
  paraIndex: number;
  heading: ParsedHeading | undefined;
  pieces: Piece[];
  regions: readonly Region[];
  savedMarkers: readonly number[];
  panelRef: Ref<HTMLDivElement>;
  glossKey?: string;
  onRetry: () => void;
  onSave: (index: number) => Promise<"saved" | "removed" | StorageErrorCode>;
  onExpandSaved: (index: number) => void;
  onExplain: (index: number) => void;
  onExplainRetry: (index: number) => void;
  onExplainBlocked: (index: number) => void;
  sentences: readonly SentenceData[];
}

/** 功能一的上下文窗口：目标句 + 前后各至多 2 句（跨段照取）+ 全书结构摘要 */
function glossInput(sentences: readonly SentenceData[], index: number, structure: string | null) {
  const text = (i: number) => sentences[i].text.trim();
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from) }, (_, k) => text(from + k)).filter(Boolean);
  return {
    sentence: text(index),
    before: range(Math.max(0, index - MAX_BEFORE), index),
    after: range(index + 1, Math.min(sentences.length, index + 1 + MAX_AFTER)),
    structure,
  };
}

/** 功能二独立使用“上一段／当前段／下一段”，不影响功能一的前后各两句窗口。 */
export function buildExplainInput(
  paragraphs: readonly string[],
  sentences: readonly SentenceData[],
  index: number,
  structure: string | null,
  savedGlosses: ReadonlyMap<number, SavedGloss>,
  automaticGlosses: ReadonlyMap<number, MemoryGloss>,
): ExplainInput {
  const sentence = sentences[index];
  if (!sentence) throw new Error("explain input requires an existing sentence");
  const context = cropExplainContext(paragraphs, sentence);
  const source = savedGlosses.get(index)?.text ?? automaticGlosses.get(index)?.text ?? null;
  return {
    sentence: sentence.text.trim(),
    context,
    gloss: source ? source.replaceAll(TERM_OPEN, "").replaceAll(TERM_CLOSE, "").trim() || null : null,
    structure,
  };
}

/**
 * 正常情况完整带三段。超出 2,000 字时，当前段最多占 1,200 字并优先保留；
 * 余量默认均分给相邻段，一侧不够时回流到另一侧。省略号是明确的裁剪提示。
 */
export function cropExplainContext(
  paragraphs: readonly string[],
  sentence: Pick<SentenceData, "paraIndex" | "start" | "text">,
): ExplainInput["context"] {
  const previous = sentence.paraIndex > 0 ? paragraphs[sentence.paraIndex - 1]?.trim() || null : null;
  const current = paragraphs[sentence.paraIndex]?.trim() || sentence.text.trim();
  const next = sentence.paraIndex + 1 < paragraphs.length ? paragraphs[sentence.paraIndex + 1]?.trim() || null : null;
  if (contextChars(previous, current, next) <= MAX_EXPLAIN_CONTEXT_CHARS) return { previous, current, next };

  const rawCurrent = paragraphs[sentence.paraIndex] ?? sentence.text;
  const targetStart = Math.max(0, sentence.start);
  const targetEnd = Math.min(rawCurrent.length, targetStart + sentence.text.length);
  const currentBudget = Math.min(1200, countChars(current));
  const croppedCurrent = countChars(current) <= currentBudget
    ? current
    : cropAroundSentence(rawCurrent, targetStart, targetEnd, currentBudget);
  const remainingBudget = MAX_EXPLAIN_CONTEXT_CHARS - countChars(croppedCurrent);
  const { previousBudget, nextBudget } = distributeNeighborBudget(
    countChars(previous ?? ""),
    countChars(next ?? ""),
    remainingBudget,
  );
  return {
    previous: previous ? cropTail(previous, previousBudget) : null,
    current: croppedCurrent,
    next: next ? cropHead(next, nextBudget) : null,
  };
}

function distributeNeighborBudget(previousChars: number, nextChars: number, total: number): { previousBudget: number; nextBudget: number } {
  const preferredPrevious = Math.floor(total / 2);
  const preferredNext = total - preferredPrevious;
  let previousBudget = Math.min(previousChars, preferredPrevious);
  let nextBudget = Math.min(nextChars, preferredNext);
  let remaining = total - previousBudget - nextBudget;
  const previousExtra = Math.min(previousChars - previousBudget, remaining);
  previousBudget += previousExtra;
  remaining -= previousExtra;
  nextBudget += Math.min(nextChars - nextBudget, remaining);
  return { previousBudget, nextBudget };
}

function contextChars(previous: string | null, current: string, next: string | null): number {
  return countChars(previous ?? "") + countChars(current) + countChars(next ?? "");
}

function cropHead(text: string, budget: number): string {
  if (countChars(text) <= budget) return text;
  return `${takeCodePoints(text, Math.max(0, budget - countChars("……")))}……`;
}

function cropTail(text: string, budget: number): string {
  if (countChars(text) <= budget) return text;
  return `……${takeCodePointsFromEnd(text, Math.max(0, budget - countChars("……")))}`;
}

function cropAroundSentence(text: string, start: number, end: number, budget: number): string {
  if (countChars(text) <= budget) return text.trim();
  const target = text.slice(start, end).trim();
  if (countChars(target) >= budget) return cropHead(target, budget);
  const remaining = budget - countChars(target);
  const beforeBudget = Math.floor(remaining / 2);
  const afterBudget = remaining - beforeBudget;
  const before = cropTail(text.slice(0, start).trimEnd(), beforeBudget);
  const after = cropHead(text.slice(end).trimStart(), afterBudget);
  return `${before}${target}${after}`.trim();
}

function takeCodePoints(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

export function takeCodePointsFromEnd(text: string, limit: number): string {
  if (limit <= 0) return "";
  return Array.from(text).slice(-limit).join("");
}

/**
 * 单个段落。用 memo 包住：撑开 / 收起时只有 splitAt 变化的一两段重新渲染。
 * 否则每次点击都会让全文上千个句子组件重新比对，在 5 万字的书上足以卡掉动画的第一帧。
 */
const Paragraph = memo(function Paragraph({
  paraIndex,
  heading,
  pieces,
  regions,
  savedMarkers,
  panelRef,
  glossKey,
  onRetry,
  onSave,
  onExpandSaved,
  onExplain,
  onExplainRetry,
  onExplainBlocked,
  sentences,
}: ParagraphProps) {
  const Tag: ElementType = heading ? HEADING_TAGS[Math.min(Math.max(heading.level, 1), 6) - 1] : "p";
  const className = heading ? "reader-heading" : "reader-para";
  const markerIndexes = new Set(savedMarkers);
  const pieceEnds = new Map(pieces.map((piece) => [piece.index, piece.start + piece.text.length]));

  if (regions.length === 0) {
    return (
      <Tag id={`para-${paraIndex}`} data-para={paraIndex} className={className}>
        {renderPieces(pieces, markerIndexes, pieceEnds, onExpandSaved)}
      </Tag>
    );
  }

  const groups = groupRegions(regions);
  const boundaries = [...groups.keys()];
  const fragments = paragraphOriginalFragments(pieces, boundaries);
  const hasTrailingFragment = fragments.length > boundaries.length;
  return (
    <Fragment>
      {boundaries.map((boundary, groupIndex) => {
        const end = boundary ?? Infinity;
        const part = fragments[groupIndex] ?? NO_PIECES;
        const hasTail = end !== Infinity && end < paragraphLength(pieces);
        const isFirst = groupIndex === 0;
        return (
          <Fragment key={`split:${String(boundary)}`}>
            {part.length > 0 && (
              <Tag
                id={isFirst ? `para-${paraIndex}` : undefined}
                data-para={paraIndex}
                className={splitFragmentClassName(className, heading !== undefined, isFirst, hasTail)}
              >
                {renderPieces(part, markerIndexes, pieceEnds, onExpandSaved)}
              </Tag>
            )}
            {groups.get(boundary)!.map((region) => (
                <GlossPanel
                  key={region.saved ? `saved:${region.index}` : glossKey}
                  ref={region.saved ? undefined : panelRef}
                  view={region.view}
                  onRetry={onRetry}
                  saved={region.saved}
                  onSave={() => onSave(region.index)}
                  source={sentences[region.index]?.text}
                  presentation={region.presentation}
                  actionVisible={!region.saved || region.actionVisible}
                  savedIndex={region.saved ? region.index : undefined}
                  sentenceIndex={region.index}
                  explainView={region.explainView}
                  onExplain={onExplain}
                  onExplainRetry={onExplainRetry}
                  onExplainBlocked={onExplainBlocked}
                />
              ))}
          </Fragment>
        );
      })}
      {hasTrailingFragment && (
        <Tag data-para={paraIndex} className="reader-para reader-para-cont">
          {renderPieces(fragments[boundaries.length]!, markerIndexes, pieceEnds, onExpandSaved)}
        </Tag>
      )}
    </Fragment>
  );
});

/** 同一行结束的句子共享切分边界，但保持为按句序排列的独立区。 */
export function groupRegions(regions: readonly Region[]): ReadonlyMap<number | null, readonly Region[]> {
  const groups = new Map<number | null, Region[]>();
  for (const region of regions) {
    const list = groups.get(region.splitAt) ?? [];
    list.push(region);
    groups.set(region.splitAt, list);
  }
  return new Map(
    [...groups.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
      .map(([splitAt, group]) => [splitAt, group.sort((a, b) => a.index - b.index)]),
  );
}

/** 段内切片续排必须取消首段缩进；标题段沿用既有 class 规则。 */
export function splitFragmentClassName(
  className: string,
  isHeading: boolean,
  isFirst: boolean,
  hasFollowingInsertion: boolean,
): string {
  if (isHeading) {
    return hasFollowingInsertion ? `${className} reader-para-head` : isFirst ? className : "reader-para reader-para-cont";
  }
  const classes = [className];
  if (!isFirst) classes.push("reader-para-cont");
  if (hasFollowingInsertion) classes.push("reader-para-head");
  return classes.join(" ");
}

function renderPieces(
  pieces: Piece[],
  markerIndexes: ReadonlySet<number>,
  pieceEnds: ReadonlyMap<number, number>,
  onExpandSaved: (index: number) => void,
) {
  return pieces.map((p) => (
    <Fragment key={`${p.index}:${p.start}`}>
      <Sentence index={p.index} offset={p.start} text={p.text} />
      {shouldRenderSavedMarker(p, markerIndexes, pieceEnds) && (
        <button
          type="button"
          className="saved-marker"
          aria-label="展开这句的白话"
          onClick={(event) => {
            event.stopPropagation();
            onExpandSaved(p.index);
          }}
        >
          白
        </button>
      )}
    </Fragment>
  ));
}

export function shouldRenderSavedMarker(
  piece: Piece,
  markerIndexes: ReadonlySet<number>,
  pieceEnds: ReadonlyMap<number, number>,
): boolean {
  return markerIndexes.has(piece.index) && piece.start + piece.text.length === pieceEnds.get(piece.index);
}

/**
 * 每个插入边界之前的原文，加上最后一个非 null 边界到段尾的续段。
 * Paragraph 直接使用这个结果，故所有 region 组合都不会丢失段尾原文。
 */
export function paragraphOriginalFragments(pieces: Piece[], boundaries: readonly (number | null)[]): Piece[][] {
  const fragments: Piece[][] = [];
  let from = 0;
  for (const boundary of boundaries) {
    const end = boundary ?? Infinity;
    fragments.push(slicePieces(pieces, from, end));
    from = end;
  }
  if (from < paragraphLength(pieces)) fragments.push(slicePieces(pieces, from, Infinity));
  return fragments;
}

/** 取段落显示文本 [from, to) 范围内的片段；跨越边界的句子被切成两片，index 不变 */
function slicePieces(pieces: Piece[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const start = Math.max(p.start, from);
    const end = Math.min(p.start + p.text.length, to);
    if (end > start) out.push({ index: p.index, start, text: p.text.slice(start - p.start, end - p.start) });
  }
  return out;
}

function paragraphLength(pieces: Piece[]): number {
  const last = pieces[pieces.length - 1];
  return last ? last.start + last.text.length : 0;
}

/* ---------------- 几何测量 ---------------- */

function rectOf(node: Text, offset: number): DOMRect | null {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  return range.getClientRects()[0] ?? null;
}

/** 行内句子的首行顶边（相对视口） */
function firstLineTop(el: HTMLElement): number {
  return (el.getClientRects()[0] ?? el.getBoundingClientRect()).top;
}

function sentenceTop(body: HTMLElement, index: number): number {
  const el = body.querySelector<HTMLElement>(`[data-index="${index}"]`);
  return el ? firstLineTop(el) : 0;
}

function layoutKey(body: HTMLElement): string {
  return `${body.clientWidth}x${body.scrollHeight}`;
}

/** 仅正文横向/字体度量变化会令已存 splitAt 失效；面板流式增高只会改 scrollHeight。 */
function layoutMeasureKey(body: HTMLElement): string {
  const style = getComputedStyle(body);
  return `${body.clientWidth}:${style.fontFamily}:${style.fontSize}:${style.lineHeight}:${style.letterSpacing}`;
}

/** 把指定句子的首行滚到视口顶端；第 0 句回到页面顶部 */
function scrollToSentence(body: HTMLElement, index: number): void {
  const target = index > 0 ? body.querySelector<HTMLElement>(`[data-index="${index}"]`) : null;
  const top = target ? firstLineTop(target) + window.scrollY : 0;
  if (Math.abs(top - window.scrollY) > 1) window.scrollTo({ top, behavior: "instant" });
}

/**
 * 视口顶部所在的句子：句首已到达视口顶端（或更上方）的最后一句。
 * 不用「底边仍在视口内的第一句」——句子是行内元素，前一句的末行常与后一句的首行同行，
 * 那样每次刷新都会往回退一句。句首位置随文档顺序单调不减，用二分查找。
 */
function topSentenceIndex(body: HTMLElement): number {
  const spans = body.querySelectorAll<HTMLElement>("[data-index]");
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (firstLineTop(spans[mid]) <= TOP_TOLERANCE_PX) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? 0 : Number(spans[found].dataset.index);
}

function rememberTopSentence(body: HTMLElement, position: PositionAnchor): void {
  position.index = topSentenceIndex(body);
  position.offset = sentenceTop(body, position.index);
}

/** 段内第 offset 个字的视口纵坐标（段落可能已被拆成上下两半，按 data-para 一并查找） */
function charTop(body: HTMLElement, paraIndex: number, offset: number): number | null {
  for (const span of body.querySelectorAll<HTMLElement>(`[data-para="${paraIndex}"] .sentence`)) {
    const start = Number(span.dataset.offset);
    const node = span.firstChild;
    if (!(node instanceof Text) || offset < start || offset >= start + node.length) continue;
    return rectOf(node, offset - start)?.top ?? null;
  }
  return null;
}

/**
 * 拆分点：被点击句最后一个字所在行的「下一行行首」在段落显示文本中的偏移。
 * 在这里拆开，上半段每一行的字与拆分前完全相同；配合上半段的 text-align-last: justify，
 * 原句所在各行的每个字位置不变（D13，已逐字实测 0px 偏移）。句子在最后一行结束时返回 null。
 */
function measureSplit(body: HTMLElement, paraIndex: number, index: number): number | null {
  const spans = Array.from(body.querySelectorAll<HTMLElement>(`[data-para="${paraIndex}"] .sentence`));
  const own = spans.filter((s) => s.dataset.index === String(index));
  const last = own[own.length - 1];
  const lastNode = last?.firstChild;
  if (!(lastNode instanceof Text) || lastNode.length === 0) return null;

  let lastChar = lastNode.length - 1;
  while (lastChar > 0 && /\s/.test(lastNode.data[lastChar])) lastChar--;
  const lastRect = rectOf(lastNode, lastChar);
  if (!lastRect) return null;
  // 同一行里拉丁字母与汉字的字框顶边略有差异，用半个行高判断「换行了」
  const threshold = lastRect.top + (parseFloat(getComputedStyle(last).lineHeight) || lastRect.height) / 2;

  for (let i = spans.indexOf(last); i < spans.length; i++) {
    const node = spans[i].firstChild;
    if (!(node instanceof Text)) continue;
    for (let c = spans[i] === last ? lastChar + 1 : 0; c < node.length; c++) {
      if (/\s/.test(node.data[c])) continue;
      const rect = rectOf(node, c);
      if (rect && rect.top > threshold) return Number(spans[i].dataset.offset) + c;
    }
  }
  return null;
}

type CaretPoint = { node: Node; offset: number };

function caretFromPoint(x: number, y: number): CaretPoint | null {
  if ("caretPositionFromPoint" in document) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if ("caretRangeFromPoint" in document) {
    const range = (document as Document).caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** 在 span 内选一个有字框、且位于纵坐标 y 所在行（或其上方）的字作锚点 */
function anchorInSpan(span: HTMLElement, preferred: number, y: number): CharAnchor | null {
  const node = span.firstChild;
  const container = span.closest<HTMLElement>("[data-para]");
  if (!(node instanceof Text) || node.length === 0 || !container) return null;

  let local = Math.min(Math.max(preferred, 0), node.length - 1);
  // 点在行尾字的右半边时，光标位置会落到下一行行首：退回点击所在行
  while (local > 0) {
    const rect = rectOf(node, local);
    if (rect && rect.top <= y) break;
    local--;
  }
  for (let c = local; c < node.length; c++) {
    const rect = rectOf(node, c);
    if (rect) {
      return { paraIndex: Number(container.dataset.para), offset: Number(span.dataset.offset) + c, viewportTop: rect.top };
    }
  }
  return null;
}

/** 撑开时的锚点：点击位置上的那个字（被点击行） */
function anchorAtClick(target: HTMLElement, x: number, y: number): CharAnchor | null {
  const caret = caretFromPoint(x, y);
  const preferred = caret && caret.node === target.firstChild ? caret.offset : 0;
  return anchorInSpan(target, preferred, y);
}

/**
 * 默认视口参照物：视口顶端第一个完整可见的字。撑开区内没有 .sentence，所以它永远不会被选作参照物。
 * 不用坐标反查（caretFromPoint）：参考点落在行距、段间距或撑开区外边距里时会取不到字，锚定就静默失效了。
 * 片段首行顶边随文档顺序单调不减（收起动画中下方元素整体上移同一距离，仍保持单调），用二分找起点。
 */
function anchorAtViewportTop(body: HTMLElement): CharAnchor | null {
  const spans = body.querySelectorAll<HTMLElement>(".sentence");
  let lo = 0;
  let hi = spans.length - 1;
  let start = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (firstLineTop(spans[mid]) <= 0) {
      start = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = start; i < spans.length; i++) {
    const span = spans[i];
    const node = span.firstChild;
    const container = span.closest<HTMLElement>("[data-para]");
    if (!(node instanceof Text) || !container) continue;
    for (let c = 0; c < node.length; c++) {
      const rect = rectOf(node, c);
      if (rect && rect.top >= 0) {
        return { paraIndex: Number(container.dataset.para), offset: Number(span.dataset.offset) + c, viewportTop: rect.top };
      }
    }
  }
  return null;
}

/** 撑开区为下方内容带来的位移：有它与没它时，上下相邻元素之间距离的差（计入外边距折叠） */
function panelShift(panel: HTMLElement): number {
  const prev = panel.previousElementSibling;
  const next = panel.nextElementSibling;
  if (!(prev instanceof HTMLElement) || !(next instanceof HTMLElement)) {
    return panel.getBoundingClientRect().height;
  }
  const gapNow = next.getBoundingClientRect().top - prev.getBoundingClientRect().bottom;
  const gapWithout = next.classList.contains("reader-para-cont")
    ? 0
    : Math.max(parseFloat(getComputedStyle(prev).marginBottom) || 0, parseFloat(getComputedStyle(next).marginTop) || 0);
  return gapNow - gapWithout;
}

/** 撑开区下方、在动画前后任一时刻位于视口内的兄弟元素（视口外的元素直接跳到终点，看不见也就不必动画） */
function elementsBelow(panel: HTMLElement, shift: number, extraBottom: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  const limit = window.innerHeight + extraBottom;
  for (let el = panel.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.getBoundingClientRect().top - shift > limit) break;
    if (el instanceof HTMLElement) out.push(el);
  }
  return out;
}

function visibilityAdjustment(body: HTMLElement, index: number, panel: HTMLElement): number {
  const first = body.querySelector<HTMLElement>(`[data-index="${index}"]`);
  if (!first) return 0;
  const top = firstLineTop(first);
  const bottom = panel.getBoundingClientRect().bottom;
  const viewportBottom = window.innerHeight - VISIBLE_MARGIN_PX;
  if (top < VISIBLE_MARGIN_PX) return top - VISIBLE_MARGIN_PX;
  if (bottom > viewportBottom) return Math.min(bottom - viewportBottom, top - VISIBLE_MARGIN_PX);
  return 0;
}

/* ---------------- 动画与交互辅助 ---------------- */

function slide(elements: HTMLElement[], fromY: number, toY: number): void {
  if (elements.length === 0) return;
  for (const el of elements) {
    el.style.transition = "none";
    el.style.willChange = "transform";
    el.style.transform = `translateY(${fromY}px)`;
  }
  void getComputedStyle(elements[0]).transform; // 提交起始状态，让下面的过渡从这里开始
  for (const el of elements) {
    el.style.transition = `transform ${ANIMATION_MS}ms ease`;
    el.style.transform = `translateY(${toY}px)`;
  }
}

function fade(panel: HTMLElement, from: number, to: number): void {
  panel.style.transition = "none";
  panel.style.opacity = String(from);
  void getComputedStyle(panel).opacity;
  panel.style.transition = `opacity ${ANIMATION_MS}ms ease`;
  panel.style.opacity = String(to);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}
