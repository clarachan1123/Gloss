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
import { lookupPreloadedGloss, preloadGlossCache, saveGlossCache, type PreloadedGloss } from "@/lib/cache";
import { MAX_AFTER, MAX_BEFORE } from "@/lib/context";
import { fetchStructure, streamGloss } from "@/lib/gloss-client";
import { skippedSummary, type ParsedHeading } from "@/lib/parse/validate";
import { STRUCTURE_PROMPT_VERSION } from "@/lib/prompts/structure";
import { segmentParagraphs, type Sentence as SentenceData } from "@/lib/segment";
import {
  StorageError,
  loadDocument,
  loadReadingPosition,
  loadStructure,
  saveReadingPosition,
  saveStructure,
  type StoredDocument,
} from "@/lib/storage";
import GlossPanel, { LOADING_VIEW, type GlossView } from "./GlossPanel";
import Sentence from "./Sentence";

/** PRD 3.5 M1 设置面板六项。本 issue 只做骨架，无控件 */
const SETTINGS = ["呈现模式", "保存形态", "导出形态", "字号", "行距", "纸面底色"];

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
  | { status: "ready"; doc: StoredDocument }
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

/** 视口锚点：段内某个字在 DOM 变化前的视口纵坐标。DOM 变化后把这个字滚回原位 */
interface CharAnchor {
  paraIndex: number;
  offset: number;
  viewportTop: number;
}

interface Transaction {
  anchor: CharAnchor | null;
  animateOpen: boolean;
}

/** 阅读位置锚：视口顶部所在的句子，及其首行在视口中的纵坐标 */
interface PositionAnchor {
  index: number;
  offset: number;
  layout: string;
}

interface Animation {
  elements: HTMLElement[];
  panel: HTMLElement | null;
  timer?: number;
}

export default function Reader({ docId }: { docId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [expansion, setExpansion] = useState<Expansion | null>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<PositionAnchor>({ index: 0, offset: 0, layout: "" });
  const transactionRef = useRef<Transaction | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const collapseTimerRef = useRef<number | undefined>(undefined);
  const lastToggleRef = useRef<{ index: number; time: number } | null>(null);

  // 功能一（G-07）
  const [gloss, setGloss] = useState<{ index: number; view: GlossView } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  /** 本次会话与 IndexedDB 预载的自动白话；只放 ref，预载完成不触发段落重渲染。 */
  const glossMemoRef = useRef(new Map<number, PreloadedGloss>());
  const glossAbortRef = useRef<AbortController | null>(null);
  /** 全书结构摘要；开书时后台算，算好之前为 null */
  const structureRef = useRef<string | null>(null);
  const cachePreloadTokenRef = useRef(0);

  useEffect(() => {
    try {
      const doc = loadDocument(docId);
      setState(doc ? { status: "ready", doc } : { status: "missing" });
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      setState({ status: "unavailable" });
    }
  }, [docId]);

  const doc = state.status === "ready" ? state.doc : null;

  // 不存 sentences，每次加载重算（G-03 保证确定性）
  const sentences = useMemo(() => (doc ? segmentParagraphs(doc.paragraphs).sentences : []), [doc]);

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

  const cacheInputs = useMemo(
    () => sentences.map((_, index) => ({ index, input: glossInput(sentences, index, null) })),
    [sentences],
  );

  const preloadAutoGloss = useCallback(
    (structure: string | null) => {
      const token = ++cachePreloadTokenRef.current;
      void preloadGlossCache(docId, cacheInputs, structure).then((entries) => {
        if (cachePreloadTokenRef.current === token) glossMemoRef.current = entries;
      });
    },
    [cacheInputs, docId],
  );

  // 阅读位置：恢复到保存的句子；滚动时记录视口顶部所在的句子；布局变化时保持它在视口中的位置
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!doc || !body || sentences.length === 0) return;

    history.scrollRestoration = "manual";
    const saved = loadReadingPosition(docId);
    const initial = saved !== null && saved < sentences.length ? saved : 0;
    scrollToSentence(body, initial);
    const position = positionRef.current;
    position.index = initial;
    position.offset = sentenceTop(body, initial);
    position.layout = layoutKey(body);

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
      // 撑开 / 收起已经自己锚定过视口（见下方事务），这里不再二次校正
      if (key === current.layout) return;
      current.layout = key;
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
  }, [doc, docId, sentences.length]);

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
    setExpansion(next);
  }

  function open(index: number, target: HTMLElement, clientX: number, clientY: number) {
    const body = bodyRef.current;
    const sentence = sentences[index];
    if (!body || !sentence) return;

    cancelPendingCollapse();
    const splitAt = headingByParagraph.has(sentence.paraIndex)
      ? null
      : measureSplit(body, sentence.paraIndex, index);
    const cacheLookup = lookupPreloadedGloss(glossMemoRef.current, index, structureRef.current !== null);
    // 命中必须和撑开状态同一批 React 更新：第一次 DOM 更新直接放完整白话，不先经过加载态。
    if (cacheLookup.status === "hit") {
      setGloss({ index, view: { status: "done", text: cacheLookup.entry.text, failure: null, instant: true } });
    }
    // 切换句子时，前一个撑开区在同一次提交里直接移除（不播收起动画），参照物是新点的这一行
    commit(
      { index, paraIndex: sentence.paraIndex, splitAt },
      { anchor: anchorAtClick(target, clientX, clientY), animateOpen: !prefersReducedMotion() },
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
    const target = (event.target as Element).closest<HTMLElement>(".sentence");
    if (!target) return;
    const index = Number(target.dataset.index);

    const now = performance.now();
    const last = lastToggleRef.current;
    if (last && last.index === index && now - last.time < CLICK_DEBOUNCE_MS) return;
    lastToggleRef.current = { index, time: now };

    if (expansion?.index === index && collapseTimerRef.current === undefined) {
      collapse(true);
    } else {
      open(index, target, event.clientX, event.clientY);
    }
  }

  // 每次撑开 / 收起提交后、浏览器绘制前：锚定视口 → 自动微调滚动 → 启动动画
  useLayoutEffect(() => {
    const transaction = transactionRef.current;
    transactionRef.current = null;
    const body = bodyRef.current;
    if (!transaction || !body) return;

    clearAnimation();

    // ① 视口锚定（产品不变量）：把参照字滚回 DOM 变化前的位置。
    //    改动在参照字下方时补偿为 0（D13 保证上方的行不重排）；改动在上方时，补偿恰好抵消文档高度的变化
    if (transaction.anchor) {
      const top = charTop(body, transaction.anchor.paraIndex, transaction.anchor.offset);
      if (top !== null) {
        const delta = top - transaction.anchor.viewportTop;
        if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: "instant" });
      }
    }
    rememberTopSentence(body, positionRef.current);
    positionRef.current.layout = layoutKey(body);

    const panel = panelRef.current;
    if (!expansion || !panel) return;

    // ② G6：整句或撑开区被视口截断时才微调；否则点击行纹丝不动
    const adjustment = visibilityAdjustment(body, expansion.index, panel);

    // ③ 动画：撑开区一次性插入到最终高度（只触发这一次重排），
    //    再让视口内原本就在它下方的元素从旧位置 transform 回来——每帧只动合成层
    if (transaction.animateOpen) {
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
  }, [expansion]);

  // 收起条件：点别处、Esc（PRD 3.7）、该句滚出视口（G3）
  useEffect(() => {
    const body = bodyRef.current;
    if (!expansion || !body) return;

    const onDocumentClick = (event: MouseEvent) => {
      if (hasTextSelection()) return;
      const target = event.target as Element | null;
      if (target?.closest?.(".sentence, .gloss-panel")) return;
      collapse(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse(true);
    };

    const visible = new Set<Element>();
    let initialized = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      if (initialized && visible.size === 0) collapse(false);
      initialized = true;
    });
    body.querySelectorAll(`[data-index="${expansion.index}"]`).forEach((span) => observer.observe(span));

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
      // R2：结构摘要就绪后，无摘要候选全部失效，只接受带摘要的自动缓存。
      glossMemoRef.current = new Map();
      preloadAutoGloss(result.structure);
    });
    return () => controller.abort();
  }, [doc, docId, preloadAutoGloss]);

  useEffect(() => {
    // 预载尚未完成的点击按未命中处理；这里不写 state，段落不会因预载重渲染。
    glossMemoRef.current = new Map();
    preloadAutoGloss(structureRef.current);
  }, [preloadAutoGloss]);

  // 撑开一句就请求它的白话；收起、切换句子、离开页面时中止（D3 / D4）
  const activeIndex = expansion?.index ?? null;
  useEffect(() => {
    if (activeIndex === null) return;
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
        const remembered = { text: result.text, hasStructure: input.structure !== null };
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
  const glossView = gloss && gloss.index === activeIndex ? gloss.view : LOADING_VIEW;
  // 每次重试换一个 key，撑开区重新挂载，逐块放字的进度从头开始
  const glossKey = `${activeIndex}:${retryCount}`;

  const minHeadingLevel = Math.min(...(doc?.headings ?? []).map((h) => h.level));
  // 左栏常驻信息（G-25）：全部来自已存的记录，不随滚动变化，不新增状态
  const skippedLine = skippedSummary(doc?.meta.skipped);

  return (
    <div className="shell">
      <aside className="col col-left">
        <Link href="/" className="wordmark">
          Gloss
        </Link>

        <div className="mode-switch" aria-label="阅读模式（尚未开放）">
          <span className="mode-option mode-option-active">阅读态</span>
          <span className="mode-option">复习态</span>
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
          <p className="side-empty">还没有保存的白话</p>
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
          <article ref={bodyRef} className="reader-body" lang="zh-CN" onClick={handleBodyClick}>
            {doc.paragraphs.map((_, paraIndex) => {
              const expanded = expansion?.paraIndex === paraIndex;
              return (
                <Paragraph
                  key={paraIndex}
                  paraIndex={paraIndex}
                  heading={headingByParagraph.get(paraIndex)}
                  pieces={piecesByParagraph[paraIndex] ?? NO_PIECES}
                  splitAt={expanded ? expansion.splitAt : undefined}
                  panelRef={panelRef}
                  // 只交给撑开的那一段：白话逐字更新时，其余段落的 memo 不失效
                  gloss={expanded ? glossView : undefined}
                  glossKey={expanded ? glossKey : undefined}
                  onRetry={expanded ? retryGloss : undefined}
                  // 被点击的原句，供白话面板逐字校验术语标记（G-08 验收 a）。字符串按值比较，不破坏其余段落的 memo
                  glossSource={expanded && activeIndex !== null ? sentences[activeIndex]?.text : undefined}
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
        <h2 id="settings-title" className="side-title">
          设置
        </h2>
        <ul className="settings-skeleton">
          {SETTINGS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/* ---------------- 渲染辅助 ---------------- */

const NO_PIECES: Piece[] = [];

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
  /** undefined：本段未撑开；null：撑开区放在整段之后；数字：在该偏移处行尾拆分 */
  splitAt: number | null | undefined;
  panelRef: Ref<HTMLDivElement>;
  /** 以下四项只有撑开的段落才有 */
  gloss?: GlossView;
  glossKey?: string;
  onRetry?: () => void;
  /** 被点击的原句：白话里的术语标记必须逐字出自这里 */
  glossSource?: string;
}

const noop = () => {};

/** 功能一的上下文窗口：目标句 + 前后各至多 2 句（跨段照取）+ 全书结构摘要 */
function glossInput(sentences: SentenceData[], index: number, structure: string | null) {
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

/**
 * 单个段落。用 memo 包住：撑开 / 收起时只有 splitAt 变化的一两段重新渲染。
 * 否则每次点击都会让全文上千个句子组件重新比对，在 5 万字的书上足以卡掉动画的第一帧。
 */
const Paragraph = memo(function Paragraph({
  paraIndex,
  heading,
  pieces,
  splitAt,
  panelRef,
  gloss,
  glossKey,
  onRetry,
  glossSource,
}: ParagraphProps) {
  const Tag: ElementType = heading ? HEADING_TAGS[Math.min(Math.max(heading.level, 1), 6) - 1] : "p";
  const className = heading ? "reader-heading" : "reader-para";

  if (splitAt === undefined) {
    return (
      <Tag id={`para-${paraIndex}`} data-para={paraIndex} className={className}>
        {renderPieces(pieces)}
      </Tag>
    );
  }

  // 行尾拆分：上半段（含被点击句的全部行）+ 撑开区 + 下半段（从下一行行首接着排）
  const head = splitAt === null ? pieces : slicePieces(pieces, 0, splitAt);
  const tail = splitAt === null ? NO_PIECES : slicePieces(pieces, splitAt, Infinity);
  return (
    <Fragment>
      <Tag
        id={`para-${paraIndex}`}
        data-para={paraIndex}
        className={tail.length > 0 ? `${className} reader-para-head` : className}
      >
        {renderPieces(head)}
      </Tag>
      <GlossPanel
        key={glossKey}
        ref={panelRef}
        view={gloss ?? LOADING_VIEW}
        onRetry={onRetry ?? noop}
        source={glossSource}
      />
      {tail.length > 0 && (
        <p data-para={paraIndex} className="reader-para reader-para-cont">
          {renderPieces(tail)}
        </p>
      )}
    </Fragment>
  );
});

function renderPieces(pieces: Piece[]) {
  return pieces.map((p) => <Sentence key={`${p.index}:${p.start}`} index={p.index} offset={p.start} text={p.text} />);
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
