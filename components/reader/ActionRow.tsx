import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StorageErrorCode } from "@/lib/storage";
type ToggleResult = "saved" | "removed" | StorageErrorCode;
export function BookmarkIcon({ saved = false }: { saved?: boolean }) {
  return <svg width="18" height="20" viewBox="0 0 20 22" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 2h12v18l-6-4-6 4Z" /></svg>;
}
const bulbPath = "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z";
const speechPath = "M5 6h14v9H10l-4 3v-3H5z";

function ActionIcon({ path, filled = false }: { path: string; filled?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export default function ActionRow({ saved, disabled, onToggle, onFold, recall, onRecall, generated = false, selectionOnly = false, block = "gloss" }: {
  saved: boolean; disabled: boolean; onToggle: () => Promise<ToggleResult>; onFold?: () => void;
  recall?: string; onRecall?: () => void; generated?: boolean; selectionOnly?: boolean; block?: "gloss" | "explain";
}) {
  const [pending, setPending] = useState(false), [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 3000); return () => window.clearTimeout(timer); }, [notice]);
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const blockElement = row?.parentElement;
    const body = row?.closest<HTMLElement>(".reader-body");
    const main = body?.closest<HTMLElement>(".col-main");
    if (!row || !blockElement || !body || !main) return;

    const update = () => {
      const usableRight = main.getBoundingClientRect().right - 8;
      const bodyRight = body.getBoundingClientRect().right;
      const gap = usableRight - bodyRight;
      // 三格总宽 148px，另留正文外侧 16px。
      const side = gap >= 148 + 16;
      row.dataset.actionPlacement = side ? "side" : "below";
      if (side) {
        const left = blockElement.getBoundingClientRect().left + parseFloat(getComputedStyle(blockElement).borderLeftWidth);
        row.style.setProperty("--action-offset", (bodyRight - left + 16) + "px");
      } else {
        row.style.removeProperty("--action-offset");
      }
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    for (const element of [body, main, blockElement]) observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  async function toggle() {
    if (disabled || pending) return;
    setPending(true);
    try { const result = await onToggle(); if (result === "E1" || result === "E2") setNotice(result === "E1" ? "存储已满，没能收藏，仍可继续阅读。" : "这次没能收藏，仍可继续阅读。"); }
    finally { setPending(false); }
  }
  return <div ref={rowRef} className="action-row" data-block-actions={block} data-action-placement="below">
    {!selectionOnly && <div className="action-row-recall-slot">{recall && <button type="button" className="action-row-explain action-row-recall" data-generated={generated} data-tip={block === "explain" ? "看白话" : generated ? "看脉络解读" : "生成脉络解读"} aria-label={recall} onClick={event => {event.stopPropagation();onRecall?.();}}><ActionIcon path={block === "explain" ? speechPath : bulbPath} /><span className="action-row-recall-label">{recall}</span></button>}</div>}
    <button type="button" className="action-row-save" aria-label={disabled && block === "explain" ? "生成后才能收藏" : saved ? "已收藏" : "收藏"} aria-pressed={saved} aria-disabled={disabled || pending} data-tip={disabled && block === "explain" ? "生成后才能收藏" : saved ? "已收藏" : "收藏"} disabled={disabled || pending} onClick={event=>{event.stopPropagation();void toggle();}}><ActionIcon path="M6 3h12v18l-6-4-6 4z" filled={saved} /></button>
    <button type="button" className="action-row-fold" data-tip="收起" aria-label={block === "explain" ? "收起脉络解读" : "收起白话"} onClick={event=>{event.stopPropagation();onFold?.();}}><ActionIcon path="M6 15l6-6 6 6" /></button>
    {notice && <span className="action-row-notice" role="status">{notice}</span>}
  </div>;
}
