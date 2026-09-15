export interface SentenceProps {
  /** 全文顺序号（lib/segment.ts 的 index），阅读位置与后续点击都靠它定位 */
  index: number;
  /** 显示文本；段首空白已由 Reader 去掉 */
  text: string;
}

/** 单个句子。本 issue 只负责渲染，点击撑开在 G-05 */
export default function Sentence({ index, text }: SentenceProps) {
  return (
    <span className="sentence" data-index={index}>
      {text}
    </span>
  );
}
