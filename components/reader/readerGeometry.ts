import { rectOf } from "./lineSplit";
import type { CharAnchor, PositionAnchor } from "./readerTypes";

/** 句首离视口顶端在这个距离内，就算「已到顶」（吸收滚动后的亚像素误差） */
export const TOP_TOLERANCE_PX = 2;

/** G6：自动微调滚动时，句首与撑开区底边离视口边缘至少留出的距离 */
export const VISIBLE_MARGIN_PX = 16;

/** 实际锚定与单元测试共用：补偿后参照字的可见位移应为 0。 */
export function anchorScrollDelta(previousViewportTop: number, nextViewportTop: number): number {
  return nextViewportTop - previousViewportTop;
}

/** 功能一与功能二共用：整块面板离开视口上方后才补偿正文字符锚点。 */
export function shouldAnchorPanelGrowth(panelBottom: number): boolean {
  return panelBottom <= 0;
}

export function allObservedTargetsOutside(visibility: Iterable<boolean | null>): boolean {
  const values = [...visibility];
  return values.length > 0 && values.every((visible) => visible === false);
}

export function panelGrowthAnchor(body: HTMLElement, panel: HTMLElement): CharAnchor | null {
  return shouldAnchorPanelGrowth(panel.getBoundingClientRect().bottom) ? anchorAtViewportTop(body) : null;
}

export function restoreTypographyAnchor(body: HTMLElement, anchor: CharAnchor): void {
  // Flush the document scroll range before measuring, and finish both scroll and residual translation before paint.
  void document.scrollingElement?.scrollHeight;
  if (charTop(body, anchor.paraIndex, anchor.offset) === anchor.viewportTop) return;
  restorePanelAnchor(body, anchor);
  void document.scrollingElement?.scrollHeight;
  if (charTop(body, anchor.paraIndex, anchor.offset) !== anchor.viewportTop) restorePanelAnchor(body, anchor);
}

export function restoreCharAnchor(body: HTMLElement, anchor: CharAnchor): number | null {
  body.style.translate = "";
  const top = charTop(body, anchor.paraIndex, anchor.offset);
  if (top === null) return null;
  const delta = anchorScrollDelta(anchor.viewportTop, top);
  const targetScrollY = window.scrollY + delta;
  if (delta !== 0) window.scrollTo({ top: Math.max(0, targetScrollY), behavior: "instant" });
  return targetScrollY;
}

export function restorePanelAnchor(body: HTMLElement, anchor: CharAnchor): void {
  const targetScrollY = restoreCharAnchor(body, anchor);
  const top = charTop(body, anchor.paraIndex, anchor.offset);
  // At the top boundary preserve the signed deficit; translation only corrects subpixel rounding elsewhere.
  if (top !== null) body.style.translate = `0 ${targetScrollY !== null && targetScrollY < 0 ? 0 : (anchor.viewportTop - top) % 1}px`;
}

/* ---------------- 几何测量 ---------------- */


/** 行内句子的首行顶边（相对视口） */
export function firstLineTop(el: HTMLElement): number {
  return (el.getClientRects()[0] ?? el.getBoundingClientRect()).top;
}

export function sentenceTop(body: HTMLElement, index: number): number {
  const el = body.querySelector<HTMLElement>(`.sentence[data-index="${index}"]`);
  return el ? firstLineTop(el) : 0;
}

export function layoutKey(body: HTMLElement): string {
  return `${body.clientWidth}x${body.scrollHeight}`;
}

/** 仅正文横向/字体度量变化会令已存 splitAt 失效；面板流式增高只会改 scrollHeight。 */
export function layoutMeasureKey(body: HTMLElement): string {
  const style = getComputedStyle(body);
  return `${body.clientWidth}:${style.fontFamily}:${style.fontSize}:${style.lineHeight}:${style.letterSpacing}`;
}

/** 把指定句子的首行滚到视口顶端；第 0 句回到页面顶部 */
export function scrollToSentence(body: HTMLElement, index: number): void {
  const target = index > 0 ? body.querySelector<HTMLElement>(`.sentence[data-index="${index}"]`) : null;
  const top = target ? firstLineTop(target) + window.scrollY - mobileReaderTop() : 0;
  if (Math.abs(top - window.scrollY) > 1) window.scrollTo({ top, behavior: "instant" });
}

/**
 * 视口顶部所在的句子：句首已到达视口顶端（或更上方）的最后一句。
 * 不用「底边仍在视口内的第一句」——句子是行内元素，前一句的末行常与后一句的首行同行，
 * 那样每次刷新都会往回退一句。句首位置随文档顺序单调不减，用二分查找。
 */
export function topSentenceIndex(body: HTMLElement): number {
  const spans = body.querySelectorAll<HTMLElement>(".sentence[data-index]");
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (firstLineTop(spans[mid]) <= mobileReaderTop() + TOP_TOLERANCE_PX) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? 0 : Number(spans[found].dataset.index);
}

/** Complete the layout compensation before another observer can reuse the old baseline. */
export function rememberPositionAnchor(body: HTMLElement, position: PositionAnchor): void {
  rememberTopSentence(body, position);
  position.layout = layoutKey(body);
  position.measure = layoutMeasureKey(body);
}

export function rememberTopSentence(body: HTMLElement, position: PositionAnchor): void {
  position.index = topSentenceIndex(body);
  position.offset = sentenceTop(body, position.index);
  position.docTop = position.offset + window.scrollY;
}

/** 段内第 offset 个字的视口纵坐标（段落可能已被拆成上下两半，按 data-para 一并查找） */
export function charTop(body: HTMLElement, paraIndex: number, offset: number): number | null {
  for (const span of body.querySelectorAll<HTMLElement>(`[data-para="${paraIndex}"] .sentence`)) {
    const start = Number(span.dataset.offset);
    const node = span.firstChild;
    if (!(node instanceof Text) || offset < start || offset >= start + node.length) continue;
    return rectOf(node, offset - start)?.top ?? null;
  }
  return null;
}

export type CaretPoint = { node: Node; offset: number };

export function caretFromPoint(x: number, y: number): CaretPoint | null {
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
export function anchorInSpan(span: HTMLElement, preferred: number, y: number): CharAnchor | null {
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
export function anchorAtClick(target: HTMLElement, x: number, y: number): CharAnchor | null {
  const caret = caretFromPoint(x, y);
  const preferred = caret && caret.node === target.firstChild ? caret.offset : 0;
  return anchorInSpan(target, preferred, y);
}

/**
 * 默认视口参照物：视口顶端第一个完整可见的字。撑开区内没有 .sentence，所以它永远不会被选作参照物。
 * 不用坐标反查（caretFromPoint）：参考点落在行距、段间距或撑开区外边距里时会取不到字，锚定就静默失效了。
 * 按文档顺序扫描有可见字框的片段，同行跨句时仍选最早的真实字；手势开始时只选择一次。
 */
export function mobileReaderTop(): number {
  return window.innerWidth < 768 ? document.querySelector(".col-left")?.getBoundingClientRect().bottom ?? 0 : 0;
}
export function anchorAtViewportTop(body: HTMLElement, exclude?: (paraIndex: number, offset: number) => boolean): CharAnchor | null {
  const viewport = window.visualViewport;
  const visibleTop = Math.max(viewport?.offsetTop ?? 0, mobileReaderTop());
  const sheet = document.querySelector<HTMLElement>(".reader-typography-sheet");
  const floating = document.querySelector<HTMLElement>('.reader-typography-floating-aa[data-visible="true"]');
  const visibleBottom = Math.min(visibleTop + (viewport?.height ?? window.innerHeight), sheet?.getBoundingClientRect().top ?? Infinity,
    floating?.getBoundingClientRect().top ?? Infinity);
  const popover = document.querySelector<HTMLElement>(".reader-typography-popover")?.getBoundingClientRect();
  const spans = body.querySelectorAll<HTMLElement>(".sentence");
  for (const span of spans) {
    const bounds = span.getBoundingClientRect();
    if (bounds.bottom <= visibleTop) continue;
    if (bounds.top >= visibleBottom) break;
    const node = span.firstChild;
    const container = span.closest<HTMLElement>("[data-para]");
    if (!(node instanceof Text) || !container) continue;
    for (let c = 0; c < node.length; c++) {
      if (exclude?.(Number(container.dataset.para), Number(span.dataset.offset) + c)) continue;
      const rect = rectOf(node, c);
      if (rect && rect.top >= visibleTop && rect.bottom <= visibleBottom && node.data[c].trim() &&
        (!popover || Math.min(rect.right, popover.right) <= Math.max(rect.left, popover.left) || Math.min(rect.bottom, popover.bottom) <= Math.max(rect.top, popover.top))) {
        return { paraIndex: Number(container.dataset.para), offset: Number(span.dataset.offset) + c, viewportTop: rect.top };
      }
    }
  }
  return null;
}

export function visibilityAdjustment(body: HTMLElement, index: number, panel: HTMLElement): number {
  const first = body.querySelector<HTMLElement>(`.sentence[data-index="${index}"]`);
  if (!first) return 0;
  const top = firstLineTop(first);
  const bottom = panel.getBoundingClientRect().bottom;
  const viewportBottom = window.innerHeight - VISIBLE_MARGIN_PX;
  const viewportTop = Math.max(VISIBLE_MARGIN_PX, mobileReaderTop());
  if (top < viewportTop) return top - viewportTop;
  if (bottom > viewportBottom) return Math.min(bottom - viewportBottom, top - viewportTop);
  return 0;
}

/** Touching an edge has no visible area; fractional positive intersections count. */
export function rectIntersectsViewport(rect: { left: number; right: number; top: number; bottom: number },
  viewport: { left: number; top: number; width: number; height: number }): boolean {
  return Math.min(rect.right, viewport.left + viewport.width) > Math.max(rect.left, viewport.left) &&
    Math.min(rect.bottom, viewport.top + viewport.height) > Math.max(rect.top, viewport.top);
}
