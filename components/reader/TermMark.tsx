/**
 * 承重概念的标记（G-08，PRD 3.6 F5 第三类）。
 *
 * 只做一件事：把词染成灰蓝色（`--term`），整词不折行。
 * 不加底色、不加下划线、不加图标、不加提示文字——PRD 3.7 明确禁止「为什么不翻」的说明，
 * 而底色块在逐字吐字的过程中会把注意力从正在读的句子上拽走（2026-09-18 决定）。
 *
 * 术语的存在同时是功能二「听不懂」的显示条件（PRD F8），那部分在 G-11，这里只负责显示。
 */
export default function TermMark({ children }: { children: string }) {
  return <span className="gloss-term">{children}</span>;
}
