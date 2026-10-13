"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import GlossPanel, { type ExplainView, type GlossView } from "@/components/reader/GlossPanel";
import Sentence, { TailPlaceholder } from "@/components/reader/Sentence";
import { measureSplit, paragraphLength, paragraphOriginalFragments, splitFragmentClassName, splitParagraphTail, slicePieces } from "@/components/reader/lineSplit";
import { loadSampleBook, type SampleBook } from "@/lib/sample";
import { segmentParagraphs } from "@/lib/segment";

const PARAGRAPH_INDEX = 2;
const FIRST_INDEX = 8;
const LAST_INDEX = 11;
const TARGET_INDEX = 10;

type DemoPiece = { index: number; start: number; text: string; placeholder?: boolean };
// explain-v3，2026-10-13 在正式站对示例书第 11 句（下标 10）生成
export const DEMO_EXPLANATION = "作者在这里不是要证明无产阶级道德说本身绝对正确，而是先限定立场：只有站在劳动群众一边，才能把它判为现时最正确的标准。这个“只能”把判断权从普遍真理挪到阶级观点上，正好呼应全文否定绝对善恶的结论。破折号里的“促进社会进化”是给出取舍尺度，说明正确与否只看是否推动进化，而不是看它是否永久不变。";
const EXPLAIN_CHARS = Array.from(DEMO_EXPLANATION);
const ignoreStep = () => {};
type Phase = "waiting" | "moving" | "clicking" | "revealing" | "gloss-ready" | "explain-moving" | "explain-clicking" | "explain-pending" | "explain-revealing" | "explain-complete" | "settled";
type Point = { x: number; y: number };

function renderPieces(pieces: DemoPiece[]) {
  return pieces.map((piece) => piece.placeholder ? <TailPlaceholder key={`placeholder:${piece.index}:${piece.start}`} text={piece.text} /> : <Sentence key={`${piece.index}:${piece.start}`} index={piece.index} offset={piece.start} text={piece.text} />);
}

export default function LandingDemo({ replayIndex, onStepChange = ignoreStep }: { replayIndex: number; onStepChange?: (step: 0 | 1 | 2) => void }) {
  const [book, setBook] = useState<SampleBook | null>(null);
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  const [splitAt, setSplitAt] = useState<number | null>(null);
  const [measured, setMeasured] = useState(false);
  const [explainShown, setExplainShown] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [pointer, setPointer] = useState<Point>({ x: 0, y: 0 });
  const [pointerReady, setPointerReady] = useState(false);
  const [replayStage, setReplayStage] = useState<"out" | "reset" | "in" | null>(null);
  const hasPointerRef = useRef(false);
  const [hoveredGloss, setHoveredGloss] = useState(false);
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<HTMLElement>(null);
  const playRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([loadSampleBook(), document.fonts?.ready ?? Promise.resolve()])
      .then(([sample]) => { if (active) setBook(sample); })
      .catch(() => { if (active) setBook(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);

  const pieces = useMemo(() => {
    if (!book) return [];
    const selected = segmentParagraphs(book.doc.paragraphs).sentences
      .filter((sentence) => sentence.paraIndex === PARAGRAPH_INDEX && sentence.index >= FIRST_INDEX && sentence.index <= LAST_INDEX);
    let offset = 0;
    return selected.map((sentence, ordinal) => {
      const text = ordinal === 0 ? sentence.text.replace(/^\s+/, "") : sentence.text;
      const piece = { index: sentence.index, start: offset, text };
      offset += text.length;
      return piece;
    });
  }, [book]);
  const gloss = book?.content.glosses[TARGET_INDEX] ?? "";
  const source = pieces.find((piece) => piece.index === TARGET_INDEX)?.text;
  const ready = !!book && pieces.length === LAST_INDEX - FIRST_INDEX + 1 && reducedMotion !== null && measured;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const measuring = measureRef.current;
    if (!book || reducedMotion === null || !canvas || !measuring || pieces.length !== 4) return;
    let previousWidth = -1;
    const measure = () => {
      const width = canvas.clientWidth;
      if (width === previousWidth) return;
      previousWidth = width;
      setSplitAt(measureSplit(measuring, PARAGRAPH_INDEX, TARGET_INDEX));
      setMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [book, pieces, reducedMotion]);

  useEffect(() => {
    if (!ready || reducedMotion || startedRef.current) return;
    const start = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      setStarted(true);
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return;
    }
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.target === stage && entry.isIntersecting && entry.intersectionRatio >= 0.5)) {
        start();
        observer.disconnect();
      }
    }, { threshold: 0.5 });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [ready, reducedMotion]);

  const startPoint = useCallback((): Point => ({ x: Math.max(0, (canvasRef.current?.clientWidth ?? 0) - 30), y: 10 }), []);
  const targetPoint = useCallback((): Point => {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const target = visibleRef.current?.querySelector<HTMLElement>(`.sentence[data-index="${TARGET_INDEX}"]`);
    const rect = target?.getClientRects()[0] ?? target?.getBoundingClientRect();
    if (!canvas || !rect) return startPoint();
    return { x: rect.left - canvas.left + Math.min(rect.width / 2, 32), y: rect.top - canvas.top + rect.height / 2 };
  }, [startPoint]);
  const explainPoint = useCallback((): Point => {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const button = playRef.current?.querySelector<HTMLElement>(".action-row-explain")?.getBoundingClientRect();
    if (!canvas || !button) return targetPoint();
    return { x: button.left - canvas.left + 22, y: button.top - canvas.top + button.height / 2 };
  }, [targetPoint]);
  const tailPoint = useCallback((): Point => {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    const tail = visibleRef.current?.querySelector(".reader-para-cont");
    if (!canvas || !stage || !tail) return explainPoint();
    const walker = document.createTreeWalker(tail, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) last = walker.currentNode as Text;
    if (!last) return explainPoint();
    let offset = last.length - 1;
    while (offset > 0 && !last.data[offset].trim()) offset--;
    const range = document.createRange();
    range.setStart(last, offset); range.setEnd(last, offset + 1);
    const rect = range.getBoundingClientRect();
    return { x: Math.min(rect.right + 10, stage.right - 21) - canvas.left, y: rect.top + 2 - canvas.top };
  }, [explainPoint]);

  useLayoutEffect(() => {
    if (ready && reducedMotion) onStepChange(2);
  }, [ready, reducedMotion, onStepChange, replayIndex]);

  useLayoutEffect(() => {
    if (!ready || reducedMotion || !started) return;
    const timers: number[] = [];
    const after = (milliseconds: number, action: () => void) => timers.push(window.setTimeout(action, milliseconds));
    setHoveredGloss(false);
    setPhase("waiting");
    setExplainShown(0);
    onStepChange(0);
    const frames: number[] = [];
    const frame = (action: () => void) => frames.push(window.requestAnimationFrame(action));
    const beginWaiting = () => {
      setReplayStage(null);
      after(1_000, () => {
        setPhase("moving");
        onStepChange(1);
        setPointer(targetPoint());
        after(650, () => {
          setPhase("clicking");
          after(180, () => setPhase("revealing"));
        });
      });
    };
    if (hasPointerRef.current) {
      setReplayStage("out");
      after(200, () => {
        setReplayStage("reset");
        // Paint a fully transparent frame before changing coordinates, then
        // paint the new position while still transparent before fading in.
        frame(() => frame(() => {
          setPointer(startPoint());
          frame(() => frame(() => {
            setReplayStage("in");
            after(200, beginWaiting);
          }));
        }));
      });
    } else {
      hasPointerRef.current = true;
      setPointer(startPoint());
      setPointerReady(true);
      beginWaiting();
    }
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      frames.forEach((id) => window.cancelAnimationFrame(id));
    };
  }, [ready, reducedMotion, started, replayIndex, splitAt, startPoint, targetPoint, onStepChange]);

  useEffect(() => {
    if (phase !== "revealing" || !gloss || reducedMotion) return;
    const host = playRef.current;
    if (!host) return;
    const check = () => {
      const button = host.querySelector(".action-row-explain");
      if (host.querySelector(".gloss-panel-text")?.textContent === gloss && button?.getAttribute("aria-hidden") === "false") setPhase("gloss-ready");
    };
    const observer = new MutationObserver(check);
    observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true });
    check();
    return () => observer.disconnect();
  }, [phase, gloss, reducedMotion, replayIndex]);

  useEffect(() => {
    if (reducedMotion) return;
    let timer: number | undefined;
    if (phase === "gloss-ready") timer = window.setTimeout(() => {
      setPhase("explain-moving"); onStepChange(2); setPointer(explainPoint());
    }, 1_600);
    else if (phase === "explain-moving") timer = window.setTimeout(() => setPhase("explain-clicking"), 700);
    else if (phase === "explain-clicking") timer = window.setTimeout(() => setPhase("explain-pending"), 260);
    else if (phase === "explain-pending") timer = window.setTimeout(() => setPhase("explain-revealing"), 700);
    else if (phase === "explain-revealing") timer = window.setTimeout(() => {
      const next = Math.min(explainShown + 4, EXPLAIN_CHARS.length);
      setExplainShown(next);
      if (next === EXPLAIN_CHARS.length) setPhase("explain-complete");
    }, 70);
    else if (phase === "explain-complete") timer = window.setTimeout(() => {
      setPointer(tailPoint()); setPhase("settled");
    }, 600);
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [phase, reducedMotion, explainShown, explainPoint, tailPoint, onStepChange, replayIndex]);

  const explainStatus: ExplainView["status"] = reducedMotion || phase === "explain-complete" || phase === "settled" ? "done" : phase === "explain-pending" ? "loading" : phase === "explain-revealing" ? "streaming" : "idle";
  const explainView: ExplainView = { status: explainStatus, text: reducedMotion ? DEMO_EXPLANATION : EXPLAIN_CHARS.slice(0, explainShown).join(""), sentenceCount: 0, failure: null };
  const panelProps = {
    onRetry: () => {},
    onBeforeReveal: () => null,
    onAfterReveal: () => {},
    saved: false,
    onSave: async () => "saved" as const,
    source,
    actionVisible: true,
    explainView,
    sentenceIndex: TARGET_INDEX,
    onExplain: () => {},
    onExplainRetry: () => {},
    onExplainBlocked: () => {},
  };
  const finalView: GlossView = { status: "done", text: gloss, failure: null, instant: true };
  const playingView: GlossView = { status: "done", text: gloss, failure: null, instant: false, firstChunkNow: true };
  const showPanel = reducedMotion || !["waiting", "moving", "clicking"].includes(phase);
  const targetActive = hoveredGloss || (!reducedMotion && phase === "settled");
  const fragments = ready ? paragraphOriginalFragments(pieces, [splitAt]) : [];
  const { head } = splitParagraphTail(pieces, fragments[0] ?? [], [TARGET_INDEX], splitAt);
  const hasTail = splitAt !== null && splitAt < paragraphLength(pieces);
  const target = pieces.find((piece) => piece.index === TARGET_INDEX);
  const continuation = slicePieces(pieces, target ? target.start + target.text.trimEnd().length : Infinity, Infinity);

  return (
    <div ref={stageRef} className={`landing-demo-stage${phase === "explain-clicking" ? " landing-demo-explain-pressed" : ""}${targetActive ? " landing-demo-target-active" : ""}`} aria-label="阅读器白话展开演示">
      <div className="landing-demo-canvas" ref={canvasRef}>
        {book && <div className="landing-demo-measure" ref={measureRef} aria-hidden="true"><article className="reader-body landing-demo-body" lang="zh-CN"><p data-para={PARAGRAPH_INDEX} className="reader-para">{renderPieces(pieces)}</p></article></div>}
        {ready && (
          <article ref={visibleRef} className="reader-body landing-demo-body landing-demo-visible" lang="zh-CN">
            {showPanel ? (
              <>
                <p data-para={PARAGRAPH_INDEX} className={splitFragmentClassName("reader-para", false, true, hasTail)}>{renderPieces(head)}</p>
                <div className="landing-demo-panel-slot">
                  <div className="landing-demo-panel-play" inert ref={playRef} onMouseEnter={() => setHoveredGloss(true)} onMouseLeave={() => setHoveredGloss(false)}><GlossPanel key={replayIndex} {...panelProps} view={reducedMotion ? finalView : playingView} /></div>
                </div>
                {continuation.length > 0 && <p data-para={PARAGRAPH_INDEX} className="reader-para reader-para-cont">{renderPieces(continuation)}</p>}
              </>
            ) : <p data-para={PARAGRAPH_INDEX} className="reader-para">{renderPieces(pieces)}</p>}
          </article>
        )}
        {ready && !reducedMotion && pointerReady && <span aria-hidden="true" className={`landing-demo-pointer landing-demo-pointer-${phase}${replayStage ? ` landing-demo-pointer-replay-${replayStage}` : ""}`} style={{ left: pointer.x, top: pointer.y, ...(replayStage === "reset" ? { opacity: 0, transition: "none" } : {}) }} />}
      </div>
    </div>
  );
}
