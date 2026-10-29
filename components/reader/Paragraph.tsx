import { Fragment } from "react";
import { memo } from "react";
import type { ElementType } from "react";
import GlossPanel from "./GlossPanel";
import { paragraphLength } from "./lineSplit";
import { splitFragmentClassName } from "./lineSplit";
import { splitParagraphTail } from "./lineSplit";
import { slicePieces } from "./lineSplit";
import Sentence from "./Sentence";
import { TailPlaceholder } from "./Sentence";
import type { Piece, ParagraphProps } from "./readerTypes";
import { NO_INDEXES, groupRegions } from "./readerRegions";

export const HEADING_TAGS: ElementType[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

/* ---------------- 渲染辅助 ---------------- */

export const NO_PIECES: Piece[] = [];

/**
 * 单个段落。用 memo 包住：撑开 / 收起时只有 splitAt 变化的一两段重新渲染。
 * 否则每次点击都会让全文上千个句子组件重新比对，在 5 万字的书上足以卡掉动画的第一帧。
 */
export const Paragraph = memo(function Paragraph({
  paraIndex,
  heading,
  pieces,
  regions,
  savedMarkers,
  panelRef,
  panelFor,
  glossKey,
  onRetry,
  onBeforeReveal,
  onAfterReveal,
  onSave,
  onExplain,
  onExplainRetry,
  onExplainBlocked,
  sentences,
  breatheSentenceIndex,
  activeIndexes = NO_INDEXES,
}: ParagraphProps) {
  const Tag: ElementType = heading ? HEADING_TAGS[Math.min(Math.max(heading.level, 1), 6) - 1] : "p";
  const className = heading ? "reader-heading" : "reader-para";
  const markerIndexes = new Set(savedMarkers);

  if (regions.length === 0) {
    return (
      <Tag id={"para-" + paraIndex} data-para={paraIndex} data-reader-block="" data-block-start={0} data-block-end={paragraphLength(pieces)} data-block-continues="false" className={className}>
        {renderPieces(pieces, markerIndexes, breatheSentenceIndex, activeIndexes)}
      </Tag>
    );
  }

  const ordered = [...groupRegions(regions).values()];
  let from = 0;
  const nodes = ordered.map((group, position) => {
    const region = group[0];
    const sentence = pieces.find((piece) => piece.index === region.index);
    const end = sentence ? sentence.start + sentence.text.trimEnd().length : from;
    const boundary = Math.max(end, region.splitAt ?? paragraphLength(pieces));
    const { head } = splitParagraphTail(pieces, slicePieces(pieces, from, boundary), [region.index], region.splitAt);
    const start = from;
    from = end;
    return (
      <Fragment key={"region:" + region.index}>
        {head.length > 0 && <Tag id={position === 0 ? "para-" + paraIndex : undefined} data-para={paraIndex}
          data-reader-block="" data-block-start={start} data-block-end={boundary}
          data-block-continues={region.splitAt !== null ? "true" : "false"}
          className={splitFragmentClassName(className, heading !== undefined, position === 0, region.splitAt !== null)}>
          {renderPieces(head, markerIndexes, breatheSentenceIndex, activeIndexes)}
        </Tag>}

        {group.map(entry => {
          const slot = entry.selectionSlot;
          const result = slot?.result;
          const title = result?.resultKind === "term" ? "「" + (result.selection.autoPunctuation ? result.selection.text.slice(0,-result.selection.autoPunctuation.length) : result.selection.text) + "」在这里指什么" : undefined;
          return <GlossPanel key={slot ? entry.glossKey : entry.saved ? "saved:" + entry.index : entry.glossKey ?? glossKey ?? "transient:" + entry.index}
            ref={slot?.panelRef ?? (panelFor ? panelFor(entry.index) : entry.saved ? undefined : panelRef)}
            view={entry.view} onRetry={slot?.onRetry ?? (()=>onRetry(entry.index))}
            onBeforeReveal={slot?.onBeforeReveal ?? onBeforeReveal} onAfterReveal={slot?.onAfterReveal ?? onAfterReveal} saved={entry.saved}
            onSave={slot?.onSave ?? (()=>onSave(entry.index))} source={result?.selection.text ?? sentences[entry.index]?.text} presentation={entry.presentation}
            actionVisible={!entry.saved || entry.actionVisible} savedIndex={entry.saved && !slot ? entry.index : undefined}
            sentenceIndex={entry.index} explainView={entry.explainView} onExplain={onExplain}
            onExplainRetry={onExplainRetry} onExplainBlocked={onExplainBlocked}
            selectionId={result?.id} title={title} selectionOnly={!!slot} />;
        })}

      </Fragment>
    );
  });
  const remaining = slicePieces(pieces, from, Infinity);
  return <Fragment>{nodes}{remaining.length > 0 && (
    <Tag data-para={paraIndex} data-reader-block="" data-block-start={from} data-block-end={paragraphLength(pieces)}
      data-block-continues="false" className="reader-para reader-para-cont">{renderPieces(remaining, markerIndexes, breatheSentenceIndex, activeIndexes)}</Tag>
  )}</Fragment>;

});

export function renderPieces(
  pieces: Piece[],
  markerIndexes: ReadonlySet<number>,
  breatheSentenceIndex: number | null,
  activeIndexes: readonly number[],
) {
  return pieces.map((p) => p.placeholder ? (
    <TailPlaceholder key={`placeholder:${p.index}:${p.start}`} text={p.text} />
  ) : (
    <Sentence key={`${p.index}:${p.start}`} index={p.index} offset={p.start} text={p.text}
      breathe={p.index === breatheSentenceIndex} savedCollapsed={markerIndexes.has(p.index)} active={activeIndexes.includes(p.index)} />
  ));
}
