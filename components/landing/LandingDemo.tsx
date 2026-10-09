"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import GlossPanel, { type GlossView } from "@/components/reader/GlossPanel";
import Sentence from "@/components/reader/Sentence";
import { measureSplit, paragraphLength, paragraphOriginalFragments, splitFragmentClassName } from "@/components/reader/lineSplit";
import { loadSampleBook, type SampleBook } from "@/lib/sample";
import { segmentParagraphs } from "@/lib/segment";

const PARAGRAPH_INDEX = 2;
const FIRST_INDEX = 8;
const LAST_INDEX = 11;
const TARGET_INDEX = 10;

type DemoPiece = { index: number; start: number; text: string };
type Phase = "waiting" | "moving" | "clicking" | "revealing" | "settled";
type Point = { x: number; y: number };

function renderPieces(pieces: DemoPiece[]) {
  return pieces.map((piece) => <Sentence key={`${piece.index}:${piece.start}`} index={piece.index} offset={piece.start} text={piece.text} />);
}

export default function LandingDemo({ replayIndex }: { replayIndex: number }) {
  const [book, setBook] = useState<SampleBook | null>(null);
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  const [splitAt, setSplitAt] = useState<number | null>(null);
  const [measured, setMeasured] = useState(false);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [reservedHeight, setReservedHeight] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [pointer, setPointer] = useState<Point>({ x: 0, y: 0 });
  const [hoveredGloss, setHoveredGloss] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const expandedMeasureRef = useRef<HTMLDivElement>(null);
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
      setLayoutWidth(width);
      setSplitAt(measureSplit(measuring, PARAGRAPH_INDEX, TARGET_INDEX));
      setMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [book, pieces, reducedMotion]);

  const startPoint = useCallback((): Point => ({ x: Math.max(0, (canvasRef.current?.clientWidth ?? 0) - 30), y: 10 }), []);
  const targetPoint = useCallback((): Point => {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const target = visibleRef.current?.querySelector<HTMLElement>(`.sentence[data-index="${TARGET_INDEX}"]`);
    const rect = target?.getClientRects()[0] ?? target?.getBoundingClientRect();
    if (!canvas || !rect) return startPoint();
    return { x: rect.left - canvas.left + Math.min(rect.width / 2, 32), y: rect.top - canvas.top + rect.height / 2 };
  }, [startPoint]);
  const glossPoint = useCallback((): Point => {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const text = playRef.current?.querySelector<HTMLElement>(".gloss-panel-text");
    const rect = text?.getBoundingClientRect();
    if (!canvas || !rect) return targetPoint();
    const lineHeight = text ? parseFloat(getComputedStyle(text).lineHeight) || 24 : 24;
    return { x: rect.left - canvas.left + 20, y: rect.top - canvas.top + lineHeight / 2 };
  }, [targetPoint]);

  useLayoutEffect(() => {
    if (!ready || reducedMotion) return;
    const timers: number[] = [];
    const after = (milliseconds: number, action: () => void) => timers.push(window.setTimeout(action, milliseconds));
    setHoveredGloss(false);
    setPhase("waiting");
    setPointer(startPoint());
    after(1_000, () => {
      setPhase("moving");
      setPointer(targetPoint());
      after(650, () => {
        setPhase("clicking");
        after(180, () => setPhase("revealing"));
      });
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [ready, reducedMotion, replayIndex, splitAt, startPoint, targetPoint]);

  useEffect(() => {
    if (phase !== "revealing" || !gloss || reducedMotion) return;
    const host = playRef.current;
    if (!host) return;
    let done = false;
    let timer: number | null = null;
    const check = () => {
      if (done || host.querySelector(".gloss-panel-text")?.textContent !== gloss) return;
      done = true;
      timer = window.setTimeout(() => {
        setPointer(glossPoint());
        setPhase("settled");
      }, 500);
    };
    const observer = new MutationObserver(check);
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    check();
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [phase, gloss, glossPoint, reducedMotion, replayIndex]);

  const panelProps = {
    onRetry: () => {},
    onBeforeReveal: () => null,
    onAfterReveal: () => {},
    saved: false,
    onSave: async () => "saved" as const,
    source,
    actionVisible: false,
    sentenceIndex: TARGET_INDEX,
    onExplain: () => {},
    onExplainRetry: () => {},
    onExplainBlocked: () => {},
  };
  const finalView: GlossView = { status: "done", text: gloss, failure: null, instant: true };
  const playingView: GlossView = { status: "done", text: gloss, failure: null, instant: false, firstChunkNow: true };
  const showPanel = reducedMotion || phase === "revealing" || phase === "settled";
  const targetActive = hoveredGloss || (!reducedMotion && phase === "settled");
  const fragments = ready ? paragraphOriginalFragments(pieces, [splitAt]) : [];
  const hasTail = splitAt !== null && splitAt < paragraphLength(pieces);

  useLayoutEffect(() => {
    if (!ready || !expandedMeasureRef.current) return;
    setReservedHeight(Math.ceil(expandedMeasureRef.current.getBoundingClientRect().height));
    const panelSlot = expandedMeasureRef.current.querySelector<HTMLElement>(".landing-demo-panel-slot");
    if (panelSlot) setPanelHeight(Math.ceil(panelSlot.getBoundingClientRect().height));
  }, [ready, splitAt, layoutWidth, gloss]);

  return (
    <div className={`landing-demo-stage${targetActive ? " landing-demo-target-active" : ""}`} aria-label="阅读器白话展开演示">
      <div className="landing-demo-canvas" ref={canvasRef} style={{ minHeight: reservedHeight }}>
        {book && <div className="landing-demo-measure" ref={measureRef} aria-hidden="true"><article className="reader-body landing-demo-body" lang="zh-CN"><p data-para={PARAGRAPH_INDEX} className="reader-para">{renderPieces(pieces)}</p></article></div>}
        {ready && (
          <div className="landing-demo-expanded-measure" ref={expandedMeasureRef} aria-hidden="true">
            <article className="reader-body landing-demo-body" lang="zh-CN">
              <p data-para={PARAGRAPH_INDEX} className={splitFragmentClassName("reader-para", false, true, hasTail)}>{renderPieces(fragments[0] ?? [])}</p>
              <div className="landing-demo-panel-slot"><GlossPanel {...panelProps} view={finalView} /></div>
              {hasTail && <p data-para={PARAGRAPH_INDEX} className="reader-para reader-para-cont">{renderPieces(fragments[1] ?? [])}</p>}
            </article>
          </div>
        )}
        {ready && (
          <article ref={visibleRef} className="reader-body landing-demo-body landing-demo-visible" lang="zh-CN">
            {showPanel ? (
              <>
                <p data-para={PARAGRAPH_INDEX} className={splitFragmentClassName("reader-para", false, true, hasTail)}>{renderPieces(fragments[0] ?? [])}</p>
                <div className="landing-demo-panel-slot" style={{ height: panelHeight }}>
                  <div className="landing-demo-panel-play" ref={playRef} onMouseEnter={() => setHoveredGloss(true)} onMouseLeave={() => setHoveredGloss(false)}><GlossPanel key={replayIndex} {...panelProps} view={reducedMotion ? finalView : playingView} /></div>
                </div>
                {hasTail && <p data-para={PARAGRAPH_INDEX} className="reader-para reader-para-cont">{renderPieces(fragments[1] ?? [])}</p>}
              </>
            ) : <p data-para={PARAGRAPH_INDEX} className="reader-para">{renderPieces(pieces)}</p>}
          </article>
        )}
        {ready && !reducedMotion && <span aria-hidden="true" className={`landing-demo-pointer landing-demo-pointer-${phase}`} style={{ left: pointer.x, top: pointer.y }} />}
      </div>
    </div>
  );
}
