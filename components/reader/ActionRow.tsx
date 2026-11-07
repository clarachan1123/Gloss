import { useEffect, useState } from "react";
import type { StorageErrorCode } from "@/lib/storage";
type ToggleResult = "saved" | "removed" | StorageErrorCode;
export function BookmarkIcon({ saved = false }: { saved?: boolean }) {
  return <svg width="18" height="20" viewBox="0 0 20 22" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 2h12v18l-6-4-6 4Z" /></svg>;
}
export default function ActionRow({ saved, disabled, onToggle, onFold, recall, onRecall, generated = false, selectionOnly = false, block = "gloss" }: {
  saved: boolean; disabled: boolean; onToggle: () => Promise<ToggleResult>; onFold?: () => void;
  recall?: string; onRecall?: () => void; generated?: boolean; selectionOnly?: boolean; block?: "gloss" | "explain";
}) {
  const [pending, setPending] = useState(false), [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 3000); return () => window.clearTimeout(timer); }, [notice]);
  async function toggle() {
    setPending(true);
    try { const result = await onToggle(); if (result === "E1" || result === "E2") setNotice(result === "E1" ? "存储已满，没能收藏，仍可继续阅读。" : "这次没能收藏，仍可继续阅读。"); }
    finally { setPending(false); }
  }
  return <div className="action-row" data-block-actions={block}>
    {!selectionOnly && <div className="action-row-recall-slot">{recall && <button type="button" className="action-row-explain action-row-recall" data-generated={generated} aria-label={recall} onClick={event => {event.stopPropagation();onRecall?.();}}><span aria-hidden="true">↶</span><span className="action-row-recall-label">{recall}</span></button>}</div>}
    <button type="button" className="action-row-save" aria-label={saved ? "取消收藏" : "收藏"} aria-pressed={saved} disabled={disabled || pending} onClick={event=>{event.stopPropagation();void toggle();}}><BookmarkIcon saved={saved} /></button>
    <button type="button" className="action-row-fold" aria-label={block === "explain" ? "收起脉络解读" : "收起白话"} onClick={event=>{event.stopPropagation();onFold?.();}}><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button>
    {notice && <span className="action-row-notice" role="status">{notice}</span>}
  </div>;
}
