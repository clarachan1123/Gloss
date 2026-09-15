"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ElementType } from "react";
import Notice from "@/components/Notice";
import { segmentParagraphs, type Sentence as SentenceData } from "@/lib/segment";
import {
  StorageError,
  loadDocument,
  loadReadingPosition,
  saveReadingPosition,
  type StoredDocument,
} from "@/lib/storage";
import Sentence from "./Sentence";

/** PRD 3.5 M1 设置面板六项。本 issue 只做骨架，无控件 */
const SETTINGS = ["呈现模式", "保存形态", "导出形态", "字号", "行距", "纸面底色"];

/** 滚动停下多久后保存阅读位置 */
const SAVE_DELAY_MS = 300;

/** 句首离视口顶端在这个距离内，就算「已到顶」（吸收滚动后的亚像素误差） */
const TOP_TOLERANCE_PX = 2;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; doc: StoredDocument }
  | { status: "missing" }
  | { status: "unavailable" };

const HEADING_TAGS: ElementType[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

export default function Reader({ docId }: { docId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const bodyRef = useRef<HTMLElement>(null);

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

  const sentencesByParagraph = useMemo(() => {
    const groups: SentenceData[][] = (doc?.paragraphs ?? []).map(() => []);
    for (const s of sentences) groups[s.paraIndex]?.push(s);
    return groups;
  }, [doc, sentences]);

  const headingByParagraph = useMemo(
    () => new Map((doc?.headings ?? []).map((h) => [h.paraIndex, h])),
    [doc],
  );

  // 阅读位置：恢复到保存的句子；滚动时记录视口顶部所在的句子；布局变化时保持同一句在顶部
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!doc || !body || sentences.length === 0) return;

    history.scrollRestoration = "manual";
    const saved = loadReadingPosition(docId);
    // 当前读到的句子。只由用户滚动更新，布局变化（窗口宽度、字体加载、以后的字号行距与侧栏收起）不改它
    let anchor = saved !== null && saved < sentences.length ? saved : 0;
    scrollToSentence(body, anchor);

    const layoutKey = () => `${body.clientWidth}x${body.scrollHeight}`;
    let layout = layoutKey();
    let timer: number | undefined;

    const flush = () => {
      window.clearTimeout(timer);
      saveReadingPosition(docId, anchor);
    };
    const onScroll = () => {
      // 布局刚变过：这次滚动是浏览器保持像素位置造成的，不是用户在读，交给 ResizeObserver 重新锚定
      if (layoutKey() !== layout) return;
      anchor = topSentenceIndex(body);
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, SAVE_DELAY_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const observer = new ResizeObserver(() => {
      layout = layoutKey();
      scrollToSentence(body, anchor);
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

  const minHeadingLevel = Math.min(...(doc?.headings ?? []).map((h) => h.level));

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
          {doc && doc.headings.length === 0 && <p className="side-empty">没有识别到标题</p>}
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
          <article ref={bodyRef} className="reader-body" lang="zh-CN">
            {doc.paragraphs.map((_, paraIndex) => {
              const heading = headingByParagraph.get(paraIndex);
              const Tag: ElementType = heading ? HEADING_TAGS[Math.min(Math.max(heading.level, 1), 6) - 1] : "p";
              return (
                <Tag
                  key={paraIndex}
                  id={`para-${paraIndex}`}
                  className={heading ? "reader-heading" : "reader-para"}
                >
                  {sentencesByParagraph[paraIndex].map((s, i) => (
                    // 原文段首的全角空格不渲染，缩进由 CSS 的 text-indent 承担
                    <Sentence key={s.index} index={s.index} text={i === 0 ? s.text.replace(/^\s+/, "") : s.text} />
                  ))}
                </Tag>
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

/** 行内句子的首行顶边（相对视口） */
function firstLineTop(el: HTMLElement): number {
  return (el.getClientRects()[0] ?? el.getBoundingClientRect()).top;
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
