"use client";

import Link from "next/link";
import FeedbackButton from "@/components/feedback/FeedbackButton";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import Upload from "@/components/Upload";
import Landing from "@/components/landing/Landing";
import { emitAnalytics } from "@/lib/analytics-events";
import { daysSinceOpenBucket, markReaderEntry } from "@/lib/analytics-local";
import { clearGlossCacheForDocument } from "@/lib/cache";
import { loadDocument, loadSavedGlosses, loadReadingPosition, loadShelf, removeShelfDocument, setShelfColor, type ShelfEntry } from "@/lib/storage";
import { segmentParagraphs } from "@/lib/segment";
import { SAMPLE_DOC_ID, SAMPLE_SHELF_ENTRY, isSampleRemoved, removeSampleFromShelf, loadSampleBook } from "@/lib/sample";

import { loadSavedSelections } from "@/lib/selection-storage";
import { comparePoints } from "@/lib/selection";

const BOOK_COLORS = Array.from({ length: 11 }, (_, index) => `var(--shelf-book-${index})`);

function relativeTime(value: number): string {
  const days = Math.max(0, Math.floor((Date.now() - value) / 86_400_000));
  return days === 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
}

function importDate(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 只在站内跳转进阅读页时记一次；书脊和封面共用同一个链接。 */
export function enterFromShelf(entry: ShelfEntry, kind: "continue" | "cover"): void {
  if (entry.docId !== SAMPLE_DOC_ID) {
    emitAnalytics({ event: "shelf_book_click", entry: kind, daysSinceOpenBucket: daysSinceOpenBucket(entry.lastOpenedAt, entry.addedAt) });
  }
  markReaderEntry(entry.docId, "shelf");
}

function computeLastRead(entry: ShelfEntry): string {
  const position = loadReadingPosition(entry.docId);
  if (position === null) return relativeTime(entry.lastOpenedAt);
  const raw = globalThis.localStorage?.getItem(`gloss:doc:${entry.docId}`);
  if (!raw) return relativeTime(entry.lastOpenedAt);
  try {
    const doc = JSON.parse(raw) as { paragraphs: string[]; headings: { paraIndex: number; text: string }[] };
    const sentences = segmentParagraphs(doc.paragraphs).sentences;
    const sentence = sentences[position];
    if (!sentence) return relativeTime(entry.lastOpenedAt);
    const heading = [...doc.headings].reverse().find((item) => item.paraIndex <= sentence.paraIndex)?.text.trim();
    const place = heading || `停在「${Array.from(sentence.text.trim()).slice(0, 12).join("")}${Array.from(sentence.text.trim()).length > 12 ? "…" : ""}」`;
    return `${relativeTime(entry.lastOpenedAt)} · ${place}`;
  } catch {
    return relativeTime(entry.lastOpenedAt);
  }
}

export default function Shelf() {
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [entries, setEntries] = useState<ShelfEntry[]>([]);
  const [hasOwnBooks, setHasOwnBooks] = useState(false);
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [details, setDetails] = useState<{ id: string; count?: number; chars?: number; format?: string } | null>(null);
  const detailCache = useRef(new Map<string, Promise<{ id: string; count?: number; chars?: number; format?: string }>>());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [draggingImport, setDraggingImport] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<number | null>(null);


  const spineRefs = useRef(new Map<string, HTMLAnchorElement>());
  const menuRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const importPanelRef = useRef<HTMLElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  const refresh = () => {
    const next = loadShelf();
    setHasOwnBooks(next.entries.some((entry) => entry.docId !== SAMPLE_DOC_ID));
    const visible = isSampleRemoved() ? next.entries : [...next.entries, SAMPLE_SHELF_ENTRY];
    setEntries(visible);
    setStatus(next.unavailable ? "unavailable" : "ready");
    setPreviewId((current) => visible.some((entry) => entry.docId === current) ? current : null);
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => { setDesktop(media.matches); setPreviewId(null); setMenuId(null); if (previewTimer.current !== null) window.clearTimeout(previewTimer.current); };
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);

  }, []);
  useEffect(() => {
    if (!showImport) return;
    importPanelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeImport();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showImport]);
  useEffect(() => {
    const shelf = shelfRef.current;
    const track = trackRef.current;
    if (!shelf || !track) return;
    const measure = () => {
      const next = track.scrollWidth > shelf.clientWidth + 1;
      setOverflowing((current) => current === next ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shelf);
    observer.observe(track);
    return () => observer.disconnect();
  }, [entries.length, desktop]);
  useEffect(() => {
    const openId = menuId ?? previewId;
    const shelf = shelfRef.current;
    const slot = openId ? shelf?.querySelector<HTMLElement>(`[data-doc-id="${openId}"]`) : null;
    if (!shelf || !slot || !overflowing) return;
    const shelfBox = shelf.getBoundingClientRect();
    const slotBox = slot.getBoundingClientRect();
    const inset = 24;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (slotBox.left < shelfBox.left + inset) shelf.scrollBy({ left: slotBox.left - shelfBox.left - inset, behavior });
    else if (slotBox.right > shelfBox.right - inset) shelf.scrollBy({ left: slotBox.right - shelfBox.right + inset, behavior });
  }, [overflowing, menuId, previewId]);
  const restoreSpineFocus = (docId: string) => {
    const spine = spineRefs.current.get(docId);
    if (!spine) return;
    spine.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!menuId) return;
    const close = () => {
      restoreSpineFocus(menuId);
      setMenuId(null);
    };
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [menuId]);
  useEffect(() => {
    if (!menuId) return;
    const close = () => {
      restoreSpineFocus(menuId);
      setMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuId]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menuId || !menu) return;
    const margin = 8;
    const bounds = menu.getBoundingClientRect();
    const shelf = desktop ? shelfRef.current?.getBoundingClientRect() : undefined;
    const leftEdge = Math.max(margin, (shelf?.left ?? 0) + margin);
    const rightEdge = Math.min(window.innerWidth - margin, (shelf?.right ?? window.innerWidth) - margin);
    const topEdge = Math.max(margin, (shelf?.top ?? 0) + margin);
    const bottomEdge = Math.min(window.innerHeight - margin, (shelf?.bottom ?? window.innerHeight) - margin);
    const gap = 8;
    const left = menuPoint.x + gap + bounds.width <= rightEdge ? menuPoint.x + gap : menuPoint.x - bounds.width - gap;
    const top = menuPoint.y + gap + bounds.height <= bottomEdge ? menuPoint.y + gap : menuPoint.y - bounds.height - gap;
    menu.style.left = `${Math.max(leftEdge, Math.min(left, Math.max(leftEdge, rightEdge - bounds.width)))}px`;
    menu.style.top = `${Math.max(topEdge, Math.min(top, Math.max(topEdge, bottomEdge - bounds.height)))}px`;
  }, [menuId, menuPoint]);

  const displayed = menuId ? null : entries.find((entry) => entry.docId === previewId) ?? null;
  const recent = useMemo(() => [...entries].filter((entry) => entry.docId !== SAMPLE_DOC_ID)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null, [entries]);
  const recentRead = useMemo(() => recent ? computeLastRead(recent) : "", [recent]);
  const displayedRead = useMemo(() => displayed ? computeLastRead(displayed) : "", [displayed]);
  useEffect(() => {
    let cancelled = false;
    if (!desktop || !displayed) { setDetails(null); return; }
    const id = displayed.docId;
    if (!detailCache.current.has(id)) detailCache.current.set(id, (async () => {
      const doc = id === SAMPLE_DOC_ID ? (await loadSampleBook())?.doc : loadDocument(id);
      if (!doc) return { id };
      const sentences = segmentParagraphs(doc.paragraphs).sentences;
      const [saved, selections] = await Promise.all([loadSavedGlosses(id, sentences), loadSavedSelections(id, doc.paragraphs)]);
      const touched = selections.filter(item => sentences.some(sentence => comparePoints({ paraIndex: sentence.paraIndex, offset: sentence.start }, item.end) < 0 && comparePoints({ paraIndex: sentence.paraIndex, offset: sentence.start + sentence.text.length }, item.start) > 0));
      return { id, count: saved.size + touched.length, chars: doc.meta?.charCount, format: doc.meta?.format };
    })().catch(() => ({ id })));
    void detailCache.current.get(id)!.then(value => { if (!cancelled) setDetails(value); });
    return () => { cancelled = true; };
  }, [desktop, displayed?.docId]);
  const cancelPreview = () => { if (previewTimer.current !== null) window.clearTimeout(previewTimer.current); previewTimer.current = null; };
  const openPreview = (docId: string) => {
    cancelPreview();
    previewTimer.current = window.setTimeout(() => { previewTimer.current = null; setPreviewId(docId); }, 120);
  };
  const closeImport = () => {
    setDraggingImport(false);
    setShowImport(false);
    window.setTimeout(() => importRef.current?.focus(), 0);
  };
  const importDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingImport(true);
  };
  const importDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggingImport(false);
  };
  const importDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDraggingImport(false);
    const file = event.dataTransfer.files.item(0);
    if (file) setDroppedFile(file);
  };

  const openBookMenu = (entry: ShelfEntry, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenuPoint({ x: event.clientX, y: event.clientY });
    cancelPreview();
    setPreviewId(entry.docId);
    setMenuId(entry.docId);
  };

  async function remove(entry: ShelfEntry) {
    setConfirmingId(null);
    if (entry.docId === SAMPLE_DOC_ID) {
      if (!removeSampleFromShelf()) return;
    } else {
      if (!removeShelfDocument(entry.docId)) return;
      await clearGlossCacheForDocument(entry.docId);
    }
    detailCache.current.delete(entry.docId);
    setPreviewId((current) => current === entry.docId ? null : current);
    refresh();
    shelfRef.current?.focus();
  }

  const importDialog = showImport && <div className="import-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeImport(); }}><section ref={importPanelRef} className={`import-panel${draggingImport ? " import-panel-dragging" : ""}`} role="dialog" aria-modal="true" aria-labelledby="import-title" tabIndex={-1} onDragOver={importDragOver} onDragLeave={importDragLeave} onDrop={importDrop}><header><h2 id="import-title">导入新书</h2><button type="button" className="import-close" aria-label="关闭导入新书弹窗" onClick={closeImport}>×</button></header><div className="import-drop-hint" aria-hidden="true">松开以上传文件</div><Upload droppedFile={droppedFile} onDroppedFileHandled={() => setDroppedFile(null)} onStorageFull={() => { closeImport(); shelfRef.current?.focus(); }} /><button type="button" className="paste-link" onClick={() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()}>改用粘贴文本</button></section></div>;

  if (status === "loading" || desktop === null) return <main className="shelf-loading" aria-label="正在读取书架" />;
  if (status === "unavailable") return <main className="shelf-unavailable" role="alert">当前浏览器禁止本地存储，无法读取书架。</main>;
  if (!hasOwnBooks) return <><Landing onImport={() => setShowImport(true)} importButtonRef={importRef} />{importDialog}</>;

  return (
    <main className="shelf-page">
      <header className="shelf-heading"><span className="wordmark">GLOSS</span><h1 className="shelf-sr-only">我的书架</h1><div className="shelf-heading-right"><span className="shelf-count">本地书架 {entries.length} 本</span><FeedbackButton placement="shelf" /></div></header>
      {recent && <Link className={desktop ? "continue-reading" : "mobile-current"} href={`/read/${recent.docId}`} onNavigate={() => enterFromShelf(recent, "continue")}><span className="continue-cover cloth" style={bookStyle(recent)} /><span className="continue-copy">{!desktop && <small>正在读</small>}<strong>{desktop ? `接着读《${recent.title}》` : recent.title}</strong><small>{recentRead}</small>{!desktop && <b>接着读 <span aria-hidden="true">→</span></b>}</span>{desktop && <span className="continue-action">继续阅读 <span aria-hidden="true">→</span></span>}</Link>}
      {desktop ? <section className={`shelf${overflowing ? " shelf-overflowing" : ""}`} ref={shelfRef} tabIndex={-1} aria-label="我的书架"><div className="shelf-track" ref={trackRef}>
        {entries.map(entry => {
          const open = previewId === entry.docId;
          const action = loadReadingPosition(entry.docId) !== null ? "接着读" : "开始读";
          return <Link key={entry.docId} ref={node => { if (node) spineRefs.current.set(entry.docId, node); else spineRefs.current.delete(entry.docId); }} data-doc-id={entry.docId} className={`book-slot${open ? " book-slot-open" : ""}`} href={`/read/${entry.docId}`} aria-label={`${action}《${entry.title}》`} style={bookStyle(entry)} onMouseDown={event => { if (event.button === 0) event.preventDefault(); }} onNavigate={() => enterFromShelf(entry, "cover")} onMouseMove={() => { if (!open && !menuId && previewTimer.current === null) openPreview(entry.docId); }} onMouseLeave={cancelPreview} onFocus={() => { cancelPreview(); setPreviewId(entry.docId); }} onContextMenu={event => openBookMenu(entry, event)}>
            {open ? <span className="book-cover cloth"><span className="cover-frame"/><span className="cover-content"><span className="cover-title">{entry.title}</span><svg width="72" height="12" viewBox="0 0 72 12" aria-hidden="true"><path d="M2 6h24M46 6h24M30 6c2-4 6-4 6 0s4 4 6 0c-2-4-6-4-6 0s-4 4-6 0z" fill="none" stroke="currentColor"/></svg><span className="cover-author">{entry.author}</span></span>{entry.docId === SAMPLE_DOC_ID && <span className="cover-sample">示例</span>}<span className="cover-action">{action}</span></span> : <span className="book-spine cloth">{entry.docId === SAMPLE_DOC_ID && <span className="spine-sample">示例</span>}<span className="spine-gold-bottom" aria-hidden="true"/><span className="spine-title">{entry.title}</span></span>}
          </Link>;
        })}
        <button ref={importRef} type="button" className="import-spine" aria-label="导入新书" onClick={() => setShowImport(true)}><b>＋</b><span>导入新书</span><small>DOCX<br/>TXT<br/>PDF</small></button><div className="shelf-ledge"><div className="shelf-ledge-top"/><div className="shelf-ledge-front"/></div>
      </div></section> : <section className="mobile-books" ref={shelfRef} tabIndex={-1}><div className="mobile-list-heading"><span>全部 · {entries.length} 本 · 按最近打开</span><button ref={importRef} onClick={() => setShowImport(true)}>＋ 导入新书</button></div>{[...entries].filter(entry => entry.docId !== recent?.docId).sort((a,b) => a.docId === SAMPLE_DOC_ID ? 1 : b.docId === SAMPLE_DOC_ID ? -1 : b.lastOpenedAt - a.lastOpenedAt).map(entry => <Link key={entry.docId} ref={node => { if (node) spineRefs.current.set(entry.docId,node); else spineRefs.current.delete(entry.docId); }} data-doc-id={entry.docId} className="mobile-book" href={`/read/${entry.docId}`} onNavigate={() => enterFromShelf(entry,"cover")} onContextMenu={event => openBookMenu(entry,event)}><span className="mobile-thumb cloth" style={bookStyle(entry)}/><span className="mobile-book-copy"><strong>{entry.title}</strong><small>{entry.docId === SAMPLE_DOC_ID ? "瞿秋白 · 示例" : `${entry.author ? entry.author + " · " : ""}${entry.lastOpenedAt === entry.addedAt ? `还没打开 · 导入于 ${new Date(entry.addedAt).getMonth()+1} 月 ${new Date(entry.addedAt).getDate()} 日` : relativeTime(entry.lastOpenedAt)}`}</small></span><span className="mobile-arrow" aria-hidden="true">›</span></Link>)}</section>}
      {menuId && entries.find((entry) => entry.docId === menuId) && createPortal(<div ref={menuRef} className="spine-menu" role="menu">{menuId !== SAMPLE_DOC_ID && <><span>换颜色</span><div>{BOOK_COLORS.map((_, index) => <button key={index} aria-label={`书色 ${index + 1}`} type="button" className="color-swatch" style={{ background: BOOK_COLORS[index] }} onClick={() => { setShelfColor(menuId, `book-${index}`); refresh(); setMenuId(null); }} />)}</div></>}<button type="button" onClick={() => { setMenuId(null); setConfirmingId(menuId); }}>从书架移除</button></div>, document.body)}
      {desktop && displayed && <section className="book-detail"><div><h2>{displayed.title}</h2><p>{displayed.docId === SAMPLE_DOC_ID ? "瞿秋白 · 《社会哲学概论》1924 · 示例" : `${displayed.author ? displayed.author + " · " : ""}导入于 ${importDate(displayed.addedAt)}${details?.id === displayed.docId && details.format ? " · " + (details.format === "paste" ? "粘贴" : details.format) : ""}`}</p><dl>{displayed.docId !== SAMPLE_DOC_ID && <div><dt>上次读到</dt><dd>{displayed.lastOpenedAt === displayed.addedAt ? "还没打开过" : displayedRead}</dd></div>}{details?.id === displayed.docId && details.count !== undefined && <div><dt>已存白话</dt><dd>{details.count ? `${details.count} 处` : "还没有"}</dd></div>}{details?.id === displayed.docId && details.chars !== undefined && <div><dt>全文</dt><dd>{details.chars < 10000 ? `${details.chars} 字` : `${(details.chars/10000).toFixed(1)} 万字`}</dd></div>}</dl></div><button className="remove-book" onClick={() => setConfirmingId(displayed.docId)}>从书架移除</button></section>}
      {confirmingId && <section className="remove-confirm" role="dialog" aria-modal="true"><p>确定移除《{entries.find((item) => item.docId === confirmingId)?.title}》吗？{confirmingId === SAMPLE_DOC_ID ? "移除后不再出现在书架上，阅读位置与已存白话会保留。" : "移除后会删除这本书的正文、阅读位置、结构摘要、已存白话、整句理解和自动白话缓存。"}</p><div><button type="button" onClick={() => setConfirmingId(null)}>取消</button><button type="button" onClick={() => { const entry = entries.find((item) => item.docId === confirmingId); if (entry) void remove(entry); }}>确认移除</button></div></section>}
      {importDialog}
    </main>
  );
}


function bookStyle(entry: ShelfEntry): CSSProperties {
  return { "--book-color": BOOK_COLORS[Number(entry.colorId.slice(5))], "--book-width": `${58 + entry.widthSeed % 9}px`, "--book-height": `${372 + entry.widthSeed % 39}px` } as CSSProperties;
}
