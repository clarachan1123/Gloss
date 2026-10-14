/** 段内的一个句子片段：显示文本，以及它在段落显示文本中的起始偏移 */
interface Piece {
  index: number;
  start: number;
  text: string;
  placeholder?: boolean;
}

/** 段内切片保留续排与上半段身份；普通段落不缩进，标题沿用既有 class 规则。 */
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
 * 在这里拆开，保留上半段原行尾文字（含透明尾巴）；左对齐与字距和可见层一致。
 * D13 由真实字框测量与视口锚定共同维护；句子在最后一行结束时返回 null。
 */
export function measureSplit(body: HTMLElement, paraIndex: number, index: number): number | null {
  const ownInParagraph = Array.from(body.querySelectorAll<HTMLElement>('[data-para="' + paraIndex + '"] .sentence'))
    .filter((span) => span.dataset.index === String(index));
  const block = ownInParagraph.at(-1)?.closest<HTMLElement>("[data-reader-block]");
  const spans = Array.from((block ?? body).querySelectorAll<HTMLElement>(
    block ? ".sentence" : '[data-para="' + paraIndex + '"] .sentence'));
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
  return block?.dataset.blockContinues === "true" ? Number(block.dataset.blockEnd) : null;
}


/** G-59：物理拆点不变，隐藏组内最后一句之后的原行尾，尾巴与其后真实文字由调用方连续续排。
 * pieces 是未拆分的显示文本；part 是本次插入区前的物理片段。
 * 无效边界（例如测试替身落在句中）不移动目标句本身。
 */
export function splitParagraphTail(
  pieces: Piece[], part: Piece[], indexes: readonly number[], splitAt: number | null,
): { head: Piece[]; tail: Piece[] } {
  const index = Math.max(...indexes);
  const sentence = pieces.find((piece) => piece.index === index);
  if (!sentence) return { head: part, tail: [] };
  const start = sentence.start + sentence.text.trimEnd().length;
  const end = splitAt ?? paragraphLength(pieces);
  const tail = slicePieces(pieces, start, end);
  if (!tail.some((piece) => piece.text.trim() !== "")) return { head: part, tail: [] };
  const head = part.flatMap((piece) => {
    const visible = slicePieces([piece], 0, start);
    const hidden = slicePieces([piece], start, end).map((fragment) => ({ ...fragment, placeholder: true }));
    return [...visible, ...hidden];
  });
  return { head, tail };
}
