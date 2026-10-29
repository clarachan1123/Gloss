import type { SourceSelection } from "@/lib/selection";


/** 只在真实原文 Text 内建立 Range，所有偏移都还原为原始 UTF-16 坐标。 */
export function sourceSelectionRanges(body: HTMLElement, paragraphs: readonly string[], selection: Pick<SourceSelection,"start"|"end">): Range[] {
  const ranges: Range[] = [];
  for (const span of body.querySelectorAll<HTMLElement>(".sentence[data-offset]")) {
    const node=span.firstChild, block=span.closest<HTMLElement>("[data-para]");
    if(!(node instanceof Text)||!block)continue;
    const para=Number(block.dataset.para);
    if(para<selection.start.paraIndex||para>selection.end.paraIndex)continue;
    const text=paragraphs[para]??"",hidden=text.length-text.trimStart().length,base=Number(span.dataset.offset)+hidden;
    const from=Math.max(0,para===selection.start.paraIndex?selection.start.offset-base:0);
    const to=Math.min(node.length,para===selection.end.paraIndex?selection.end.offset-base:node.length);
    if(to<=from)continue;const range=document.createRange();range.setStart(node,from);range.setEnd(node,to);ranges.push(range);
  }
  return ranges;
}
