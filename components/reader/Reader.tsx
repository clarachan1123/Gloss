"use client";

import Link from "next/link";
import { readerProgress } from "@/lib/reader-progress";
import { flushSync } from "react-dom";
import FeedbackButton from "@/components/feedback/FeedbackButton";
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
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type CSSProperties,
} from "react";
import ContextMenu, { type ContextMenuPoint } from "@/components/reader/ContextMenu";
import SelectionBar from "./SelectionBar";
import { buildRangeGlossInput, buildTermInput, resolveWholeSentenceReuse, touchedSelectionSentences, type SelectionInput } from "@/lib/selection-context";
import { streamTerm, streamRangeGloss } from "@/lib/selection-client";
import { TERM_PROMPT_VERSION } from "@/lib/prompts/term";
import { RANGE_PROMPT_VERSION } from "@/lib/prompts/range";
import { MODEL_FAST } from "@/lib/models";
import { readSelectionCache, saveSelectionCache, selectionCacheRuntime } from "@/lib/selection-cache";
import { hashSelectionSource, loadSavedSelections, saveSavedSelection, removeSavedSelection, selectionIdentity, type SavedSelection } from "@/lib/selection-storage";

import { normalizeSelection, sourcePointFromGlyphs, comparePoints, selectionText, SELECTION_PUNCTUATION, type SourcePoint, type SourceSelection, type SourceGlyph } from "@/lib/selection";
import Notice from "@/components/Notice";
import SettingsPanel, { MobileReaderSettings } from "@/components/settings/SettingsPanel";
import { DEFAULT_READER_TYPOGRAPHY, readReaderTypography, validateReaderTypography, writeReaderTypography, type ReaderTypography } from "@/lib/reader-typography";
import {
  lookupPreloadedGloss,
  mergePreloadedGlosses,
  preloadGlossCache,
  saveGlossCache,
  sha256,
  type MemoryGloss,
} from "@/lib/cache";
import { MAX_AFTER, MAX_BEFORE, MAX_EXPLAIN_CONTEXT_CHARS } from "@/lib/context";
import { streamExplain, type ExplainInput } from "@/lib/explain-client";
import { buildStructureInput } from "@/lib/structure-input";
import { fetchStructure, streamGloss } from "@/lib/gloss-client";
import { DISMISS_EARLY_MS, emitAnalytics, glossCharsBucket, sentenceCharsBucket, selectionCharsBucket, selectionSentenceBucket, type AnalyticsDetail } from "@/lib/analytics-events";
import { enqueueAnalytics, markAnalyticsOpen, takeReaderEntrySource, type ReaderEntrySource } from "@/lib/analytics-local";
import { ReadCompleteClock } from "@/lib/analytics-read-complete";
import { countChars, skippedSummary, type ParsedHeading, type SkippedContent } from "@/lib/parse/validate";
import { GLOSS_PROMPT_VERSION, TERM_CLOSE, TERM_OPEN } from "@/lib/prompts/gloss";
import { STRUCTURE_PROMPT_VERSION } from "@/lib/prompts/structure";
import { segmentParagraphs, type Sentence as SentenceData } from "@/lib/segment";
import { SAMPLE_DOC_ID, hasSampleBreathed, loadSampleBook, markSampleBreathed, type SampleContent } from "@/lib/sample";
import {
  StorageError,
  loadDocument,
  loadExplanations,
  loadReadingPosition,
  loadSavedGlosses,
  loadShelf,
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
import GlossPanel, { IDLE_EXPLAIN_VIEW, LOADING_VIEW, type ExplainView, type GlossRevealProgress, type GlossView } from "./GlossPanel";
import { measureSplit, paragraphLength, paragraphOriginalFragments, rectOf, splitFragmentClassName, splitParagraphTail, slicePieces } from "./lineSplit";
export { paragraphOriginalFragments, splitFragmentClassName } from "./lineSplit";
import Sentence, { TailPlaceholder } from "./Sentence";
import type { Piece, GlossShape, ReadingMode, SelectionResult, SelectionSlot, SavedRegion, Region, CharAnchor, PositionAnchor, ParagraphProps } from "./readerTypes";
export type { Region } from "./readerTypes";
import { TOP_TOLERANCE_PX, VISIBLE_MARGIN_PX, anchorScrollDelta, shouldAnchorPanelGrowth, allObservedTargetsOutside, panelGrowthAnchor, restoreTypographyAnchor, restoreCharAnchor, restorePanelAnchor, firstLineTop, sentenceTop, layoutKey, layoutMeasureKey, scrollToSentence, topSentenceIndex, rememberPositionAnchor, rememberTopSentence, charTop, caretFromPoint, anchorInSpan, anchorAtClick, mobileReaderTop, anchorAtViewportTop, visibilityAdjustment, rectIntersectsViewport } from "./readerGeometry";
import type { CaretPoint } from "./readerGeometry";
export { anchorScrollDelta, shouldAnchorPanelGrowth, allObservedTargetsOutside, anchorAtViewportTop, rectIntersectsViewport } from "./readerGeometry";
import { GLOSS_SHAPE_KEY, READING_MODE_KEY, readGlossShape, readReadingMode, retainGlossAfterUnsave, countCompleteSentences, prepareReadableDocument, documentStats, glossInput, buildExplainInput, cropExplainContext, distributeNeighborBudget, contextChars, cropHead, cropTail, cropAroundSentence, takeCodePoints, takeCodePointsFromEnd } from "./readerData";
export { readGlossShape, readReadingMode, retainGlossAfterUnsave, countCompleteSentences, prepareReadableDocument, documentStats, buildExplainInput, cropExplainContext, takeCodePointsFromEnd } from "./readerData";
import { EMPTY_EXPLAIN_VIEWS, NO_REGIONS, NO_INDEXES, buildSavedRegionsByParagraph, buildSavedMarkersByParagraph, selectVisibleSavedRegions, groupRegions } from "./readerRegions";
export { buildSavedRegionsByParagraph, buildSavedMarkersByParagraph, selectVisibleSavedRegions, groupRegions } from "./readerRegions";
import { ANIMATION_MS, panelShift, elementsBelow, slide, fade, prefersReducedMotion, hasTextSelection } from "./readerAnimation";
import { sourceSelectionRanges } from "./readerSelectionDom";
export { sourceSelectionRanges } from "./readerSelectionDom";
import { HEADING_TAGS, NO_PIECES, Paragraph, renderPieces } from "./Paragraph";
export { Paragraph } from "./Paragraph";

/** 滚动停下多久后保存阅读位置 */
const SAVE_DELAY_MS = 300;

/** G1：同一句 300ms 内的重复点击只算一次 */
const CLICK_DEBOUNCE_MS = 300;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; doc: StoredDocument; headingsAvailable: boolean; savedGlosses: Map<number, SavedGloss>; sample: SampleContent | null }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "unavailable" };

// G-63：临时白话逐句保存，splitAt 来自当前续排布局。
interface Expansion { index: number; paraIndex: number; splitAt: number | null }
interface Measurement { version: number; queue: readonly number[]; progress: number }
type ReadAttempt = {
  index: number; clickedAt: number; cacheHit: boolean; firstClick: boolean;
  clock: ReadCompleteClock; completeReported: boolean; abortReported: boolean; settled: boolean; dismissReported: boolean;
};

interface SaveContext {
  docId: string;
  expansions: ReadonlyMap<number, Expansion>;
  glosses: ReadonlyMap<number, GlossView>;
  savedGlosses: ReadonlyMap<number, SavedGloss>;
  savedRegions: ReadonlyMap<number, SavedRegion> | null;
  readingMode: ReadingMode;
  sentences: readonly SentenceData[];
}

interface Transaction {
  anchor: CharAnchor | null;
  animateOpen: boolean;
  /** false 时只维护视口锚点，不重复执行首次展开的 G6 可见性微调。 */
  adjustVisibility?: boolean;
  operationIndex?: number;
  closing?: readonly { index: number; height: number }[];
}

interface Animation {
  elements: HTMLElement[];
  panel: HTMLElement | null;
  timer?: number;
}

interface ReaderContextMenu {
  index: number;
  point: ContextMenuPoint;
}

const EMPTY_SAVED_GLOSSES = new Map<number, SavedGloss>();
const SAMPLE_ANALYTICS_FIELD = { sample: true as const };
const NO_SAMPLE_ANALYTICS_FIELD = {};

export default function Reader({ docId }: { docId: string }) {
  const isSample = docId === SAMPLE_DOC_ID;
  const sampleAnalytics = isSample ? SAMPLE_ANALYTICS_FIELD : NO_SAMPLE_ANALYTICS_FIELD;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [sampleBreathed, setSampleBreathed] = useState(false);
  const [expansions, setExpansions] = useState<ReadonlyMap<number, Expansion>>(() => new Map());
  const lastPointerDownRef = useRef<{ pointerType: string; sentenceIndex: number | null } | null>(null);
  // G-69：来源属于本次连续展开，留下或取消留下时沿用。
  const [nonMouseOpenedIndexes, setNonMouseOpenedIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const nonMouseOpenedIndexesRef = useRef(nonMouseOpenedIndexes);
  function updateNonMouseOpenedIndexes(next: ReadonlySet<number>) {
    nonMouseOpenedIndexesRef.current = next;
    setNonMouseOpenedIndexes(next);
  }
  function setNonMouseOpened(index: number, active: boolean) {
    const next = new Set(nonMouseOpenedIndexesRef.current);
    if (active) next.add(index); else next.delete(index);
    updateNonMouseOpenedIndexes(next);
  }
  const activeArraysRef = useRef<readonly (readonly number[])[]>([]);
  const expansionsRef = useRef(expansions);
  expansionsRef.current = expansions;
  const [recentIndex, setRecentIndex] = useState<number | null>(null);
  const [savedRegions, setSavedRegions] = useState<ReadonlyMap<number, SavedRegion> | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const measurementVersionRef = useRef(0);
  const measurementRef = useRef(measurement);
  measurementRef.current = measurement;
  const [activeSavedIndex, setActiveSavedIndex] = useState<number | null>(null);
  const [expandedSavedIndexes, setExpandedSavedIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const expandedSavedIndexesRef = useRef(expandedSavedIndexes);
  function updateExpandedSavedIndexes(next: ReadonlySet<number>) {
    expandedSavedIndexesRef.current = next;
    setExpandedSavedIndexes(next);
  }
  const [glossShape, setGlossShape] = useState<GlossShape>("inline");
  const [readingMode, setReadingMode] = useState<ReadingMode>("review");
  const [contextMenu, setContextMenu] = useState<ReaderContextMenu | null>(null);
  const [reportedIndexes, setReportedIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const [reportPendingIndex, setReportPendingIndex] = useState<number | null>(null);
  const [reportFeedback, setReportFeedback] = useState<string | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [hasOwnBooks, setHasOwnBooks] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const [typography, setTypography] = useState<ReaderTypography>({ ...DEFAULT_READER_TYPOGRAPHY });
  const typographyRef = useRef(typography);
  typographyRef.current = typography;
  const queuedTypographyRef = useRef<ReaderTypography | null>(null);
  const typographyFrameRef = useRef<number | null>(null);
  const typographyGestureRef = useRef<{ anchor: CharAnchor | null; pointer: boolean } | null>(null);
  const fontSizeAdjustmentRef = useRef<{ anchor: CharAnchor | null } | null>(null);
  const queuedTypographyAnchorRef = useRef<CharAnchor | null>(null);
  const typographyGestureTimerRef = useRef<number | undefined>(undefined);
  const typographyLayoutRef = useRef<{ anchor: CharAnchor | null; scrollY: number } | null>(null);
  const [mobileTypographyOpen, setMobileTypographyOpen] = useState(false);
  const mobileTypographyOpenRef = useRef(false);
  const [mobileProgress, setMobileProgress] = useState<ReturnType<typeof readerProgress>>(null);
  const [feedbackRequest, setFeedbackRequest] = useState(0);
  const typographySheetRef = useRef<HTMLDivElement>(null);
  const typographyButtonRef = useRef<HTMLButtonElement>(null);
  const [typographyButtonNode, setTypographyButtonNode] = useState<HTMLButtonElement | null>(null);
  const attachTypographyButton = useCallback((button: HTMLButtonElement | null) => {
    typographyButtonRef.current = button;
    setTypographyButtonNode(button);
  }, []);
  const floatingTypographyButtonRef = useRef<HTMLButtonElement>(null);
  const [floatingTypographyEligible, setFloatingTypographyEligible] = useState(false);
  const floatingTypographyEligibleRef = useRef(false);
  const restoreTypographyFocusRef = useRef(false);
  const floatingTypographyShown = floatingTypographyEligible && !mobileTypographyOpen;
  const feedbackReturnFocus = useCallback(() => window.innerWidth < 768 ? typographyButtonRef.current : null, []);
  const syncFloatingTypographyInteractivity = useCallback((eligible: boolean) => {
    const button = floatingTypographyButtonRef.current;
    if (!button) return;
    const active = eligible && !mobileTypographyOpenRef.current;
    if (button.disabled === active) button.disabled = !active;
    if (button.inert === active) button.inert = !active;
    button.toggleAttribute("inert", !active);
    const hidden = String(!active), pointerEvents = active ? "auto" : "none", tabIndex = active ? 0 : -1;
    if (button.getAttribute("aria-hidden") !== hidden) button.setAttribute("aria-hidden", hidden);
    if (button.tabIndex !== tabIndex) button.tabIndex = tabIndex;
    if (button.style.pointerEvents !== pointerEvents) button.style.pointerEvents = pointerEvents;
  }, []);
  const attachFloatingTypographyButton = useCallback((button: HTMLButtonElement | null) => {
    floatingTypographyButtonRef.current = button;
    syncFloatingTypographyInteractivity(floatingTypographyEligibleRef.current);
  }, [syncFloatingTypographyInteractivity]);

  // Only the breakpoint subscription lives on desktop. Mobile geometry resources
  // belong to the actual top button node, independent of all reading state.
  useLayoutEffect(() => {
    const button = typographyButtonNode;
    if (!button) return;
    const media = window.matchMedia?.("(max-width: 767.98px)");
    const isMobile = () => media?.matches ?? window.innerWidth < 768;
    let stopMobile: (() => void) | null = null;
    const updateEligibility = (eligible: boolean, beforePaint = false) => {
      // The hit target and accessibility state change before any React commit.
      syncFloatingTypographyInteractivity(eligible);
      if (eligible === floatingTypographyEligibleRef.current) return;
      floatingTypographyEligibleRef.current = eligible;
      if (beforePaint) flushSync(() => setFloatingTypographyEligible(eligible));
      else setFloatingTypographyEligible(eligible);
    };
    const startMobile = (readImmediately: boolean) => {
      // 吸顶入口无需追踪离屏几何；原 G-67 分支保留，资源不再启动。
      if (document.querySelector(".reader-mobile-heading")) { updateEligibility(false); return () => {}; }
      let stopped = false, readByEvent = false;
      let frame: number | null = null, stableFrames = 0;
      let inputs: number[] | null = null, previousInputs: number[] | null = null;
      const viewport = window.visualViewport;
      const measure = () => {
        if (stopped) return;
        if (!isMobile()) { updateEligibility(false, true); return; }
        const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
        const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
        const rect = button.getBoundingClientRect();
        inputs = [rect.left, rect.top, rect.right, rect.bottom, left, top, width, height];
        const eligible = false; // 吸顶顶栏始终提供唯一 Aa；保留原悬浮资源的有限停止与清理。
        const floating = floatingTypographyButtonRef.current;
        if (floating) {
          floating.style.setProperty("--floating-aa-x", `${left + width - window.innerWidth}px`);
          floating.style.setProperty("--floating-aa-y", `${top + height - window.innerHeight}px`);
        }
        updateEligibility(eligible, true);
      };
      const tick = () => {
        frame = null;
        if (stopped) return;
        // Scroll/resize already read this frame synchronously; do not read twice.
        if (!readByEvent) measure();
        readByEvent = false;
        stableFrames = inputs && previousInputs && inputs.every((value, index) => value === previousInputs![index])
          ? stableFrames + 1 : 0;
        previousInputs = inputs;
        if (!stopped && isMobile() && stableFrames < 10) frame = window.requestAnimationFrame(tick);
      };
      const schedule = () => {
        stableFrames = 0;
        if (!stopped && frame === null) frame = window.requestAnimationFrame(tick);
      };
      const viewportChanged = () => {
        if (stopped) return;
        if (!readByEvent) { readByEvent = true; measure(); }
        schedule();
      };
      const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(schedule,
        { root: null, rootMargin: "0px", threshold: 0 });
      observer?.observe(button);
      const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
      resizeObserver?.observe(button);
      window.addEventListener("scroll", viewportChanged, { passive: true });
      window.addEventListener("resize", viewportChanged);
      viewport?.addEventListener("scroll", viewportChanged, { passive: true });
      viewport?.addEventListener("resize", viewportChanged);
      if (readImmediately) viewportChanged();
      else schedule();
      return () => {
        stopped = true;
        if (frame !== null) cancelAnimationFrame(frame);
        observer?.disconnect(); resizeObserver?.disconnect();
        window.removeEventListener("scroll", viewportChanged); window.removeEventListener("resize", viewportChanged);
        viewport?.removeEventListener("scroll", viewportChanged); viewport?.removeEventListener("resize", viewportChanged);
      };
    };
    const syncBreakpoint = () => {
      if (isMobile()) {
        if (!stopMobile) stopMobile = startMobile(true);
      } else {
        stopMobile?.(); stopMobile = null;
        updateEligibility(false, true);
      }
    };
    updateEligibility(false);
    if (isMobile()) stopMobile = startMobile(false);
    media?.addEventListener("change", syncBreakpoint);
    return () => { media?.removeEventListener("change", syncBreakpoint); stopMobile?.(); };
  }, [typographyButtonNode, syncFloatingTypographyInteractivity]);

  useLayoutEffect(() => {
    if (mobileTypographyOpen || !restoreTypographyFocusRef.current) return;
    restoreTypographyFocusRef.current = false;
    const target = window.innerWidth >= 768
      ? document.querySelector<HTMLButtonElement>(".settings-typography-toggle")
      : typographyButtonRef.current;
    target?.focus({ preventScroll: true });
  }, [mobileTypographyOpen, floatingTypographyShown]);
  const hoveredGlossRef = useRef<HTMLElement | null>(null);
  const hoveredSentenceRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const shelf = loadShelf();
      setHasOwnBooks(!shelf.unavailable && shelf.entries.some((entry) => entry.docId !== SAMPLE_DOC_ID));
    } catch {
      setHasOwnBooks(false);
    }
  }, []);

  const clearGlossHover = useCallback(() => {
    hoveredGlossRef.current = null;
    bodyRef.current?.querySelectorAll(".sentence-gloss-hover").forEach((sentence) => {
      sentence.classList.remove("sentence-gloss-hover");
    });
  }, []);

  function handleGlossPointerOver(event: ReactPointerEvent<HTMLElement>) {
    if (selectionModeRef.current) return;
    if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
    const panel = event.target.closest<HTMLElement>(".gloss-panel[data-sentence-index]");
    if (!panel || !event.currentTarget.contains(panel) || panel === hoveredGlossRef.current) return;
    clearGlossHover();
    const index = Number(panel.dataset.sentenceIndex);
    if (!Number.isInteger(index) || index < 0) return;
    if (panel.dataset.selectionId) return;
    hoveredGlossRef.current = panel;
    event.currentTarget.querySelectorAll(`.sentence[data-index="${index}"]`).forEach((sentence) => {
      sentence.classList.add("sentence-gloss-hover");
    });
  }

  function handleGlossPointerOut(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    const panel = hoveredGlossRef.current;
    if (panel && event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) return;
    clearGlossHover();
  }
  const clearSentenceHover = useCallback(() => {
    hoveredSentenceRef.current = null;
    bodyRef.current?.querySelectorAll(".sentence.sentence-hover").forEach((sentence) => {
      sentence.classList.remove("sentence-hover");
    });
  }, []);

  const syncSentenceHover = useCallback(() => {
    const body = bodyRef.current;
    const index = hoveredSentenceRef.current;
    if (!body || index === null) return;
    body.querySelectorAll<HTMLElement>(".sentence.sentence-hover").forEach((sentence) => {
      if (sentence.dataset.index !== String(index)) sentence.classList.remove("sentence-hover");
    });
    body.querySelectorAll(`.sentence[data-index="${index}"]`).forEach((sentence) => {
      sentence.classList.add("sentence-hover");
    });
  }, []);

  function handleSentencePointerOver(event: ReactPointerEvent<HTMLElement>) {
    if (selectionModeRef.current) return;
    if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>(".sentence[data-index]");
    if (!target || !event.currentTarget.contains(target)) return;
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    if (hoveredSentenceRef.current !== index) clearSentenceHover();
    hoveredSentenceRef.current = index;
    syncSentenceHover();
  }

  function handleSentencePointerOut(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    const next = event.relatedTarget instanceof Element
      ? event.relatedTarget.closest<HTMLElement>(".sentence[data-index]") : null;
    if (next && event.currentTarget.contains(next) && next.dataset.index === String(hoveredSentenceRef.current)) return;
    clearSentenceHover();
  }

  // React may replace sentence fragments while the mouse stays over the same sentence.
  useLayoutEffect(() => { syncSentenceHover(); });
  useLayoutEffect(() => () => clearSentenceHover(), [docId, clearSentenceHover]);

  const panelsRef = useRef(new Map<number, HTMLDivElement>());
  const panelCallbacksRef = useRef(new Map<number, (panel: HTMLDivElement | null) => void>());
  const panelFor = useCallback((index: number) => {
    let callback = panelCallbacksRef.current.get(index);
    if (!callback) {
      callback = (panel) => { if (panel) panelsRef.current.set(index, panel); else panelsRef.current.delete(index); };
      panelCallbacksRef.current.set(index, callback);
    }
    return callback;
  }, []);
  const contextMenuRef = useRef<ReaderContextMenu | null>(null);
  const suppressOutsideClickRef = useRef(false);
  const positionRef = useRef<PositionAnchor>({ index: 0, offset: 0, docTop: 0, layout: "", measure: "" });
  const transactionRef = useRef<Transaction | null>(null);
  const growthAnchorRef = useRef<{ index: number; panel: HTMLElement; anchor: CharAnchor; scrollY: number } | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const collapseAnimationsRef = useRef(new Map<number, ReturnType<HTMLElement["animate"]>[]>());
  const lastToggleRef = useRef<{ index: number; time: number } | null>(null);
  const restoredDocRef = useRef<string | null>(null);
  /** reader_enter 的来源标记一经取出即作废；StrictMode 重跑 effect 时沿用同一次取出的结果。 */
  const entrySourceRef = useRef<{ docId: string; source: ReaderEntrySource } | null>(null);
  /** 宽度／字体导致全书重量时，事务必须留到最终（已插回）布局才消费。 */
  const pendingMeasureTransactionRef = useRef<Transaction | null>(null);
  const savedRegionArraysRef = useRef<readonly (readonly Region[])[]>([]);
  const savedMarkerArraysRef = useRef<readonly (readonly number[])[]>([]);
  const pendingSavedJumpRef = useRef<number | null>(null);
  // Paragraph 是 memo；保存操作的回调也必须恒定，不能因为当前句或保存集合改变而让全书失效。
  const saveContextRef = useRef<SaveContext | null>(null);
  const saveActionsRef = useRef({ commit, commitSaved });

  // 功能二请求属于 Reader，不属于可能随收起卸载的 GlossPanel。
  const [explainViews, setExplainViews] = useState<ReadonlyMap<number, ExplainView>>(EMPTY_EXPLAIN_VIEWS);
  const explainViewsRef = useRef<ReadonlyMap<number, ExplainView>>(EMPTY_EXPLAIN_VIEWS);
  const explainRunsRef = useRef(new Map<string, number>());
  const explainRunIdRef = useRef(0);
  const explainContextRef = useRef<{ docId: string; sentences: readonly SentenceData[]; paragraphs: readonly string[] }>({ docId, sentences: [], paragraphs: [] });
  const mountedRef = useRef(false);

  // 功能一（G-07）
  const [glosses, setGlosses] = useState<ReadonlyMap<number, GlossView>>(() => new Map());
  const glossesRef = useRef(glosses);
  glossesRef.current = glosses;
  // G-70: layout remounts share committed reveal progress; explicit opens/retries start fresh.
  const revealProgressBySentence = useMemo(() => new Map<number, GlossRevealProgress>(), [docId]);
  const setGloss = useCallback((entry: { index: number; view: GlossView }) => {
    let progress = revealProgressBySentence.get(entry.index);
    if (!progress) { progress = { shown: 0 }; revealProgressBySentence.set(entry.index, progress); }
    const view = { ...entry.view, revealProgress: progress };
    setGlosses((current) => new Map(current).set(entry.index, view));
  }, [revealProgressBySentence]);
  const [retryCounts, setRetryCounts] = useState<ReadonlyMap<number, number>>(() => new Map());
  /** 本次会话与 IndexedDB 预载的自动白话；只放 ref，预载完成不触发段落重渲染。 */
  const glossMemoRef = useRef(new Map<number, MemoryGloss>());
  /** 保存区更新只供点击与请求 effect 查询；不会因保存／取消保存重跑请求 effect。 */
  const savedGlossesRef = useRef<Map<number, SavedGloss>>(EMPTY_SAVED_GLOSSES);
  const glossRunsRef = useRef(new Map<number, { controller: AbortController; runId: number; retry: number }>());
  const nextGlossRunRef = useRef(0);
  const clickCountsRef = useRef(new Map<number, number>());
  const readAttemptRef = useRef(new Map<number, ReadAttempt>());
  function sampleReadAttempt(index: number) {
    if (mobileTypographyOpenRef.current) return;
    if (measurement || savedRegions === null) return;
    const attempt = readAttemptRef.current.get(index);
    if (!attempt) return;
    const panel = panelsRef.current.get(index) ?? null;
    const displayedText = panel?.querySelector<HTMLElement>(".gloss-panel-text")?.textContent ?? "";
    const fullyShown = panel?.dataset.state === "done";
    const now = performance.now();
    const chars = countChars(displayedText);
    const result = attempt.clock.sample(now, chars > 0, fullyShown, chars,
      panel?.getBoundingClientRect() ?? null, window.innerHeight, document.hidden);
    if (result.firstText && !attempt.cacheHit && !isSample) emitAnalytics({ event: "gloss_first_token", sentenceIndex: attempt.index,
      firstTokenMs: Math.max(0, now - attempt.clickedAt), cacheHit: false });
    if (fullyShown && attempt.firstClick && !attempt.completeReported) {
      attempt.completeReported = true;
      emitAnalytics({ event: "gloss_complete", sentenceIndex: attempt.index, cacheHit: attempt.cacheHit,
        durationMs: Math.max(0, now - attempt.clickedAt), glossCharsBucket: glossCharsBucket(chars), ...sampleAnalytics });
    }
    if (result.readComplete && attempt.firstClick && !attempt.dismissReported) emitAnalytics({ event: "gloss_read_complete", sentenceIndex: attempt.index,
      visibleMs: result.visibleMs, bottomSeen: true, glossCharsBucket: glossCharsBucket(result.glossChars), ...sampleAnalytics });
  }
  /**
   * 读者主动收起（再点同一句、点另一句、Esc、点别处）开始的那一刻判定 gloss_dismiss_early；
   * 收起动画、G-46 自动收起、离页都不经过这里。
   */
  function reportEarlyDismiss(index: number) {
    const attempt = readAttemptRef.current.get(index);
    if (!attempt || attempt.dismissReported || !expansionsRef.current.has(index)) return;
    sampleReadAttempt(index);
    // 分母同读完率：首次撑开且白话已完整显示；生成未完成时收起归 gloss_abort。
    if (!attempt.firstClick || !attempt.completeReported || attempt.clock.readReported ||
      attempt.clock.visibleMs >= DISMISS_EARLY_MS) return;
    attempt.dismissReported = true;
    emitAnalytics({ event: "gloss_dismiss_early", sentenceIndex: attempt.index, visibleMs: attempt.clock.visibleMs, ...sampleAnalytics });
  }
  function entrySourceFor(id: string): ReaderEntrySource {
    if (entrySourceRef.current?.docId !== id) entrySourceRef.current = { docId: id, source: takeReaderEntrySource(id) };
    return entrySourceRef.current.source;
  }
  /** 全书结构摘要；开书时后台算，算好之前为 null */
  const structureRef = useRef<string | null>(null);
  const cachePreloadTokenRef = useRef(0);

  contextMenuRef.current = contextMenu;

  useEffect(() => {
    entrySourceFor(docId);
    setReportedIndexes(new Set());
    clickCountsRef.current.clear();
    readAttemptRef.current.clear();
    setReportPendingIndex(null);
    setReportFeedback(null);
    closeContextMenu();
  }, [docId]);

  function abortGloss(index: number) {
    const run = glossRunsRef.current.get(index);
    if (!run || run.controller.signal.aborted) return;
    glossRunsRef.current.delete(index);
    run.controller.abort();
    const attempt = readAttemptRef.current.get(index);
    if (attempt && !attempt.abortReported) {
      attempt.abortReported = true;
      emitAnalytics({ event: "gloss_abort", sentenceIndex: index,
        abortPhase: attempt.clock.firstTextAt === null ? "waiting" : "streaming" });
    }
  }
  useEffect(() => {
    const finish = () => {
      for (const index of [...glossRunsRef.current.keys()]) abortGloss(index);
      for (const attempt of readAttemptRef.current.values()) attempt.clock.stop(performance.now());
    };
    window.addEventListener("pagehide", finish);
    return () => { window.removeEventListener("pagehide", finish); finish(); };
  }, [docId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!contextMenuRef.current || event.button !== 0) return;
      const menu = document.querySelector<HTMLElement>(".reader-context-menu");
      if (menu?.contains(event.target as Node)) return;
      suppressOutsideClickRef.current = !(event.target instanceof Element && event.target.closest("[data-selection-control]"));
      closeContextMenu();
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressOutsideClickRef.current) return;
      suppressOutsideClickRef.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onContextMenu = () => {
      if (contextMenuRef.current) closeContextMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !contextMenuRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeContextMenu();
    };
    const onScroll = () => {
      if (contextMenuRef.current) closeContextMenu();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

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
    setState({ status: "loading" });
    setSampleBreathed(isSample && hasSampleBreathed());
    savedGlossesRef.current = EMPTY_SAVED_GLOSSES;
    explainViewsRef.current = EMPTY_EXPLAIN_VIEWS;
    setExplainViews(EMPTY_EXPLAIN_VIEWS);
    setSavedRegions(null);
    setMeasurement(null);
    setExpansions(new Map());
    updateNonMouseOpenedIndexes(new Set());
    setGlosses(new Map());
    setRetryCounts(new Map());
    setRecentIndex(null);
    setActiveSavedIndex(null);
    updateExpandedSavedIndexes(new Set());
    setFontsReady(false);
    setReadingMode(readReadingMode());
    typographyLayoutRef.current = null;
    setTypography(readReaderTypography());
    const finish = (doc: StoredDocument | null, sample: SampleContent | null) => {
      if (cancelled) return;
      if (!doc) {
        setState({ status: isSample ? "unreadable" : "missing" });
        return;
      }
      const readable = prepareReadableDocument(doc);
      if (!readable) {
        setState({ status: "unreadable" });
        return;
      }
      const { doc: safeDoc, headingsAvailable } = readable;
      // Web Crypto 的身份核对完成前不提交正文，避免先出现原文、随后插入保存白话。
      const currentSentences = segmentParagraphs(safeDoc.paragraphs).sentences;
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
          setState({ status: "ready", doc: safeDoc, headingsAvailable, savedGlosses, sample });
        })
        .catch(() => {
          if (cancelled) return;
          // 保存区损坏或核对失败不能阻塞阅读；本次按空保存区继续，原记录仍不删除。
          savedGlossesRef.current = EMPTY_SAVED_GLOSSES;
          explainViewsRef.current = EMPTY_EXPLAIN_VIEWS;
          setExplainViews(EMPTY_EXPLAIN_VIEWS);
          setState({ status: "ready", doc: safeDoc, headingsAvailable, savedGlosses: EMPTY_SAVED_GLOSSES, sample });
        });
    };
    try {
      if (isSample) {
        void loadSampleBook()
          .then((book) => finish(book?.doc ?? null, book?.content ?? null))
          .catch(() => { if (!cancelled) setState({ status: "unreadable" }); });
      } else {
        finish(loadDocument(docId), null);
      }
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      setState({ status: "unavailable" });
    }
    return () => {
      cancelled = true;
    };
  }, [docId, isSample]);

  const doc = state.status === "ready" ? state.doc : null;
  const sample = state.status === "ready" ? state.sample : null;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new MutationObserver(() => {
      const panel = hoveredGlossRef.current;
      if (panel && !body.contains(panel)) clearGlossHover();
      syncSentenceHover();
    });
    observer.observe(body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearGlossHover();
      clearSentenceHover();
    };
  }, [doc, docId, clearGlossHover, clearSentenceHover, syncSentenceHover]);
  const headingsAvailable = state.status === "ready" && state.headingsAvailable;
  const savedGlosses = state.status === "ready" ? state.savedGlosses : EMPTY_SAVED_GLOSSES;

  // G-13：只有文档已成功载入才计作一次打开，避免无效路由污染最近阅读。
  useEffect(() => {
    if (doc) {
      if (!isSample) {
        touchShelfEntry(docId);
        markAnalyticsOpen(docId);
      }
    }
  }, [doc, docId, isSample]);

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

  const [selectionMode, setSelectionMode] = useState(false);
  const selectionModeRef = useRef(false);
  const [selectionMobile, setSelectionMobile] = useState(false);
  const [selectionStart, setSelectionStart] = useState<SourcePoint | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const selectionMarkerRef = useRef<HTMLSpanElement>(null);
  const selectionGestureRef = useRef<{ id: number; x: number; y: number; moved: boolean; start: SourcePoint; last: SourcePoint } | null>(null);
  function clearSelection() { setSelectionStart(null); setSelection(null); selectionGestureRef.current = null; }
  function exitSelection() { selectionEntryPointer.current = null; selectionModeRef.current = false; setSelectionMode(false); clearSelection(); }
  function toggleSelection(event?: ReactMouseEvent<HTMLElement>) {
    if (selectionModeRef.current) { exitSelection(); return; }
    endFontSizeAdjustment();
    clearSentenceHover(); clearGlossHover(); closeContextMenu();
    suppressOutsideClickRef.current = false;
    window.getSelection()?.removeAllRanges();
    setSelectionMobile(window.innerWidth < 768);
    clearSelection(); selectionModeRef.current = true; setSelectionMode(true);
    const pointer = selectionEntryPointer.current ?? (event?.detail === 0 ? "keyboard" : "mouse");
    selectionEntryPointer.current = null;
    selectionEvent({ event: "selection_mode_enter", pointer: ["mouse", "touch", "pen"].includes(pointer) ? pointer : "keyboard" });
  }
  // 只从真实原文的字框反查，白话、脚注、透明尾巴和空白间隙均不会成为端点。
  function selectionPoint(x: number, y: number): SourcePoint | null {
    const body = bodyRef.current;
    const hit = document.elementFromPoint(x, y);
    const span = hit?.closest<HTMLElement>(".sentence[data-offset]");
    if (!body || !span || !body.contains(span) || span.closest(".gloss-panel, .reader-notes, .reader-tail-placeholder")) return null;
    const node = span.firstChild, block = span.closest<HTMLElement>("[data-para]");
    if (!(node instanceof Text) || !block || !doc) return null;
    const paraIndex = Number(block.dataset.para), original = doc.paragraphs[paraIndex];
    const hidden = original.length - original.trimStart().length;
    const base = Number(span.dataset.offset) + hidden;
    const glyphs: SourceGlyph[] = [];
    for (let offset = 0; offset < node.length;) {
      const char = String.fromCodePoint(node.data.codePointAt(offset)!);
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + char.length);
      for (const rect of range.getClientRects()) {
        glyphs.push({ kind: "source", start: { paraIndex, offset: base + offset }, end: { paraIndex, offset: base + offset + char.length },
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
      offset += char.length;
    }
    return sourcePointFromGlyphs(glyphs, x, y);
  }
  function selectBetween(a: SourcePoint, b: SourcePoint) {
    if (doc) setSelection(normalizeSelection(doc.paragraphs, sentences, a, b));
  }
  function selectionPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const point = selectionPoint(event.clientX, event.clientY);
    if (!point) return;
    selectionGestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, start: point, last: point };
    if (window.innerWidth >= 768 && event.pointerType === "mouse") {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelection(null);
    }
  }
  function selectionPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = selectionGestureRef.current;
    if (!selectionModeRef.current || !gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 10) gesture.moved = true;
    if (window.innerWidth < 768 || event.pointerType !== "mouse") return;
    const point = selectionPoint(event.clientX, event.clientY);
    if (point) { gesture.last = point; selectBetween(gesture.start, point); }
  }
  function selectionPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const gesture = selectionGestureRef.current;
    if (!selectionModeRef.current || !gesture || gesture.id !== event.pointerId) return;
    selectionGestureRef.current = null;
    const point = selectionPoint(event.clientX, event.clientY);
    if (window.innerWidth >= 768 && event.pointerType === "mouse") {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      selectBetween(gesture.start, point ?? gesture.last);
    } else if (point && !gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 10 && !selection) {
      if (selectionStart) selectBetween(selectionStart, point); else setSelectionStart(point);
    }
  }
  // 本轮确定只退出；执行二、三在此接入所选范围的请求与结果事务。

  const [selectionResults, setSelectionResults] = useState<ReadonlyMap<string, SelectionResult>>(() => new Map());
  const selectionResultsRef = useRef(selectionResults);
  const selectionRunsRef = useRef(new Map<string, { controller: AbortController; kind: "term" | "range" }>());
  const selectionPanelsRef = useRef(new Map<string, HTMLDivElement>());
  const selectionPanelCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const selectionConfirmToken = useRef(0);
  const selectionEntryPointer = useRef<string | null>(null);
  const selectionGrowth = useRef<{ anchor: CharAnchor; scrollY: number } | null>(null);
  function publishSelectionResults(next: ReadonlyMap<string, SelectionResult>) {
    selectionResultsRef.current = next; setSelectionResults(next);
  }
  function selectionVisible(result: SelectionResult, mode = readingMode) { return !result.saved || mode === "review" || result.expanded; }
  function selectionPanelFor(id: string) {
    let callback = selectionPanelCallbacks.current.get(id);
    if (!callback) { callback = node => { if (node) selectionPanelsRef.current.set(id, node); else selectionPanelsRef.current.delete(id); }; selectionPanelCallbacks.current.set(id, callback); }
    return callback;
  }
  function selectionEvent(detail: AnalyticsDetail) {
    try { if (localStorage.getItem("gloss:analytics:optout") === "1") return; } catch { return; }
    emitAnalytics(detail);
  }
  function abortSelectionResult(id: string) {
    const run = selectionRunsRef.current.get(id);
    if (!run) return;
    selectionRunsRef.current.delete(id); run.controller.abort();
    selectionEvent({ event: "selection_result", resultKind: run.kind, outcome: "abort" });
  }

  function selectionClosingAnchor(indexes: readonly number[], preferred: CharAnchor | null): CharAnchor | null {
    const body = bodyRef.current;
    if (!body || !indexes.length) return preferred;
    // 收起后的续排字会回到原行；参照字必须选在这些回接字之外。
    const returning = (para: number, offset: number) => indexes.some(index => {
      const sentence = sentences[index];
      return sentence && sentence.paraIndex === para && offset >= sentence.start + sentence.text.length;
    });
    return preferred && !returning(preferred.paraIndex, preferred.offset) ? preferred : anchorAtViewportTop(body, returning);
  }
  function stageSelectionResults(next: ReadonlyMap<string, SelectionResult>, anchor?: CharAnchor | null) {
    const paras = new Set([...selectionResultsRef.current.values(), ...next.values()].map(result => sentences[result.index]?.paraIndex).filter((p): p is number => p !== undefined));
    const closing = [...selectionResultsRef.current.values()].filter(result => selectionVisible(result) &&
      (!next.has(result.id) || !selectionVisible(next.get(result.id)!))).map(result => result.index);
    const preferred = anchor === undefined ? bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null : anchor;
    setTransaction({ anchor: selectionClosingAnchor(closing, preferred), animateOpen: false, adjustVisibility: false });
    publishSelectionResults(next);
    stageLayouts(paras, 0);
  }
  function dismissSelectionResults(ids: readonly string[], anchor?: CharAnchor | null) {
    const next = new Map(selectionResultsRef.current);
    let changed = false;
    for (const id of ids) {
      const result = next.get(id); if (!result || !selectionVisible(result)) continue;
      if (result.saved && readingMode === "review") continue;
      abortSelectionResult(id); changed = true;
      if (result.saved) next.set(id, { ...result, expanded: false, nonMouse: false }); else next.delete(id);
    }
    if (changed) stageSelectionResults(next, anchor);
  }
  function captureSelectionGrowth(id: string): CharAnchor | null {
    const body = bodyRef.current, panel = selectionPanelsRef.current.get(id);
    if (typographyLayoutRef.current) return typographyLayoutRef.current.anchor;
    if (!body || !panel || measurementRef.current) return null;
    const anchor = panelGrowthAnchor(body, panel);
    selectionGrowth.current = anchor ? { anchor, scrollY: window.scrollY } : null;
    return anchor;
  }
  function restoreSelectionGrowth(anchor: CharAnchor | null) {
    const body = bodyRef.current; if (!body || !anchor) return;
    const pending = selectionGrowth.current;
    if (!typographyLayoutRef.current && pending?.anchor === anchor && window.scrollY !== pending.scrollY) {
      rememberPositionAnchor(body, positionRef.current); return;
    }
    restorePanelGrowth(anchor);
  }
  async function generateSelectionResult(result: SelectionResult) {
    if (!result.input) return;
    abortSelectionResult(result.id);
    const run = { controller: new AbortController(), kind: result.resultKind };
    selectionRunsRef.current.set(result.id, run);
    const current = () => mountedRef.current && selectionRunsRef.current.get(result.id) === run;
    const update = (view: GlossView) => {
      if (!current()) return;
      const entry = selectionResultsRef.current.get(result.id); if (!entry) return;
      const anchor = captureSelectionGrowth(result.id);
      if (anchor) setTransaction({ anchor, animateOpen: false, adjustVisibility: false });
      publishSelectionResults(new Map(selectionResultsRef.current).set(result.id, { ...entry, view: { ...view, revealProgress: entry.view.revealProgress } }));
    };
    const cached = await readSelectionCache(docId, result.input);
    if (!current()) return;
    if (cached !== null) {
      update({ status: "done", text: cached, failure: null, instant: true });
      selectionRunsRef.current.delete(result.id);
      selectionEvent({ event: "selection_result", resultKind: result.resultKind, outcome: "cached" }); return;
    }
    const options = { signal: run.controller.signal, onText: (text: string) => update({ status: "streaming", text, failure: null, instant: false }) };
    const response = result.input.kind === "term" ? await streamTerm(result.input.input, options) : await streamRangeGloss(result.input.input, options);
    if (!current()) return;
    if (response.status === "done") {
      update({ status: "done", text: response.text, failure: null, instant: false });
      selectionRunsRef.current.delete(result.id);
      selectionEvent({ event: "selection_result", resultKind: result.resultKind, outcome: "done" });
      void saveSelectionCache(docId, result.input, response);
    } else if (response.status === "failed") {
      update({ status: "failed", text: response.text, failure: response.failure, instant: false });
      selectionRunsRef.current.delete(result.id);
      selectionEvent({ event: "selection_result", resultKind: result.resultKind, outcome: response.failure === "refused" ? "refused" : "error" });
    } else { abortSelectionResult(result.id); }
  }
  function retrySelectionResult(id: string) {
    const result = selectionResultsRef.current.get(id); if (!result || result.saved) return;
    if (!result.input) {
      selectionEvent({ event: "selection_result", resultKind: result.resultKind, outcome: "error" });
      return;
    }
    const next = { ...result, retry: result.retry + 1, view: { ...LOADING_VIEW, revealProgress: { shown: 0 } } };
    stageSelectionResults(new Map(selectionResultsRef.current).set(id, next)); void generateSelectionResult(next);
  }
  async function saveSelectionResult(id: string): Promise<"saved" | "removed" | StorageErrorCode> {
    const result = selectionResultsRef.current.get(id); if (!doc || !result || result.view.status !== "done") return "E2";
    try {
      if (result.saved) {
        removeSavedSelection(docId, result.saved);
        const next = new Map(selectionResultsRef.current);
        for (const [key, entry] of next) if (!entry.saved && key !== id) { abortSelectionResult(key); next.delete(key); }
        next.set(id, { ...result, saved: null, expanded: true }); stageSelectionResults(next); return "removed";
      }
      const entry = await saveSavedSelection(docId, doc.paragraphs, { resultKind: result.resultKind,
        start: result.selection.start, end: result.selection.end, sourceHash: await hashSelectionSource(result.selection.text),
        text: result.view.text, savedAt: Date.now(), promptVersion: result.promptVersion, model: result.model });
      if (explainContextRef.current.docId !== docId) return "saved";
      const latest = selectionResultsRef.current.get(id); if (!latest) return "saved";
      stageSelectionResults(new Map(selectionResultsRef.current).set(id, { ...latest, saved: entry, expanded: true, actionsVisible: true, view: { ...latest.view, text: entry.text, instant: true } }));
      selectionEvent({ event: "selection_save", resultKind: result.resultKind }); return "saved";
    } catch (error) { return error instanceof StorageError ? error.code : "E2"; }
  }
  useEffect(() => {
    let cancelled = false;
    for (const id of selectionRunsRef.current.keys()) abortSelectionResult(id);
    publishSelectionResults(new Map());
    if (doc) void loadSavedSelections(docId, doc.paragraphs).then(entries => {
      if (cancelled) return;
      const next = new Map<string, SelectionResult>();
      for (const saved of entries) {
        const text = selectionText(doc.paragraphs, saved.start, saved.end);
        const punctuation = saved.resultKind === "term" && SELECTION_PUNCTUATION.test([...text].at(-1) ?? "") ? [...text].at(-1)! : "";
        const source: SourceSelection = { start: saved.start, end: saved.end, text, kind: saved.resultKind,
          autoPunctuation: punctuation, chars: countChars(text), sentenceCount: 0 };
        const touched = touchedSelectionSentences(source, sentences); if (!touched.length) continue;
        source.sentenceCount = touched.length;
        const id = selectionIdentity(saved);
        next.set(id, { id, selection: source, resultKind: saved.resultKind, index: touched.at(-1)!.index,
          view: { status: "done", text: saved.text, instant: true, failure: null, revealProgress: { shown: [...saved.text].length } },
          saved, expanded: false, nonMouse: false, input: null, retry: 0, promptVersion: saved.promptVersion, model: saved.model });
      }
      if (next.size) {
        setTransaction({ anchor: bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null, animateOpen: false, adjustVisibility: false });
        publishSelectionResults(next); setSavedRegions(null);
      }
    }).catch(() => {});
    return () => { cancelled = true; for (const id of selectionRunsRef.current.keys()) abortSelectionResult(id); };
  }, [doc, docId, sentences]);

  async function confirmSelection(pointer: string) {
    const source = selection, body = bodyRef.current;
    if (!source || source.chars > 1000 || !doc || !body) return;
    const token = ++selectionConfirmToken.current;
    const nonMouse = pointer !== "mouse";
    selectionEvent({ event: "selection_confirm", resultKind: source.kind === "sentence" ? "whole" : source.kind,
      charsBucket: selectionCharsBucket(source.chars), sentenceCountBucket: selectionSentenceBucket(source.sentenceCount) });
    exitSelection();
    const touched = touchedSelectionSentences(source, sentences);
    if (!touched.length) return;
    if (source.kind === "sentence") {
      dismissSelectionResults([...selectionResultsRef.current.values()].filter(result=>!result.saved).map(result=>result.id));
      const index = touched[0].index, memo = glossMemoRef.current.get(index), session = glossesRef.current.get(index);
      let automatic = memo?.source === "preload" ? memo.text : null;
      if (!automatic && !isSample && !savedGlossesRef.current.has(index) && session?.status !== "done") {
        automatic = (await preloadGlossCache(docId, [{ index, input: glossInput(sentences, index, structureRef.current) }], structureRef.current)).get(index)?.text ?? null;
      }
      if (token !== selectionConfirmToken.current || !mountedRef.current) return;
      const reuse = resolveWholeSentenceReuse(source, { saved: savedGlossesRef.current.get(index)?.text,
        session: session ? { text: session.text, complete: session.status === "done" } : memo?.source === "session" ? { text: memo.text, complete: true } : null,
        automatic, sample: sample?.glosses[index] });
      if (reuse.status === "reuse" && !savedGlossesRef.current.has(index)) glossMemoRef.current.set(index, { text: reuse.text,
        hasStructure: structureRef.current !== null, source: "session", shown: true });
      const target = body.querySelector<HTMLElement>('.sentence[data-index="' + index + '"]');
      const rect = target?.getClientRects()[0];
      if (target && rect) toggleSentence(index, target, rect.left + 1, rect.top + 1, nonMouse, reuse.status === "reuse" ? reuse.text : undefined);
      return;
    }
    const resultKind = source.kind, id = selectionIdentity({ resultKind, start: source.start, end: source.end });
    const existing = selectionResultsRef.current.get(id);
    const overlapping = touched.map(sentence => sentence.index).filter(index => expansionsRef.current.has(index) && !savedGlossesRef.current.has(index));
    const closing = [...overlapping, ...[...selectionResultsRef.current.values()].filter(result => !result.saved).map(result => result.index)];
    const anchor = selectionClosingAnchor(closing, anchorAtViewportTop(body));
    // 合并与插入共用同一锚定事务；单句已留下记录保持原样。
    setTransaction({ anchor, animateOpen: false, adjustVisibility: false });
    collapseIndexes(overlapping, true, anchor);
    const next = new Map(selectionResultsRef.current);
    for (const [key, value] of next) if (!value.saved) { abortSelectionResult(key); next.delete(key); }
    if (existing?.saved) {
      next.set(id, { ...existing, expanded: true, nonMouse }); stageSelectionResults(next, anchor);
      selectionEvent({ event: "selection_result", resultKind, outcome: "cached" }); return;
    }
    let input: SelectionInput | null = null;
    try {
      input = resultKind === "term" ? { kind: "term", input: buildTermInput(source, doc.paragraphs, sentences, structureRef.current) }
        : { kind: "range", input: buildRangeGlossInput(source, doc.paragraphs, sentences, structureRef.current) };
    } catch {
      // 输入超出接口预算时沿用失败面板，不让校验异常越过交互边界。
    }
    const runtime = input ? selectionCacheRuntime(input) : { promptVersion: resultKind === "term" ? TERM_PROMPT_VERSION : RANGE_PROMPT_VERSION, model: MODEL_FAST };
    const result: SelectionResult = { id, selection: source, index: touched.at(-1)!.index, resultKind,
      view: input ? { ...LOADING_VIEW, revealProgress: { shown: 0 } } : { status: "failed", text: "", failure: "unavailable", instant: true },
      saved: null, expanded: true, nonMouse, input, retry: 0,
      promptVersion: runtime.promptVersion, model: runtime.model };
    next.set(id, result); stageSelectionResults(next, anchor);
    if (input) void generateSelectionResult(result);
    else selectionEvent({ event: "selection_result", resultKind, outcome: "error" });
  }


  const selectionJumpRef = useRef<SourcePoint | null>(null);
  function toggleSelectionAtPoint(point: SourcePoint, x: number, y: number): boolean {
    const matches = [...selectionResultsRef.current.values()].filter(result => comparePoints(result.selection.start, point) <= 0 && comparePoints(point, result.selection.end) < 0)
      .sort((a,b) => a.selection.chars - b.selection.chars || (b.saved?.savedAt ?? Infinity) - (a.saved?.savedAt ?? Infinity));
    const result = matches[0]; if (!result) return false;
    const body = bodyRef.current;
    const target = document.elementFromPoint(x,y)?.closest<HTMLElement>(".sentence");
    const anchor = target ? anchorAtClick(target,x,y) : body ? anchorAtViewportTop(body) : null;
    if (result.saved && readingMode === "review") stageSelectionResults(new Map(selectionResultsRef.current).set(result.id, { ...result, actionsVisible: !result.actionsVisible }), anchor);
    else if (selectionVisible(result)) dismissSelectionResults([result.id], anchor);
    else stageSelectionResults(new Map(selectionResultsRef.current).set(result.id, { ...result, expanded: true, actionsVisible: true,
      nonMouse: lastPointerDownRef.current?.pointerType !== "mouse" }), anchor);
    lastPointerDownRef.current = null;
    return true;
  }
  function jumpToSelection(id: string) {
    const result = selectionResultsRef.current.get(id); if (!result) return;
    typographyLayoutRef.current = null;
    selectionJumpRef.current = result.selection.start;
    stageSelectionResults(new Map(selectionResultsRef.current).set(id, { ...result, expanded: true }), null);
  }
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !doc || typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
    const mouse: Range[] = [], touch: Range[] = [], collapsed: Range[] = [];
    for (const result of selectionResults.values()) {
      const ranges = sourceSelectionRanges(body, doc.paragraphs, result.selection);
      if (selectionVisible(result)) (result.nonMouse ? touch : mouse).push(...ranges);
      else if (result.saved && readingMode === "reading") collapsed.push(...ranges);
    }
    for (const [name,ranges] of [["gloss-result-mouse",mouse],["gloss-result-touch",touch],["gloss-result-saved",collapsed]] as const) {
      CSS.highlights.delete(name);
      if (ranges.length) CSS.highlights.set(name,new Highlight(...ranges));
    }
    return () => { for (const name of ["gloss-result-mouse","gloss-result-touch","gloss-result-saved"]) CSS.highlights.delete(name); };
  }, [doc, selectionResults, readingMode, measurement, savedRegions]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const active = [...selectionResults.values()].filter(result => selectionVisible(result) && (!result.saved || readingMode === "reading"));
    if (!body || !active.length || measurement || !fontsReady) return;
    const stopObservers: (() => void)[] = [];
    for (const para of new Set(active.map(result => sentences[result.index].paraIndex))) {
      const results = active.filter(result => sentences[result.index].paraIndex === para);
      const paragraphs = new Set(results.flatMap(result => touchedSelectionSentences(result.selection,sentences).map(sentence=>sentence.paraIndex)));
      const nodes: Element[] = [...body.querySelectorAll<HTMLElement>("[data-reader-block]")].filter(node=>paragraphs.has(Number(node.dataset.para)));
      nodes.push(...results.flatMap(result=>selectionPanelsRef.current.get(result.id)??[]));
      const visibility = new Map<Element,boolean|null>(nodes.map(node=>[node,null]));
      let stopped = false;
      const observer = new IntersectionObserver(entries=>{
        if(stopped || measurementRef.current || typographyLayoutRef.current) return;
        for(const entry of entries) if(visibility.has(entry.target)) visibility.set(entry.target,entry.isIntersecting);
        if(allObservedTargetsOutside(visibility.values())) { stopped=true;dismissSelectionResults(results.map(result=>result.id)); }
      });
      nodes.forEach(node=>observer.observe(node));stopObservers.push(()=>{stopped=true;observer.disconnect();});
    }
    return ()=>stopObservers.forEach(stop=>stop());
  }, [doc,selectionResults,readingMode,measurement,fontsReady,sentences]);

  useEffect(() => {
    if (!selectionMode) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); exitSelection(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [selectionMode]);
  useLayoutEffect(() => {
    if (!selectionMode || !doc) return;
    const body = bodyRef.current;
    if (!body) return;
    const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
    const update = () => {
      const ink = getComputedStyle(body).getPropertyValue("--ink").trim();
      const cursor = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4" fill="none" stroke="' + ink + '"/></svg>';
      body.style.setProperty("--selection-cursor", "url(\"data:image/svg+xml," + encodeURIComponent(cursor) + "\") 8 8, crosshair");
      const ranges: Range[] = [];
      const start = selection?.start ?? selectionStart;
      let end = selection?.end;
      if (start && !end) end = { ...start, offset: start.offset + String.fromCodePoint(doc.paragraphs[start.paraIndex].codePointAt(start.offset)!).length };
      if (start && end) for (const span of body.querySelectorAll<HTMLElement>(".sentence[data-offset]")) {
        const node = span.firstChild, block = span.closest<HTMLElement>("[data-para]");
        if (!(node instanceof Text) || !block) continue;
        const paraIndex = Number(block.dataset.para);
        if (paraIndex < start.paraIndex || paraIndex > end.paraIndex) continue;
        const original = doc.paragraphs[paraIndex], hidden = original.length - original.trimStart().length;
        const base = Number(span.dataset.offset) + hidden;
        const from = Math.max(0, paraIndex === start.paraIndex ? start.offset - base : 0);
        const to = Math.min(node.length, paraIndex === end.paraIndex ? end.offset - base : node.length);
        if (to <= from) continue;
        const range = document.createRange(); range.setStart(node, from); range.setEnd(node, to); ranges.push(range);
      }
      if (highlights && typeof Highlight !== "undefined") {
        highlights.delete("gloss-selection"); highlights.delete("gloss-selection-start");
        if (ranges.length) highlights.set(selection ? "gloss-selection" : "gloss-selection-start", new Highlight(...ranges));
      }
      const marker = selectionMarkerRef.current, last = ranges.at(-1), rect = last?.getClientRects();
      const finalRect = rect?.[rect.length - 1];
      if (marker) {
        marker.hidden = !finalRect;
        if (finalRect) { marker.style.left = (selection ? finalRect.right + 2 : finalRect.left) + "px";
          marker.style.top = (selection ? finalRect.bottom - 3 : finalRect.bottom) + "px";
          marker.style.width = (selection ? 5 : finalRect.width) + "px"; }
      }
    };
    const resized = () => { setSelectionMobile(window.innerWidth < 768); update(); };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", resized);
    const themeObserver = new MutationObserver(update); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const observer = new ResizeObserver(update); observer.observe(body);
    return () => { highlights?.delete("gloss-selection"); highlights?.delete("gloss-selection-start");
      window.removeEventListener("scroll", update); window.removeEventListener("resize", resized); observer.disconnect(); themeObserver.disconnect(); body.style.removeProperty("--selection-cursor"); };
  }, [selectionMode, selection, selectionStart, doc, measurement]);

  explainContextRef.current = { docId, sentences, paragraphs: doc?.paragraphs ?? [] };
  explainViewsRef.current = explainViews;

  const piecesByParagraph = useMemo(() => {
    const groups: Piece[][] = (doc?.paragraphs ?? []).map(() => []);
    for (const s of sentences) {
      const group = groups[s.paraIndex];
      if (!group) continue;
      const previous = group[group.length - 1];
      // 段首空白只在显示层去掉；正文不缩进，以逻辑段容器间距区分段落。
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

  function visibleIndexes(next = expansionsRef.current, mode = readingMode, expanded = expandedSavedIndexesRef.current) {
    return [...new Set([
      ...next.keys(),
      ...[...selectionResultsRef.current.values()].filter(result => selectionVisible(result, mode)).map(result => result.index),
      ...[...savedGlossesRef.current.keys()].filter((index) => mode === "review" || expanded.has(index)),
    ])].sort((a, b) => a - b);
  }
  function stageLayouts(paras: ReadonlySet<number>, from: number | ReadonlyMap<number, number>,
    next = expansionsRef.current, mode = readingMode, expanded = expandedSavedIndexesRef.current) {
    for (const attempt of readAttemptRef.current.values()) attempt.clock.stop(performance.now());
    const cutoff = (index: number) => typeof from === "number" ? from : from.get(sentences[index]?.paraIndex) ?? 0;
    const queue = visibleIndexes(next, mode, expanded).filter((index) =>
      paras.has(sentences[index]?.paraIndex) && index >= cutoff(index));
    setSavedRegions((current) => new Map([...(current ?? [])].filter(([index]) =>
      !paras.has(sentences[index]?.paraIndex) || index < cutoff(index))));
    setMeasurement(queue.length ? { version: ++measurementVersionRef.current, queue, progress: 0 } : null);
  }
  // 每次同步提交只测下一句；已完成前缀已经插回并续排。正文不隐藏。
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!doc || !body || !fontsReady) return;
    if (savedRegions === null) {
      const queue = visibleIndexes();
      setSavedRegions(new Map());
      setMeasurement(queue.length ? { version: ++measurementVersionRef.current, queue, progress: 0 } : null);
      transactionRef.current ??= pendingMeasureTransactionRef.current;
      pendingMeasureTransactionRef.current = null;
      return;
    }
    if (!measurement) return;
    const measuredParas = new Set<number>();
    const next = new Map(savedRegions);
    const remaining: number[] = [];
    for (const index of measurement.queue) {
      const sentence = sentences[index];
      if (!sentence) continue;
      if (measuredParas.has(sentence.paraIndex)) { remaining.push(index); continue; }
      measuredParas.add(sentence.paraIndex);
      const splitAt = headingByParagraph.has(sentence.paraIndex) ? null : measureSplit(body, sentence.paraIndex, index);
      next.set(index, { index, splitAt });
    }
    setSavedRegions(next);
    setMeasurement(remaining.length ? { ...measurement, queue: remaining,
      progress: measurement.progress + measuredParas.size } : null);
  }, [doc, fontsReady, headingByParagraph, measurement, savedRegions, sentences]);

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
    return selectVisibleSavedRegions(savedRegionsByParagraph, readingMode, expandedSavedIndexes);
  }, [expandedSavedIndexes, readingMode, savedRegionsByParagraph]);

  const savedMarkersByParagraph = useMemo(() => {
    const next = buildSavedMarkersByParagraph(
      savedMarkerArraysRef.current,
      doc?.paragraphs.length ?? 0,
      sentences,
      savedGlosses,
      readingMode,
      expandedSavedIndexes,
    );
    savedMarkerArraysRef.current = next;
    return next;
  }, [doc, expandedSavedIndexes, readingMode, savedGlosses, sentences]);

  const activeIndexesByParagraph = useMemo(() => {
    const groups: number[][] = Array.from({ length: doc?.paragraphs.length ?? 0 }, () => []);
    for (const index of nonMouseOpenedIndexes) {
      const visible = savedGlosses.has(index)
        ? readingMode === "reading" && expandedSavedIndexes.has(index) : expansions.has(index);
      if (visible && sentences[index]) groups[sentences[index].paraIndex]?.push(index);
    }
    const result = groups.map((indexes, para) => {
      indexes.sort((a, b) => a - b);
      const old = activeArraysRef.current[para];
      return indexes.length === 0 ? NO_INDEXES : old?.length === indexes.length && old.every((index, i) => index === indexes[i]) ? old : indexes;
    });
    activeArraysRef.current = result;
    return result;
  }, [doc, nonMouseOpenedIndexes, savedGlosses, readingMode, expandedSavedIndexes, expansions, sentences]);

  const regionsByParagraph = useMemo(() => {
    const groups = visibleSavedRegionsByParagraph.slice();
    if (activeSavedIndex !== null) {
      const sentence = sentences[activeSavedIndex];
      if (sentence) groups[sentence.paraIndex] = (groups[sentence.paraIndex] ?? NO_REGIONS).map((region) =>
        region.index === activeSavedIndex ? { ...region, actionVisible: true } : region);
    }
    for (const item of expansions.values()) {
      const layout = savedRegions?.get(item.index);
      if (!layout || savedGlosses.has(item.index)) continue;
      groups[item.paraIndex] = [...(groups[item.paraIndex] ?? NO_REGIONS), {
        index: item.index, splitAt: layout.splitAt, view: glosses.get(item.index) ?? LOADING_VIEW,
        saved: false, presentation: glossShape, actionVisible: true,
        explainView: explainViews.get(item.index) ?? IDLE_EXPLAIN_VIEW,
        glossKey: item.index + ":" + (retryCounts.get(item.index) ?? 0),
      }].sort((a, b) => a.index - b.index);
    }

    for (const result of selectionResults.values()) {
      const layout = savedRegions?.get(result.index);
      if (!layout || !selectionVisible(result)) continue;
      const para = sentences[result.index]?.paraIndex; if (para === undefined) continue;
      groups[para] = [...(groups[para] ?? NO_REGIONS), { index: result.index, splitAt: layout.splitAt,
        view: result.view, saved: !!result.saved, presentation: glossShape, actionVisible: !result.saved || result.actionsVisible === true,
        explainView: IDLE_EXPLAIN_VIEW, glossKey: result.id + ":" + result.retry,
        selectionSlot: { result, panelRef: selectionPanelFor(result.id), onRetry: () => retrySelectionResult(result.id),
          onSave: () => saveSelectionResult(result.id), onBeforeReveal: () => captureSelectionGrowth(result.id), onAfterReveal: restoreSelectionGrowth } }];
    }
    return groups;
  }, [activeSavedIndex, expansions, explainViews, glosses, glossShape, retryCounts, savedGlosses, savedRegions, sentences, visibleSavedRegionsByParagraph, selectionResults]);

  const preloadAutoGloss = useCallback(
    (structure: string | null) => {
      if (isSample) return;
      const token = ++cachePreloadTokenRef.current;
      performance.mark("gloss:preload:start");
      void preloadGlossCache(docId, cacheInputs, structure).then((entries) => {
        if (cachePreloadTokenRef.current === token) mergePreloadedGlosses(glossMemoRef.current, entries);
        performance.mark("gloss:preload:end");
      });
    },
    [cacheInputs, docId, isSample],
  );

  // 阅读位置：恢复到保存的句子；滚动时记录视口顶部所在的句子；布局变化时保持它在视口中的位置
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!doc || !body || sentences.length === 0 || savedRegions === null || measurement) return;

    history.scrollRestoration = "manual";
    const position = positionRef.current;
    if (restoredDocRef.current !== docId) {
      const saved = loadReadingPosition(docId);
      const initial = saved !== null && saved < sentences.length ? saved : 0;
      // 整页加载时这里早于 AnalyticsCollector 开始监听（其外层另有 Suspense），派发事件会丢；
      // 与 markAnalyticsOpen 一样直接写入本地队列。
      const entrySource = entrySourceFor(docId);
      enqueueAnalytics({ event: "reader_enter", source: entrySource, positionRestored: initial > 0 });
      if (isSample) enqueueAnalytics({ event: "sample_doc_enter", from: entrySource === "shelf" || entrySource === "landing" ? entrySource : "direct" });
      scrollToSentence(body, initial);
      position.index = initial;
      position.offset = sentenceTop(body, initial);
      position.docTop = position.offset + window.scrollY;
      position.layout = layoutKey(body);
      position.measure = layoutMeasureKey(body);
      restoredDocRef.current = docId;
    } else if (!transactionRef.current && !typographyLayoutRef.current) {
      const drift = sentenceTop(body, position.index) - position.offset;
      if (Math.abs(drift) > 1) window.scrollBy({ top: drift, behavior: "instant" });
      position.offset = sentenceTop(body, position.index);
      position.docTop = position.offset + window.scrollY;
      position.layout = layoutKey(body);
      position.measure = layoutMeasureKey(body);
    }

    let progressFrame: number | null = null;
    const updateProgress = () => {
      progressFrame = null;
      if (window.innerWidth >= 768) return;
      const next = readerProgress(doc.paragraphs.length, sentences, positionRef.current.index);
      setMobileProgress(old => old?.current === next?.current && old?.total === next?.total ? old : next);
    };
    const scheduleProgress = () => { if (window.innerWidth < 768 && progressFrame === null) progressFrame = requestAnimationFrame(updateProgress); };
    updateProgress();
    let timer: number | undefined;
    const flush = () => {
      window.clearTimeout(timer);
      saveReadingPosition(docId, positionRef.current.index);
    };
    const onScroll = () => {
      const layout = typographyLayoutRef.current;
      if (layout?.anchor && !transactionRef.current && !measurementRef.current) {
        restoreTypographyAnchor(body, layout.anchor);
        layout.scrollY = window.scrollY;
      }
      // 布局刚变过：这次滚动由浏览器保持像素位置造成，不是用户在读，交给 ResizeObserver 处理
      if (layoutKey(body) !== positionRef.current.layout) return;
      rememberTopSentence(body, positionRef.current);
      scheduleProgress();
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, SAVE_DELAY_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const observer = new ResizeObserver(() => {
      if (transactionRef.current || pendingMeasureTransactionRef.current || measurementRef.current) return;
      const current = positionRef.current;
      const key = layoutKey(body);
      const measure = layoutMeasureKey(body);
      const typographyLayout = typographyLayoutRef.current;
      if (typographyLayout) {
        if (measure !== current.measure && (savedGlossesRef.current.size > 0 || expansionsRef.current.size > 0 || selectionResultsRef.current.size > 0)) {
          pendingMeasureTransactionRef.current = { anchor: typographyLayout.anchor, animateOpen: false, adjustVisibility: false };
          setSavedRegions(null);
          return;
        }
        // A late change below the locked character has delta 0: never scroll for that change.
        if (typographyLayout.anchor && charTop(body, typographyLayout.anchor.paraIndex, typographyLayout.anchor.offset) !== typographyLayout.anchor.viewportTop) {
          restoreTypographyAnchor(body, typographyLayout.anchor);
        }
        typographyLayout.scrollY = window.scrollY;
        rememberTopSentence(body, current); current.layout = layoutKey(body); current.measure = layoutMeasureKey(body);
        return;
      }
      // 撑开 / 收起已经自己锚定过视口（见下方事务），这里不再二次校正
      if (key === current.layout) return;
      if (measure !== current.measure && (savedGlossesRef.current.size > 0 || expansionsRef.current.size > 0 || selectionResultsRef.current.size > 0)) {
        // 测量提交不消费本事务；量完、常驻区与 transient 都插回后才由事务 effect 锚定。
        pendingMeasureTransactionRef.current = { anchor: anchorAtViewportTop(body), animateOpen: false };
        setSavedRegions(null);
        return;
      }
      // Document coordinates exclude the reader's own scroll while a layout change is pending.
      const drift = sentenceTop(body, current.index) + window.scrollY - current.docTop;
      if (Math.abs(drift) > 1) window.scrollBy({ top: drift, behavior: "instant" });
      rememberPositionAnchor(body, current);
    });

    observer.observe(body);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleProgress);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      if (progressFrame !== null) cancelAnimationFrame(progressFrame);
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleProgress);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [doc, docId, fontsReady, isSample, measurement !== null, savedRegions === null, sentences.length]);

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

  function cancelPendingCollapse(index?: number) {
    for (const [key, animations] of collapseAnimationsRef.current) {
      if (index !== undefined && key !== index) continue;
      animations.forEach((animation) => animation.cancel());
      collapseAnimationsRef.current.delete(key);
    }
  }
  function setTransaction(transaction: Transaction) {
    transactionRef.current ??= transaction;
  }
  function removeAttempts(indexes: readonly number[], early: boolean) {
    for (const index of indexes) {
      if (early) reportEarlyDismiss(index);
      sampleReadAttempt(index);
      abortGloss(index);
      readAttemptRef.current.get(index)?.clock.stop(performance.now());
      readAttemptRef.current.delete(index);
    }
  }
  function commit(next: Expansion | null, options: { anchor?: CharAnchor | null; animateOpen?: boolean } = {}) {
    const removed = [...new Set([...expansionsRef.current.keys(), ...expandedSavedIndexesRef.current])]
      .filter((index) => !next || sentences[index]?.paraIndex !== next.paraIndex);
    setTransaction({ anchor: options.anchor ?? (bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null),
      animateOpen: options.animateOpen ?? false, operationIndex: next?.index });
    collapseIndexes(removed, true, options.anchor);
    const values = new Map(expansionsRef.current);
    if (next) values.set(next.index, next);
    else values.clear();
    const paras = new Set(removed.map((index) => sentences[index].paraIndex));
    const cutoffs = new Map([...paras].map((para) => [para, 0]));
    if (next) { paras.add(next.paraIndex); cutoffs.set(next.paraIndex, next.index + 1); }
    expansionsRef.current = values;
    setExpansions(values);
    setRecentIndex(next?.index ?? null);
    setActiveSavedIndex(null);
    stageLayouts(paras, cutoffs, values);
    if (next) setSavedRegions((currentLayouts) => new Map(currentLayouts).set(next.index, { index: next.index, splitAt: next.splitAt }));
  }
  function keepParagraph(paraIndex: number) {
    const removed = [...new Set([...expansionsRef.current.keys(), ...expandedSavedIndexesRef.current])]
      .filter((index) => sentences[index]?.paraIndex !== paraIndex);
    collapseIndexes(removed, true);
    return new Set(removed.map((index) => sentences[index].paraIndex));
  }
  function commitSaved(index: number | null, options: { anchor?: CharAnchor | null } = {}) {
    closeContextMenu();
    setTransaction({ anchor: options.anchor ?? (bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null),
      animateOpen: false, adjustVisibility: false });
    if (index !== null) {
      const paras = keepParagraph(sentences[index].paraIndex);
      if (expansionsRef.current.has(index)) {
        const next = new Map(expansionsRef.current);
        next.delete(index);
        readAttemptRef.current.get(index)?.clock.stop(performance.now());
        readAttemptRef.current.delete(index);
        expansionsRef.current = next;
        setExpansions(next);
      }
      if (paras.size) stageLayouts(paras, 0);
    }
    if (index !== null && readingMode === "review") setNonMouseOpened(index, false);
    setActiveSavedIndex(index);
  }
  function expandSaved(index: number, options: { anchor?: CharAnchor | null; showActions?: boolean; nonMouse?: boolean } = {}) {
    closeContextMenu();
    setTransaction({ anchor: options.anchor ?? (bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null),
      animateOpen: false, operationIndex: index });
    const paras = keepParagraph(sentences[index].paraIndex);
    const cutoffs = new Map([...paras].map((para) => [para, 0]));
    paras.add(sentences[index].paraIndex);
    cutoffs.set(sentences[index].paraIndex, index);
    setRecentIndex(index);
    setNonMouseOpened(index, options.nonMouse === true);
    updateExpandedSavedIndexes(new Set(expandedSavedIndexesRef.current).add(index));
    setActiveSavedIndex(options.showActions ? index : null);
    stageLayouts(paras, cutoffs, expansionsRef.current, readingMode, expandedSavedIndexesRef.current);
  }

  function closeContextMenu() {
    contextMenuRef.current = null;
    setContextMenu(null);
  }

  function handleReaderContextMenu(event: ReactMouseEvent<HTMLElement>) {
    if (selectionModeRef.current) { event.preventDefault(); event.stopPropagation(); return; }
    const eventTarget = event.target;
    const target = eventTarget instanceof Element ? eventTarget : eventTarget instanceof Node ? eventTarget.parentElement : null;
    if (!target) return;
    const sentenceTarget = target.closest<HTMLElement>(".sentence");
    const panelTarget = target.closest<HTMLElement>(".gloss-panel");
    if (!sentenceTarget && !panelTarget) return;
    if (panelTarget?.dataset.selectionId) return;
    const index = Number(panelTarget?.dataset.sentenceIndex ?? sentenceTarget?.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;

    const transientVisible = expansions.has(index);
    const savedVisible = savedRegions?.has(index) === true &&
      (readingMode === "review" || expandedSavedIndexes.has(index) || activeSavedIndex === index);
    if (!transientVisible && !savedVisible) return;

    event.preventDefault();
    event.stopPropagation();
    const next = { index, point: { x: event.clientX, y: event.clientY } };
    contextMenuRef.current = next;
    setContextMenu(next);
    setReportFeedback(null);
  }

  function open(index: number, target: HTMLElement, clientX: number, clientY: number, nonMouse: boolean, reuse?: string) {
    const body = bodyRef.current;
    const sentence = sentences[index];
    if (!body || !sentence) return;
    if (sample?.breatheSentenceIndex === index && !sampleBreathed) {
      markSampleBreathed();
      setSampleBreathed(true);
    }

    revealProgressBySentence.delete(index);
    const savedClick = savedGlosses.has(index);
    const nextCount = savedClick ? null : (clickCountsRef.current.get(index) ?? 0) + 1;
    if (nextCount !== null) clickCountsRef.current.set(index, nextCount);
    const cacheHit = nextCount !== null && !isSample &&
      lookupPreloadedGloss(glossMemoRef.current, index, structureRef.current !== null).status === "hit";
    if (nextCount !== null) emitAnalytics(nextCount === 1
      ? { event: "sentence_click", sentenceIndex: index, sentenceCharsBucket: sentenceCharsBucket(countChars(sentence.text)), cacheHit, ...sampleAnalytics }
      : { event: "sentence_reclick", sentenceIndex: index, reclickOrdinal: nextCount, ...sampleAnalytics });
    if (nextCount !== null) readAttemptRef.current.set(index, {
      index, clickedAt: performance.now(), cacheHit, firstClick: nextCount === 1,
      clock: new ReadCompleteClock(), completeReported: false, abortReported: false, settled: isSample || cacheHit, dismissReported: false,
    });
    cancelPendingCollapse(index);
    const anchor = anchorAtClick(target, clientX, clientY);
    const splitAt = headingByParagraph.has(sentence.paraIndex) ? null : measureSplit(body, sentence.paraIndex, index);
    // 命中必须和撑开状态同一批 React 更新：第一次 DOM 更新直接放完整白话，不先经过加载态。
    const saved = savedGlosses.get(index);
    if (saved) {
      setGloss({ index, view: { status: "done", text: saved.text, failure: null, instant: true } });
    } else if (reuse !== undefined) {
      setGloss({ index, view: { status: "done", text: reuse, failure: null, instant: true } });
    } else if (sample) {
      setGloss({ index, view: { status: "done", text: sample.glosses[index], failure: null,
        instant: false, firstChunkNow: true } });
    } else {
      const cacheLookup = lookupPreloadedGloss(glossMemoRef.current, index, structureRef.current !== null);
      if (cacheLookup.status === "hit") {
        const entry = glossMemoRef.current.get(index);
        if (entry) entry.shown = true;
        setGloss({ index, view: { status: "done", text: cacheLookup.entry.text, failure: null, instant: true } });
      }
    }
    setNonMouseOpened(index, nonMouse);
    // 切换句子时，前一个撑开区在同一次提交里直接移除（不播收起动画），参照物是新点的这一行
    commit(
      { index, paraIndex: sentence.paraIndex, splitAt },
      { anchor, animateOpen: !prefersReducedMotion() },
    );
  }

  function collapseIndexes(indexes: readonly number[], early: boolean, anchor?: CharAnchor | null, animate = false) {
    const transient = indexes.filter((index) => expansionsRef.current.has(index));
    const saved = readingMode === "reading" ? indexes.filter((index) => expandedSavedIndexesRef.current.has(index)) : [];
    indexes = [...new Set([...transient, ...saved])];
    if (!indexes.length) return;
    closeContextMenu();
    const closing = animate ? indexes.flatMap((index) => {
      const panel = panelsRef.current.get(index);
      const rect = panel?.getBoundingClientRect();
      return panel && rect && rect.top >= 0 && rect.top < window.innerHeight
        ? [{ index, height: panelShift(panel) }] : [];
    }) : [];
    const active = new Set(nonMouseOpenedIndexesRef.current);
    indexes.forEach((index) => active.delete(index));
    updateNonMouseOpenedIndexes(active);
    removeAttempts(transient, early);
    const expanded = new Set(expandedSavedIndexesRef.current);
    saved.forEach((index) => expanded.delete(index));
    updateExpandedSavedIndexes(expanded);
    if (activeSavedIndex !== null && saved.includes(activeSavedIndex)) setActiveSavedIndex(null);
    const next = new Map(expansionsRef.current);
    indexes.forEach((index) => next.delete(index));
    expansionsRef.current = next;
    setExpansions(next);
    const paras = new Set(indexes.map((index) => sentences[index].paraIndex));
    setTransaction({ anchor: anchor ?? (bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null),
      animateOpen: false, adjustVisibility: false, closing });
    stageLayouts(paras, Math.min(...indexes), next, readingMode, expanded);
  }

  function toggleSentence(index: number, target: HTMLElement, clientX: number, clientY: number, nonMouse: boolean, reuse?: string) {
    if (savedGlosses.has(index)) {
      const anchor = anchorAtClick(target, clientX, clientY);
      if (readingMode === "reading") {
        if (expandedSavedIndexes.has(index)) collapseIndexes([index], true, anchor, true);
        else expandSaved(index, { anchor, showActions: true, nonMouse });
      } else {
        commitSaved(activeSavedIndex === index ? null : index, { anchor });
      }
    } else if (expansions.has(index)) {
      collapseIndexes([index], true, anchorAtClick(target, clientX, clientY), true);
    } else {
      open(index, target, clientX, clientY, nonMouse, reuse);
    }
  }

  function handleBodyPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (selectionModeRef.current) { selectionPointerDown(event); return; }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".sentence[data-index]") : null;
    lastPointerDownRef.current = { pointerType: event.pointerType, sentenceIndex: target ? Number(target.dataset.index) : null };
  }

  function handleBodyClick(event: ReactMouseEvent<HTMLElement>) {
    if (selectionModeRef.current) { event.stopPropagation(); return; }
    typographyLayoutRef.current = null;
    // G5：用户划选了文字（复制原文），松开鼠标不触发撑开
    if (hasTextSelection()) return;
    const eventTarget = event.target as Element;
    const selectionPanel = eventTarget.closest<HTMLElement>("[data-selection-id]");
    if (selectionPanel) {
      const result = selectionResultsRef.current.get(selectionPanel.dataset.selectionId!);
      if (result?.saved && !eventTarget.closest("button")) stageSelectionResults(new Map(selectionResultsRef.current).set(result.id, { ...result, actionsVisible: !result.actionsVisible }));
      return;
    }
    const sourcePoint = selectionPoint(event.clientX, event.clientY);
    if (sourcePoint && toggleSelectionAtPoint(sourcePoint, event.clientX, event.clientY)) return;
    const clickedSentence = eventTarget.closest<HTMLElement>(".sentence");
    const clickedPara = clickedSentence?.closest<HTMLElement>("[data-para]")?.dataset.para;
    dismissSelectionResults([...selectionResultsRef.current.values()].filter(result => clickedPara === undefined || sentences[result.index]?.paraIndex !== Number(clickedPara)).map(result => result.id));
    const savedPanel = eventTarget.closest<HTMLElement>(".gloss-panel-saved");
    if (savedPanel && !eventTarget.closest("button")) {
      const index = Number(savedPanel.dataset.savedIndex);
      if (Number.isInteger(index)) commitSaved(activeSavedIndex === index ? null : index);
      return;
    }
    const target = eventTarget.closest<HTMLElement>(".sentence");
    if (!target) return;
    const index = Number(target.dataset.index);
    const pointerDown = lastPointerDownRef.current;
    const pointerType = pointerDown && pointerDown.sentenceIndex === index
      ? pointerDown.pointerType : "pointerType" in event.nativeEvent ? event.nativeEvent.pointerType : undefined;
    const nonMouse = typeof pointerType === "string" && pointerType.length > 0 && pointerType !== "mouse";
    lastPointerDownRef.current = null;

    const now = performance.now();
    const last = lastToggleRef.current;
    if (last && last.index === index && now - last.time < CLICK_DEBOUNCE_MS) return;
    lastToggleRef.current = { index, time: now };

    toggleSentence(index, target, event.clientX, event.clientY, nonMouse);
  }

  // 每次撑开 / 收起提交后、浏览器绘制前：锚定视口 → 自动微调滚动 → 启动动画
  useLayoutEffect(() => {
    const body = bodyRef.current;
    // 真实未拆分 DOM 只供测量，不能在这一次中间提交消费锚定事务。
    if (!body || savedRegions === null || measurement) return;
    const transaction = transactionRef.current;
    const pendingSavedJump = pendingSavedJumpRef.current;
    const pendingSelectionJump = selectionJumpRef.current;
    selectionJumpRef.current = null;
    transactionRef.current = null;
    pendingSavedJumpRef.current = null;
    if (!transaction && pendingSavedJump === null && pendingSelectionJump === null) return;

    clearAnimation();

    // ① 视口锚定（产品不变量）：把参照字滚回 DOM 变化前的位置。
    //    改动在参照字下方时补偿为 0（D13 保证上方的行不重排）；改动在上方时，补偿恰好抵消文档高度的变化
    if (typographyLayoutRef.current?.anchor) {
      restoreTypographyAnchor(body, typographyLayoutRef.current.anchor);
    } else if (transaction?.anchor) {
      if (growthAnchorRef.current?.anchor === transaction.anchor) {
        restorePanelAnchor(body, transaction.anchor);
        growthAnchorRef.current.scrollY = window.scrollY;
      } else {
        // scrollBy 的实际滚动量可能取整；沿用面板锚定的 translate 补齐剩余小数。
        restorePanelAnchor(body, transaction.anchor);
      }
    }
    rememberPositionAnchor(body, positionRef.current);
    if (typographyLayoutRef.current) typographyLayoutRef.current.scrollY = window.scrollY;

    if (pendingSelectionJump && doc) {
      const pointRange = sourceSelectionRanges(body, doc.paragraphs, { start: pendingSelectionJump, end: { ...pendingSelectionJump, offset: pendingSelectionJump.offset + String.fromCodePoint(doc.paragraphs[pendingSelectionJump.paraIndex].codePointAt(pendingSelectionJump.offset)!).length } })[0];
      const rect = pointRange?.getBoundingClientRect();
      if (rect) window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - mobileReaderTop()), behavior: "instant" });
      rememberPositionAnchor(body, positionRef.current); return;
    }
    if (pendingSavedJump !== null && !typographyLayoutRef.current) {
      body.querySelector<HTMLElement>(`.sentence[data-index="${pendingSavedJump}"]`)?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "instant" : "smooth",
      });
    }

    // 功能二逐句增长只做字符锚定：不能像首次展开那样追着不断变长的面板自动滚动。
    if (typographyLayoutRef.current || transaction?.adjustVisibility === false) return;

    if (transaction?.closing && !prefersReducedMotion()) {
      for (const { index, height } of transaction.closing) {
        const block = body.querySelector<HTMLElement>('.sentence[data-index="' + index + '"]')?.closest("[data-reader-block]");
        if (!block) continue;
        const animations: ReturnType<HTMLElement["animate"]>[] = [];
        for (let node = block.nextElementSibling; node; node = node.nextElementSibling) {
          if (node instanceof HTMLElement && typeof node.animate === "function") {
            animations.push(node.animate([{ transform: "translateY(" + height + "px)" }, { transform: "translateY(0)" }],
              { duration: ANIMATION_MS, easing: "ease-out" }));
          }
        }
        collapseAnimationsRef.current.set(index, animations);
        Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
          if (collapseAnimationsRef.current.get(index) === animations) collapseAnimationsRef.current.delete(index);
        });
      }
    }
    const operationIndex = transaction?.operationIndex;
    const panel = operationIndex === undefined ? null : panelsRef.current.get(operationIndex) ??
      body.querySelector<HTMLElement>('.gloss-panel[data-sentence-index="' + operationIndex + '"]');
    if (operationIndex === undefined || !panel) return;

    // ② G6：整句或撑开区被视口截断时才微调；否则点击行纹丝不动
    const adjustment = visibilityAdjustment(body, operationIndex, panel);

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
      if (window.innerWidth < 768) rememberPositionAnchor(body, positionRef.current);
    }
  }, [activeSavedIndex, expandedSavedIndexes, explainViews, expansions, glosses, glossShape, measurement, readingMode, savedRegions, typography, selectionResults]);

  // Esc / 空白批量收临时白话与收起模式的已留下展开，显示模式常驻保留。
  useEffect(() => {
    if (measurement || !bodyRef.current || (!expansions.size && !expandedSavedIndexes.size && activeSavedIndex === null && !selectionResults.size)) return;
    const dismiss = () => {
      if (selectionModeRef.current) return;
      typographyLayoutRef.current = null;
      collapseIndexes([...expansionsRef.current.keys(), ...expandedSavedIndexesRef.current], true);
      dismissSelectionResults([...selectionResultsRef.current.keys()]);
      setActiveSavedIndex(null);
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (hasTextSelection()) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-saved-selection-id]")) return;
      if (target?.closest?.(".sentence, .gloss-panel, .feedback-card, .feedback-button, .col-right, [data-reader-settings]")) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !mobileTypographyOpenRef.current) dismiss(); };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("click", onDocumentClick); document.removeEventListener("keydown", onKeyDown); };
  });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || measurement || savedRegions === null || !fontsReady || (!expansions.size && !expandedSavedIndexes.size)) return;
    const index = expansions.keys().next().value ?? expandedSavedIndexes.values().next().value!;
    const paraIndex = sentences[index].paraIndex;
    const blocks = [...body.querySelectorAll<HTMLElement>('[data-reader-block][data-para="' + paraIndex + '"]')];
    const panels = [...body.querySelectorAll<HTMLElement>(".gloss-panel")].filter((panel) =>
      sentences[Number(panel.dataset.sentenceIndex)]?.paraIndex === paraIndex);
    const visibility = new Map<Element, boolean | null>([...blocks, ...panels].map((node) => [node, null]));
    let disconnected = false, dismissed = false;
    const observer = new IntersectionObserver((entries) => {
      if (disconnected || dismissed || typographyLayoutRef.current || measurementRef.current) return;
      for (const entry of entries) if (visibility.has(entry.target)) visibility.set(entry.target, entry.isIntersecting);
      if (allObservedTargetsOutside(visibility.values())) {
        dismissed = true;
        collapseIndexes([...expansionsRef.current.keys(), ...expandedSavedIndexesRef.current].filter((index) => sentences[index]?.paraIndex === paraIndex), false);
      }
    });
    for (const node of visibility.keys()) observer.observe(node);
    return () => { disconnected = true; observer.disconnect(); };
  }, [docId, expandedSavedIndexes, expansions, fontsReady, measurement, readingMode, savedRegions, sentences]);
  useEffect(() => () => { cancelPendingCollapse(); clearAnimation(); }, []);

  const capturePanelGrowth = useCallback((index: number): CharAnchor | null => {
    const body = bodyRef.current;
    const panel = body?.querySelector<HTMLElement>(`.gloss-panel[data-sentence-index="${index}"]`);
    if (typographyLayoutRef.current) return typographyLayoutRef.current.anchor;
    if (measurementRef.current || !body || !panel || !shouldAnchorPanelGrowth(panel.getBoundingClientRect().bottom)) {
      growthAnchorRef.current = null;
      return null;
    }
    const prior = growthAnchorRef.current;
    if (prior?.index === index && prior.panel === panel && Math.abs(prior.scrollY - window.scrollY) < 0.5 && charTop(body, prior.anchor.paraIndex, prior.anchor.offset) !== null) {
      return prior.anchor;
    }
    const anchor = panelGrowthAnchor(body, panel);
    growthAnchorRef.current = anchor ? { index, panel, anchor, scrollY: window.scrollY } : null;
    return anchor;
  }, []);
  const restorePanelGrowth = useCallback((anchor: CharAnchor | null) => {
    const body = bodyRef.current;
    if (body && anchor) {
      const owner = typographyLayoutRef.current;
      if (owner?.anchor) restoreTypographyAnchor(body, owner.anchor);
      else {
        restorePanelAnchor(body, anchor);
        if (!owner) rememberPositionAnchor(body, positionRef.current);
      }
      if (owner) owner.scrollY = window.scrollY;
      if (growthAnchorRef.current?.anchor === anchor) growthAnchorRef.current.scrollY = window.scrollY;
    }
  }, []);

  // 全书结构摘要：开书时后台算一次，按 docId 缓存。算好之前的点击不带摘要照常发，不让第一次点击等待
  useEffect(() => {
    structureRef.current = null;
    if (!doc) return;
    if (sample) {
      structureRef.current = sample.structure;
      return;
    }
    const cached = loadStructure(docId, STRUCTURE_PROMPT_VERSION);
    if (cached) {
      structureRef.current = cached;
      preloadAutoGloss(cached);
      return;
    }
    const controller = new AbortController();
    const input = buildStructureInput({
      title: doc.meta.fileName?.replace(/\.[^.]+$/, "") || null,
      headings: doc.headings.map((h) => h.text.trim()),
      paragraphs: doc.paragraphs,
    });
    void fetchStructure(input, controller.signal).then((result) => {
      if (!result || controller.signal.aborted) return;
      structureRef.current = result.structure;
      saveStructure(docId, result.prompt, result.structure);
      preloadAutoGloss(result.structure);
    });
    return () => controller.abort();
  }, [doc, docId, preloadAutoGloss, sample]);

  useEffect(() => {
    // 预载尚未完成的点击按未命中处理；这里不写 state，段落不会因预载重渲染。
    preloadAutoGloss(structureRef.current);
  }, [preloadAutoGloss]);

  // 撑开一句就请求它的白话；收起、切换句子、离开页面时中止（D3 / D4）
  useEffect(() => {
    if (!contextMenu || expansions.has(contextMenu.index)) return;
    const savedVisible = savedRegions?.has(contextMenu.index) === true &&
      (readingMode === "review" || expandedSavedIndexes.has(contextMenu.index) || activeSavedIndex === contextMenu.index);
    if (!savedVisible) closeContextMenu();
  }, [activeSavedIndex, contextMenu, expandedSavedIndexes, expansions, readingMode, savedRegions]);

  useEffect(() => {
    if (measurement || savedRegions === null || !fontsReady || isSample) return;
    for (const [index] of expansions) {
      if (!savedRegions.has(index) || savedGlossesRef.current.has(index)) continue;
      const cacheLookup = lookupPreloadedGloss(glossMemoRef.current, index, structureRef.current !== null);
      if (cacheLookup.status === "hit") continue;
      const retry = retryCounts.get(index) ?? 0;
      const currentRun = glossRunsRef.current.get(index);
      if (currentRun?.retry === retry || (!currentRun && (glossesRef.current.get(index)?.status === "done" ||
        glossesRef.current.get(index)?.status === "failed"))) continue;
      if (currentRun) abortGloss(index);
      const controller = new AbortController();
      const run = { controller, runId: ++nextGlossRunRef.current, retry };
      glossRunsRef.current.set(index, run);
      const alive = () => !controller.signal.aborted && glossRunsRef.current.get(index) === run && expansionsRef.current.has(index);
      setGloss({ index, view: LOADING_VIEW });
      const show = (view: GlossView) => {
        if (!alive()) return;
        const anchor = capturePanelGrowth(index);
        if (anchor) setTransaction({ anchor, animateOpen: false, adjustVisibility: false });
        setGloss({ index, view });
      };
      const input = glossInput(sentences, index, structureRef.current);
      void streamGloss(input, { signal: controller.signal,
        onText: (text) => show({ status: "streaming", text, failure: null, instant: false }),
      }).then((result) => {
        if (!alive() || result.status === "aborted") return;
        const attempt = readAttemptRef.current.get(index);
        if (attempt) attempt.settled = true;
        if (result.status === "done") {
          glossMemoRef.current.set(index, { text: result.text, hasStructure: input.structure !== null, source: "session", shown: true });
          void saveGlossCache(docId, input, result.text);
          show({ status: "done", text: result.text, failure: null, instant: false });
        } else {
          const failureCode = result.rawErrorCode === "timeout" ? "C1" : result.rawErrorCode === "empty" ? "C4"
            : result.rawErrorCode === "refused" ? "C6" : result.rawErrorCode === "waf_403" || result.rawErrorCode === "upstream_429" ? "C3"
            : result.rawErrorCode === "interrupted" ? "D2" : result.rawErrorCode === "offline" ? "D1"
            : result.rawErrorCode === "api_error" ? "C2" : "OTHER";
          emitAnalytics({ event: "gloss_fail", sentenceIndex: index, failureCode,
            limitSource: result.rawErrorCode === "waf_403" ? "waf" : result.rawErrorCode === "upstream_429" ? "upstream" : null });
          show({ status: "failed", text: result.text, failure: result.failure, instant: false });
        }
        glossRunsRef.current.delete(index);
      });
    }
  }, [expansions, measurement, savedRegions, fontsReady, docId, isSample, retryCounts, sentences, capturePanelGrowth, setGloss]);
  const retryGloss = useCallback((index: number) => {
    revealProgressBySentence.delete(index);
    setGloss({ index, view: LOADING_VIEW });
    setRetryCounts((counts) => new Map(counts).set(index, (counts.get(index) ?? 0) + 1));
  }, [revealProgressBySentence, setGloss]);

  /**
   * 只有整块面板已经在视口上方时才建立字符锚定：视口顶边切在面板内时，
   * 读者正看的是整句理解，追加必须只向下生长，不能反向滚动这块内容。
   */
  const stageExplainView = useCallback((runDocId: string, index: number, view: ExplainView) => {
    if (!mountedRef.current || explainContextRef.current.docId !== runDocId) return;
    const anchor = capturePanelGrowth(index);
    if (anchor) transactionRef.current = { anchor, animateOpen: false, adjustVisibility: false };
    const next = new Map(explainViewsRef.current).set(index, view);
    explainViewsRef.current = next;
    setExplainViews(next);
  }, [capturePanelGrowth]);

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
      sample?.glosses[index] ?? null,
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
  }, [sample, stageExplainView]);

  const retryExplainFor = useCallback((index: number) => startExplainFor(index, true), [startExplainFor]);
  // 操作行「听不懂」；Paragraph 是 memo，回调必须恒定。失败后的「重试」走 retryExplainFor，不计点击。
  const explainFromActionRow = useCallback((index: number) => {
    const status = explainViewsRef.current.get(index)?.status ?? "idle";
    if (status === "loading" || status === "streaming" || status === "done") return;
    emitAnalytics({ event: "deep_explain_click", sentenceIndex: index, source: "action_row", ...sampleAnalytics });
    startExplainFor(index);
  }, [startExplainFor, sampleAnalytics]);
  const recordExplainBlocked = useCallback((index: number) => {
    window.dispatchEvent(new CustomEvent("gloss:analytics", {
      detail: { event: "deep_explain_blocked", sentenceIndex: index, ...sampleAnalytics },
    }));
  }, [sampleAnalytics]);

  function reportViewFor(index: number): GlossView | null {
    const saved = savedGlosses.get(index);
    if (saved) return { status: "done", text: saved.text, failure: null, instant: true };
    if (glosses.has(index)) return glosses.get(index)!;
    const remembered = glossMemoRef.current.get(index);
    if (remembered) return { status: "done", text: remembered.text, failure: null, instant: true };
    return null;
  }

  function reportCandidateFor(index: number) {
    const sentence = sentences[index];
    const view = reportViewFor(index);
    if (!sentence || !view) return null;
    if (view.status === "done") {
      return {
        sentence: sentence.text,
        gloss: view.text,
        result: "done" as const,
        promptVersion: savedGlosses.has(index) ? null : sample?.glossPromptVersion ?? GLOSS_PROMPT_VERSION,
      };
    }
    if (view.status === "failed" && view.failure === "refused") {
      return { sentence: sentence.text, gloss: "", result: "refused" as const, promptVersion: GLOSS_PROMPT_VERSION };
    }
    return null;
  }

  async function reportErrorFor(index: number) {
    if (reportedIndexes.has(index) || reportPendingIndex === index) return;
    const candidate = reportCandidateFor(index);
    if (!candidate) return;
    setReportPendingIndex(index);
    setReportFeedback(null);
    window.dispatchEvent(new CustomEvent("gloss:analytics", {
      detail: { event: "report_error_click", sentenceIndex: index, ...sampleAnalytics },
    }));
    try {
      const hash = await sha256(candidate.sentence);
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, ...candidate }),
      });
      if (!response.ok) {
        setReportFeedback("反馈未能提交，请稍后再试。");
        return;
      }
      setReportedIndexes((current) => new Set(current).add(index));
      setReportFeedback("已收到反馈。");
    } catch {
      setReportFeedback("反馈未能提交，请稍后再试。");
    } finally {
      setReportPendingIndex(null);
    }
  }

  function explainFromContextMenu(index: number) {
    const glossView = reportViewFor(index);
    if (!glossView || (glossView.status !== "done" && glossView.status !== "failed")) return;
    const status = explainViews.get(index)?.status ?? "idle";
    if (status === "done") {
      recordExplainBlocked(index);
      return;
    }
    if (status === "loading" || status === "streaming") return;
    window.dispatchEvent(new CustomEvent("gloss:analytics", {
      detail: { event: "deep_explain_click", sentenceIndex: index, source: "context_menu", ...sampleAnalytics },
    }));
    closeContextMenu();
    startExplainFor(index);
  }

  useLayoutEffect(() => {
    if (measurement || savedRegions === null || mobileTypographyOpen || !readAttemptRef.current.size) return;
    const sample = () => { for (const index of readAttemptRef.current.keys()) sampleReadAttempt(index); };
    sample();
    const observer = new MutationObserver(sample);
    for (const index of readAttemptRef.current.keys()) {
      const panel = panelsRef.current.get(index);
      if (panel) observer.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-state"] });
    }
    const timer = window.setInterval(sample, 100);
    window.addEventListener("scroll", sample, { passive: true });
    window.addEventListener("resize", sample);
    document.addEventListener("visibilitychange", sample);
    return () => {
      observer.disconnect(); window.clearInterval(timer); window.removeEventListener("scroll", sample);
      window.removeEventListener("resize", sample); document.removeEventListener("visibilitychange", sample);
    };
  }, [expansions, glosses, measurement, savedRegions, mobileTypographyOpen]);
  saveContextRef.current = { docId, expansions, glosses, readingMode, savedGlosses, savedRegions, sentences };
  saveActionsRef.current = { commit, commitSaved };
  const toggleSavedGlossFor = useCallback(async (index: number): Promise<"saved" | "removed" | StorageErrorCode> => {
    const context = saveContextRef.current;
    if (!context) return "E2";
    const { docId, expansions, glosses, readingMode, savedGlosses, savedRegions, sentences } = context;
    const expansion = expansions.get(index);
    const glossView = glosses.get(index) ?? LOADING_VIEW;
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
        const expanded = new Set(expandedSavedIndexesRef.current);
        expanded.delete(index);
        updateExpandedSavedIndexes(expanded);
        saveActionsRef.current.commit(
          { index, paraIndex: sentence.paraIndex, splitAt: region?.splitAt ?? null },
          { anchor, animateOpen: false },
        );
        return "removed";
      }
      if (glossView.status !== "done" || !expansion) return "E2";
      const entry = await saveSavedGloss(docId, sentence, glossView.text);
      emitAnalytics({ event: "gloss_save", sentenceIndex: index, edited: false, ...sampleAnalytics });
      const next = new Map(savedGlossesRef.current).set(index, entry);
      savedGlossesRef.current = next;
      const anchor = bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null;
      setState((current) => {
        if (current.status !== "ready") return current;
        return { ...current, savedGlosses: next };
      });
      setSavedRegions((current) => new Map(current).set(index, { index, splitAt: savedRegions?.get(index)?.splitAt ?? expansion.splitAt }));
      if (readingMode === "reading") updateExpandedSavedIndexes(new Set(expandedSavedIndexesRef.current).add(index));
      saveActionsRef.current.commitSaved(index, { anchor });
      return "saved";
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      return err.code;
    }
  }, []);
  const minHeadingLevel = Math.min(...(doc?.headings ?? []).map((h) => h.level));
  function endFontSizeAdjustment() {
    if (!fontSizeAdjustmentRef.current) return;
    fontSizeAdjustmentRef.current = null;
    typographyGestureRef.current = null;
    typographyLayoutRef.current = null;
    if (bodyRef.current) rememberPositionAnchor(bodyRef.current, positionRef.current);
  }
  function startTypographyGesture() {
    endFontSizeAdjustment();
    window.clearTimeout(typographyGestureTimerRef.current);
    typographyGestureRef.current = { anchor: bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null, pointer: true };
    typographyLayoutRef.current = { anchor: typographyGestureRef.current.anchor, scrollY: window.scrollY };
  }
  function endTypographyGesture() {
    window.clearTimeout(typographyGestureTimerRef.current);
    typographyGestureRef.current = null;
  }
  function changeTypography(value: ReaderTypography, discrete = false, fontSizeButton = false) {
    if (fontSizeButton) {
      fontSizeAdjustmentRef.current ??= { anchor: bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null };
      typographyGestureRef.current = { anchor: fontSizeAdjustmentRef.current.anchor, pointer: true };
    } else endFontSizeAdjustment();
    if (discrete || !typographyGestureRef.current) {
      typographyGestureRef.current = { anchor: bodyRef.current ? anchorAtViewportTop(bodyRef.current) : null, pointer: false };
    }
    queuedTypographyAnchorRef.current = typographyGestureRef.current.anchor;
    typographyLayoutRef.current = { anchor: typographyGestureRef.current.anchor, scrollY: window.scrollY };
    // Resolve the old layout before queuing a new one; browser scroll-range clamping is also owned here.
    if (bodyRef.current && typographyGestureRef.current.anchor) {
      restoreTypographyAnchor(bodyRef.current, typographyGestureRef.current.anchor);
      typographyLayoutRef.current.scrollY = window.scrollY;
    }
    if (!typographyGestureRef.current.pointer) {
      window.clearTimeout(typographyGestureTimerRef.current);
      typographyGestureTimerRef.current = window.setTimeout(endTypographyGesture, 300);
    }
    queuedTypographyRef.current = validateReaderTypography(value);
    if (discrete) endTypographyGesture();
    if (typographyFrameRef.current !== null) return;
    typographyFrameRef.current = window.requestAnimationFrame(() => {
      typographyFrameRef.current = null;
      const next = queuedTypographyRef.current;
      queuedTypographyRef.current = null;
      if (!next || JSON.stringify(next) === JSON.stringify(typographyRef.current)) return;
      const body = bodyRef.current;
      const anchor = queuedTypographyAnchorRef.current;
      typographyLayoutRef.current = { anchor, scrollY: window.scrollY };
      const old = typographyRef.current;
      const remeasure = next.fontSize !== old.fontSize || next.lineHeight !== old.lineHeight ||
        next.lineChars !== old.lineChars || next.bodyFont !== old.bodyFont;
      // The rAF presents one value. React's complete measurement transaction must finish before paint.
      flushSync(() => {
        clearAnimation(); cancelPendingCollapse();
        transactionRef.current = { anchor, animateOpen: false, adjustVisibility: false };
        if (remeasure) stageLayouts(new Set(visibleIndexes().map(index => sentences[index].paraIndex)), 0);
        setTypography(next);
      });
      writeReaderTypography(next);
    });
  }
  function setTypographySheet(open: boolean) {
    if (open === mobileTypographyOpenRef.current) return;
    if (!open) endFontSizeAdjustment();
    if (open) for (const attempt of readAttemptRef.current.values()) attempt.clock.stop(performance.now());
    mobileTypographyOpenRef.current = open;
    syncFloatingTypographyInteractivity(floatingTypographyEligibleRef.current);
    setMobileTypographyOpen(open);
    if (!open) restoreTypographyFocusRef.current = true;
  }
  useEffect(() => {
    if (!mobileTypographyOpen) return;
    typographySheetRef.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); setTypographySheet(false);
    };
    const outside = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.('[data-reader-settings]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); setTypographySheet(false);
    };
    const media = window.matchMedia?.("(min-width: 768px)");
    const resize = () => { if (media?.matches) setTypographySheet(false); };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("click", outside, true);
    media?.addEventListener("change", resize);
    return () => {
      document.removeEventListener("keydown", keydown, true); document.removeEventListener("click", outside, true);
      media?.removeEventListener("change", resize);
    };
  }, [mobileTypographyOpen]);
  useEffect(() => () => { if (typographyFrameRef.current !== null) cancelAnimationFrame(typographyFrameRef.current);
    window.clearTimeout(typographyGestureTimerRef.current); }, []);
  useEffect(() => {
    const release = (event?: Event) => {
      if (window.innerWidth < 768 && (event?.target as Element | null)?.closest?.('[data-reader-settings]')) return;
      endFontSizeAdjustment(); typographyLayoutRef.current = null;
    };
    let mobile = window.innerWidth < 768;
    const breakpoint = () => { const next = window.innerWidth < 768; if (next !== mobile) { endFontSizeAdjustment(); mobile = next; } };
    const key = (event: KeyboardEvent) => { if (!(event.target as Element)?.closest?.('[data-reader-settings]') &&
      ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) release(); };
    window.addEventListener('wheel', release, { passive: true }); window.addEventListener('touchstart', release, { passive: true });
    document.addEventListener('keydown', key); window.addEventListener('resize', breakpoint);
    return () => { window.removeEventListener('resize', breakpoint); window.removeEventListener('wheel', release); window.removeEventListener('touchstart', release); document.removeEventListener('keydown', key); };
  }, []);
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
    const closing = next === "reading" ? [...selectionResultsRef.current.values()].filter(result => result.saved && selectionVisible(result)).map(result => result.index) : [];
    transactionRef.current = { anchor: selectionClosingAnchor(closing, body ? anchorAtViewportTop(body) : null), animateOpen: false };
    try {
      globalThis.localStorage?.setItem(READING_MODE_KEY, next);
    } catch {
      // 设置写入失败不妨碍本次阅读；下次仍回退默认显示模式。
    }
    setActiveSavedIndex(null);
    updateExpandedSavedIndexes(new Set());
    updateNonMouseOpenedIndexes(new Set([...nonMouseOpenedIndexesRef.current].filter((index) => !savedGlossesRef.current.has(index))));
    publishSelectionResults(new Map([...selectionResultsRef.current].map(([id, result]) => [id, result.saved ? { ...result, expanded: false, nonMouse: false, actionsVisible: false } : result])));
    setReadingMode(next);
    stageLayouts(new Set(sentences.map((sentence) => sentence.paraIndex)), 0, expansionsRef.current, next, new Set());
  }, [readingMode]);
  const jumpToSaved = useCallback((index: number) => {
    typographyLayoutRef.current = null;
    const body = bodyRef.current;
    if (!body) return;
    const needsExpand = readingMode === "reading" && !expandedSavedIndexes.has(index);
    if (needsExpand || activeSavedIndex !== null) {
      pendingSavedJumpRef.current = index;
      transactionRef.current = { anchor: null, animateOpen: false };
      setActiveSavedIndex(null);
      if (needsExpand) {
        expandSaved(index);
      }
      return;
    }
    body.querySelector<HTMLElement>(`.sentence[data-index="${index}"]`)?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "instant" : "smooth",
    });
  }, [activeSavedIndex, expandedSavedIndexes, readingMode]);



  const savedItems = [
    ...[...savedGlosses].map(([index,saved])=>({ key:"sentence:"+index, text:saved.text, point:{paraIndex:sentences[index]?.paraIndex??0,offset:sentences[index]?.start??0}, time:saved.savedAt, index, selectionId:null as string|null })),
    ...[...selectionResults.values()].filter(result=>result.saved).map(result=>({key:"selection:"+result.id,text:result.saved!.text,point:result.selection.start,time:result.saved!.savedAt,index:result.index,selectionId:result.id as string|null}))
  ].sort((a,b)=>comparePoints(a.point,b.point)||a.time-b.time);

  return (
    <div className="shell" onPointerDownCapture={event => { if (event.target instanceof Element && event.target.closest("[data-selection-control]")) selectionEntryPointer.current = event.pointerType; }}>
      <aside className="col col-left">
        <Link href="/" className="wordmark">Gloss</Link>
        <Link href="/" className="reader-shelf-back" style={{ visibility: hasOwnBooks === null ? "hidden" : "visible" }}>
          <svg className="reader-back-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14" /></svg>
          <span className="reader-back-text">{hasOwnBooks ? "← 回到书架" : "← 回到首页"}</span><span className="reader-mobile-back-label reader-sr-only">{hasOwnBooks ? "回到书架" : "回到首页"}</span></Link>
        <div className="reader-mobile-heading"><strong className="reader-mobile-title">{doc?.meta.fileName?.replace(/\.[^.]+$/, "") || "阅读"}</strong>
          {mobileProgress && <span className="reader-mobile-progress">第 {mobileProgress.current} 段 · 共 {mobileProgress.total} 段</span>}
        </div>
        {mobileProgress && <div className="reader-mobile-progress-track" aria-hidden="true"><span style={{ width: `${mobileProgress.ratio * 100}%` }} /></div>}
        <FeedbackButton placement="reader" openRequest={feedbackRequest} returnFocus={feedbackReturnFocus} />

        <div className="mode-switch" role="group" aria-label="留下的白话显示设置">
          <span className="mode-label">留下的白话</span>
          <div className="mode-options">
            <button type="button" className="mode-option" aria-pressed={readingMode === "review"}
              onClick={() => changeReadingMode("review")}>
              显示
            </button>
            <button type="button" className="mode-option" aria-pressed={readingMode === "reading"}
              onClick={() => changeReadingMode("reading")}>
              收起
            </button>
          </div>
        </div>

        <button type="button" className="reader-selection-mobile" data-selection-control data-reader-settings aria-label="划选" aria-pressed={selectionMode} onClick={toggleSelection}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5M8 12h8" /></svg><span>划选</span></button>
        <button type="button" ref={attachTypographyButton} className="reader-typography-aa" data-reader-settings
          aria-label="阅读排版" aria-haspopup="dialog" aria-controls="reader-typography-sheet" aria-expanded={mobileTypographyOpen}
          onClick={() => setTypographySheet(!mobileTypographyOpenRef.current)}>Aa</button>

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

        {headingsAvailable && <section className="side-section" aria-labelledby="toc-title">
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
                    onClick={() => { typographyLayoutRef.current = null; document.getElementById(`para-${h.paraIndex}`)?.scrollIntoView(); }}
                  >
                    {h.text.trim()}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {/* 目录块始终在原位：时有时无会让读者困惑，状态自己说明自己（G-25） */}
          {doc && doc.headings.length === 0 && <p className="side-empty">这份文档没有标题层级</p>}
        </section>}

        <section className="side-section" aria-labelledby="saved-title">
          <h2 id="saved-title" className="side-title">
            留下的白话
          </h2>
          {savedItems.length === 0 ? (
            <p className="side-empty">点白话下面的「留下」，这句白话就固定下来，不会再变，并收在这里。</p>
          ) : (
            <ol className="saved-list">
              {savedItems.map(item => (
                <li key={item.key}>
                  <button type="button" className="saved-link" data-saved-selection-id={item.selectionId ?? undefined} onClick={event => { if (item.selectionId) { event.stopPropagation(); jumpToSelection(item.selectionId); } else jumpToSaved(item.index); }}>
                    {item.text}
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
        {state.status === "unreadable" && (
          <div className="reader-status">
            <Notice tone="block" message={isSample ? "示例文档不可用。" : "这份文档的本地数据不完整，打不开。可以回到书架重新导入原文件。"} />
            <Link href="/" className="reader-back">← 回到书架</Link>
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
            style={{ "--reader-font-size": `${typography.fontSize}px`, "--reader-line-height": typography.lineHeight,
              "--reader-line-chars": typography.lineChars, "--reader-body-font": `var(--font-${typography.bodyFont}-cjk)`,
              "--reader-gloss-font": `var(--font-${typography.glossFont}-cjk)` } as CSSProperties}
            className={"reader-body reader-body-reader" + (selectionMode ? " reader-body-selection" : "") + (sample && !sampleBreathed ? " reader-body-sample-breathing" : "")}
            data-measuring={measurement !== null || savedRegions === null || !fontsReady ? "true" : "false"}
            lang="zh-CN"
            onClick={handleBodyClick}
            onPointerDown={handleBodyPointerDown}
            onPointerMove={selectionPointerMove}
            onPointerUp={selectionPointerUp}
            onPointerCancel={() => { selectionGestureRef.current = null; }}
            onPointerOver={(event) => { handleGlossPointerOver(event); handleSentencePointerOver(event); }}
            onPointerOut={(event) => { handleGlossPointerOut(event); handleSentencePointerOut(event); }}
            onPointerLeave={(event) => {
              if (event.pointerType !== "mouse") return;
              clearGlossHover();
              clearSentenceHover();
            }}
            onContextMenu={handleReaderContextMenu}
          >
            {doc.paragraphs.map((_, paraIndex) => {
              return (
                <div key={paraIndex} className={"reader-paragraph" + (headingByParagraph.has(paraIndex) ? " reader-heading-block" : "")}>
                <Paragraph
                  paraIndex={paraIndex}
                  heading={headingByParagraph.get(paraIndex)}
                  pieces={piecesByParagraph[paraIndex] ?? NO_PIECES}
                  regions={regionsByParagraph[paraIndex] ?? NO_REGIONS}
                  savedMarkers={savedMarkersByParagraph[paraIndex] ?? NO_INDEXES}
                  activeIndexes={activeIndexesByParagraph[paraIndex] ?? NO_INDEXES}
                  panelRef={null}
                  panelFor={panelFor}
                  onRetry={retryGloss}
                  onBeforeReveal={capturePanelGrowth}
                  onAfterReveal={restorePanelGrowth}
                  onSave={toggleSavedGlossFor}
                  onExplain={explainFromActionRow}
                  onExplainRetry={retryExplainFor}
                  onExplainBlocked={recordExplainBlocked}
                  sentences={sentences}
                  breatheSentenceIndex={sample?.breatheSentenceIndex ?? null}
                />
                </div>
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

      <aside className="col col-right" aria-label="阅读设置">
          <SettingsPanel selectionActive={selectionMode} onSelectionToggle={toggleSelection} glossShape={glossShape} onGlossShapeChange={changeGlossShape} typography={typography} onTypographyChange={changeTypography}
            onTypographyGestureStart={startTypographyGesture} onTypographyGestureEnd={endTypographyGesture} />
      </aside>
      {selectionMode && <><SelectionBar mobile={selectionMobile} started={selectionStart !== null} selection={selection} onReselect={clearSelection} onConfirm={confirmSelection} onExit={exitSelection} />
        <span ref={selectionMarkerRef} className="reader-selection-marker" data-kind={selection ? "end" : "start"} aria-hidden="true" hidden /></>}
      <button type="button" ref={attachFloatingTypographyButton} className="reader-typography-floating-aa" data-reader-settings
        data-visible={floatingTypographyShown}
        aria-label="阅读排版" aria-haspopup="dialog" aria-controls="reader-typography-sheet" aria-expanded={mobileTypographyOpen}
        onClick={event => { event.stopPropagation(); setTypographySheet(true); }}>Aa</button>
      {mobileTypographyOpen && <div ref={typographySheetRef} id="reader-typography-sheet" className="reader-typography-sheet"
        data-reader-settings role="dialog" aria-labelledby="reader-typography-sheet-title">
        <div className="reader-typography-sheet-header"><h2 id="reader-typography-sheet-title" tabIndex={-1}>阅读设置</h2>
          <button type="button" aria-label="关闭阅读设置" onClick={() => setTypographySheet(false)}>关闭</button></div>
        <MobileReaderSettings value={typography} onChange={changeTypography} onFontSizeChange={value => changeTypography(value, false, true)} onGestureStart={startTypographyGesture} onGestureEnd={endTypographyGesture}
          glossShape={glossShape} onShapeChange={changeGlossShape} readingMode={readingMode} onModeChange={changeReadingMode}
          onFeedback={() => { setTypographySheet(false); setFeedbackRequest(value => value + 1); }} />
      </div>}
      {contextMenu && (
        <ContextMenu
          point={contextMenu.point}
          explainStatus={explainViews.get(contextMenu.index)?.status ?? "idle"}
          reportDisabled={!reportCandidateFor(contextMenu.index)}
          reported={reportedIndexes.has(contextMenu.index)}
          reportPending={reportPendingIndex === contextMenu.index}
          feedback={reportFeedback}
          onExplain={() => explainFromContextMenu(contextMenu.index)}
          onExplainBlocked={() => recordExplainBlocked(contextMenu.index)}
          onReport={() => void reportErrorFor(contextMenu.index)}
        />
      )}
    </div>
  );
}
