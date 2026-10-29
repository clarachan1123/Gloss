

/** 撑开 / 收起动画时长 */
export const ANIMATION_MS = 220;

/** 撑开区为下方内容带来的位移：有它与没它时，上下相邻元素之间距离的差（计入外边距折叠） */
export function panelShift(panel: HTMLElement): number {
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
export function elementsBelow(panel: HTMLElement, shift: number, extraBottom: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  const limit = window.innerHeight + extraBottom;
  for (let el = panel.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.getBoundingClientRect().top - shift > limit) break;
    if (el instanceof HTMLElement) out.push(el);
  }
  return out;
}

/* ---------------- 动画与交互辅助 ---------------- */

export function slide(elements: HTMLElement[], fromY: number, toY: number): void {
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

export function fade(panel: HTMLElement, from: number, to: number): void {
  panel.style.transition = "none";
  panel.style.opacity = String(from);
  void getComputedStyle(panel).opacity;
  panel.style.transition = `opacity ${ANIMATION_MS}ms ease`;
  panel.style.opacity = String(to);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}
