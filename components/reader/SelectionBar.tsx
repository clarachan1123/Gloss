import { MAX_SELECTION_CHARS, selectionSummary, type SourceSelection } from "@/lib/selection";
export default function SelectionBar({ mobile, started, selection, onReselect, onConfirm, onExit }: {
  mobile: boolean; started: boolean; selection: SourceSelection | null;
  onReselect: () => void; onConfirm: () => void; onExit: () => void;
}) {
  const tooLong = !!selection && selection.chars > MAX_SELECTION_CHARS;
  const message = tooLong ? "选得太长了，请缩短到 1000 字以内" : selection ? "已选『" + selectionSummary(selection.text) + "』"
    : mobile ? started ? "再点终点" : "划选中：先点起点，再点终点" : "划选中：按住鼠标拖过要问的文字";
  return <div className="reader-selection-bar" data-reader-settings role="region" aria-label="划选操作"
    data-selection-kind={selection?.kind} data-selection-chars={selection?.chars}>
    <span className="reader-selection-message" role="status">{message}</span>
    <div className="reader-selection-actions">{selection && <>
      <button type="button" onClick={onReselect}>重选</button>
      <button type="button" disabled={tooLong} onClick={onConfirm}>确定</button>
    </>}<button type="button" data-selection-control onClick={onExit}>退出</button></div>
  </div>;
}
