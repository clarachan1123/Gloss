import { countChars } from "./parse/validate";
import type { Sentence } from "./segment";
export interface SourcePoint { paraIndex: number; offset: number }
export interface SourceGlyph { kind: "source" | "panel" | "placeholder" | "note"; start: SourcePoint; end: SourcePoint; left: number; right: number; top: number; bottom: number }
export interface SourceSelection { start: SourcePoint; end: SourcePoint; text: string; autoPunctuation: string; chars: number; sentenceCount: number; kind: "sentence" | "term" | "range" }
export const MAX_SELECTION_CHARS = 1000;
// 集中包括分句器使用的句读、成对符号及中英文常见标点。
export const SELECTION_PUNCTUATION = /[\p{P}﹏～~]/u;
export const comparePoints = (a: SourcePoint, b: SourcePoint) => a.paraIndex - b.paraIndex || a.offset - b.offset;
export function sourcePointFromGlyphs(glyphs: readonly SourceGlyph[], x: number, y: number): SourcePoint | null {
  return glyphs.find(g => g.kind === "source" && x >= g.left && x < g.right && y >= g.top && y < g.bottom)?.start ?? null;
}
function codePointStart(text: string, offset: number): number {
  const i = Math.max(0, Math.min(offset, text.length - 1));
  return i > 0 && /[\uDC00-\uDFFF]/u.test(text[i]) && /[\uD800-\uDBFF]/u.test(text[i - 1]) ? i - 1 : i;
}
export function selectionText(paragraphs: readonly string[], start: SourcePoint, end: SourcePoint): string {
  return paragraphs.slice(start.paraIndex, end.paraIndex + 1).map((p, i) => p.slice(i === 0 ? start.offset : 0, start.paraIndex + i === end.paraIndex ? end.offset : p.length)).join("\n");
}
export function normalizeSelection(paragraphs: readonly string[], sentences: readonly Sentence[], a: SourcePoint, b: SourcePoint): SourceSelection | null {
  let [start, last] = comparePoints(a, b) <= 0 ? [{ ...a }, { ...b }] : [{ ...b }, { ...a }];
  if (!paragraphs[start.paraIndex] || !paragraphs[last.paraIndex]) return null;
  start.offset = codePointStart(paragraphs[start.paraIndex], start.offset);
  last.offset = codePointStart(paragraphs[last.paraIndex], last.offset);
  const end = { ...last, offset: last.offset + String.fromCodePoint(paragraphs[last.paraIndex].codePointAt(last.offset)!).length };
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  for (const part of segmenter.segment(paragraphs[start.paraIndex])) {
    if (start.offset >= part.index && start.offset < part.index + part.segment.length) { start.offset = part.index; break; }
  }
  for (const part of segmenter.segment(paragraphs[end.paraIndex])) {
    if (end.offset > part.index && end.offset <= part.index + part.segment.length) { end.offset = part.index + part.segment.length; break; }
  }
  while (comparePoints(start, end) < 0) {
    const p = paragraphs[start.paraIndex];
    if (start.offset >= p.length) { start = { paraIndex: start.paraIndex + 1, offset: 0 }; continue; }
    const c = String.fromCodePoint(p.codePointAt(start.offset)!);
    if (!SELECTION_PUNCTUATION.test(c) && !/\s/u.test(c)) break;
    start.offset += c.length;
  }
  if (comparePoints(start, end) >= 0) return null;
  let autoPunctuation = "";
  const nextChar = [...paragraphs[end.paraIndex].slice(end.offset)][0];
  if (nextChar && SELECTION_PUNCTUATION.test(nextChar)) { autoPunctuation = nextChar; end.offset += nextChar.length; }
  const text = selectionText(paragraphs, start, end);
  const touched = sentences.filter(s => comparePoints({ paraIndex: s.paraIndex, offset: s.start }, end) < 0 &&
    comparePoints({ paraIndex: s.paraIndex, offset: s.start + s.text.length }, start) > 0);
  const one = touched.length === 1 ? touched[0] : null;
  const originalStart = one ? one.start + (one.start === 0 ? one.text.length - one.text.trimStart().length : 0) : -1;
  const exact = one && start.paraIndex === one.paraIndex && end.paraIndex === one.paraIndex &&
    start.offset === originalStart && end.offset === one.start + one.text.length;
  const core = autoPunctuation ? text.slice(0, -autoPunctuation.length) : text;
  const kind = exact ? "sentence" : one && !SELECTION_PUNCTUATION.test(core) && countChars(core) <= 12 ? "term" : "range";
  return { start, end, text, autoPunctuation, chars: countChars(text), sentenceCount: touched.length, kind };
}
export function selectionSummary(text: string): string {
  const chars = [...text.replace(/\s+/gu, " ")];
  return chars.length > 16 ? chars.slice(0, 7).join("") + "…" + chars.slice(-7).join("") : chars.join("");
}
