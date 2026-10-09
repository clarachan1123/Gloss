/** 段内的一个句子片段：显示文本，以及它在段落显示文本中的起始偏移 */
interface Piece {
  index: number;
  start: number;
  text: string;
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

/**
 * 拆分点：被点击句最后一个字所在行的「下一行行首」在段落显示文本中的偏移。
 * 在这里拆开，上半段每一行的字与拆分前完全相同；配合上半段的 text-align-last: justify，
 * 原句所在各行的每个字位置不变（D13，已逐字实测 0px 偏移）。句子在最后一行结束时返回 null。
 */
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

