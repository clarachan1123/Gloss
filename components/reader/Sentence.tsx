export interface SentenceProps {
  /** 全文顺序号（lib/segment.ts 的 index），阅读位置与点击都靠它定位 */
  index: number;
  /** 本片段在段落显示文本中的起始偏移。撑开时句子可能被拆成两个片段，两片 index 相同 */
  offset: number;
  /** 显示文本；段首空白已由 Reader 去掉 */
  text: string;
  /** 只标记随书指定的引导句；真正的动画开关在共同祖先上。 */
  breathe?: boolean;
}

/**
 * 单个句子（或被行尾拆分切开的句子片段）。
 * D13：点击前后不改任何 class / style。hover 变色由 CSS 负责，撑开状态由 GlossPanel 承担。
 */
export default function Sentence({ index, offset, text, breathe = false }: SentenceProps) {
  return (
    <span className={breathe ? "sentence sentence-breathe" : "sentence"} data-index={index} data-offset={offset}>
      {text}
    </span>
  );
}
