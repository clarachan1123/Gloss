/** 标题也是逻辑段；进度只派生，不新增存储。 */
export function readerProgress(paragraphCount: number, sentences: readonly { paraIndex: number }[], index: number) {
  const total = Math.max(0, Number.isFinite(paragraphCount) ? Math.floor(paragraphCount) : 0);
  if (total === 0 || sentences.length === 0) return null;
  const safeIndex = Math.max(0, Math.min(sentences.length - 1, Number.isFinite(index) ? Math.floor(index) : 0));
  const para = sentences[safeIndex].paraIndex;
  const current = Math.max(1, Math.min(total, Number.isFinite(para) ? Math.floor(para) + 1 : 1));
  return { current, total, ratio: current / total };
}
