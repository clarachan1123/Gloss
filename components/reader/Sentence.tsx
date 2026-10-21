/** 仅保留原字符的排版，不进入句子查询、交互、选择或辅助技术。 */
export function TailPlaceholder({ text }: { text: string }) {
  return <span className="reader-tail-placeholder" aria-hidden="true" inert>{text}</span>;
}

export interface SentenceProps {
  /** 全文顺序号（lib/segment.ts 的 index），阅读位置与点击都靠它定位 */
  index: number;
  /** 本片段在段落显示文本中的起始偏移。撑开时句子可能被拆成两个片段，两片 index 相同 */
  offset: number;
  /** 显示文本；段首空白已由 Reader 去掉 */
  text: string;
  /** 只标记随书指定的引导句；真正的动画开关在共同祖先上。 */
  breathe?: boolean;
  /** 收起状态下已留下且未展开的句子；每个真实片段都标记。 */
  savedCollapsed?: boolean;
  /** G-69：明确非鼠标点开时仅改颜色，测量提交期间也保留。 */
  active?: boolean;
}

/**
 * 单个句子（或被行尾拆分切开的句子片段）。
 * hover 变色由 CSS 负责；留下状态的下划线只作装饰，不改变字符排版。
 */
export default function Sentence({ index, offset, text, breathe = false, savedCollapsed = false, active = false }: SentenceProps) {
  return (
    <span className={`sentence${breathe ? " sentence-breathe" : ""}${savedCollapsed ? " sentence-saved-collapsed" : ""}${active ? " sentence-active" : ""}`} data-index={index} data-offset={offset}>
      {text}
    </span>
  );
}
