/** 段内的一个句子片段：显示文本，以及它在段落显示文本中的起始偏移 */
interface Piece {
  index: number;
  start: number;
  text: string;
}

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

export function slicePieces(pieces: Piece[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const start = Math.max(p.start, from);
    const end = Math.min(p.start + p.text.length, to);
    if (end > start) out.push({ index: p.index, start, text: p.text.slice(start - p.start, end - p.start) });
  }
  return out;
}

export function paragraphLength(pieces: Piece[]): number {
  const last = pieces[pieces.length - 1];
  return last ? last.start + last.text.length : 0;
}

export function rectOf(node: Text, offset: number): DOMRect | null {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  return range.getClientRects()[0] ?? null;
}

export function measureSplit(body: HTMLElement, paraIndex: number, index: number): number | null {
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

