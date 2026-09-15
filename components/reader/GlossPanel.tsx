import type { Ref } from "react";

/**
 * 撑开区。插在被点击句所在的「行尾」之后，占据布局空间、推动下文（D9）。
 * 本 issue 不接 AI，只放固定占位文本；白话流式填充在 G-07。
 * PRD 3.10：不加框、不加底色，仅一条左竖线；白话与正文同字号，仅颜色浅一档。
 */
export default function GlossPanel({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="gloss-panel" role="region" aria-label="白话">
      <p className="gloss-panel-text">这里将显示这句话的大白话改写。（占位文本，接入 AI 后替换）</p>
    </div>
  );
}
