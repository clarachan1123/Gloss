"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FocusEvent } from "react";
import Upload from "@/components/Upload";
import { clearGlossCacheForDocument } from "@/lib/cache";
import { loadReadingPosition, loadShelf, removeShelfDocument, setShelfColor, type ShelfEntry } from "@/lib/storage";
import { segmentParagraphs } from "@/lib/segment";

const BOOK_COLORS = Array.from({ length: 11 }, (_, index) => `var(--shelf-book-${index})`);

function relativeTime(value: number): string {
  const days = Math.max(0, Math.floor((Date.now() - value) / 86_400_000));
  return days === 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
}

function importDate(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function importMonth(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}`;
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
    const place = heading || `停在「${Array.from(sentence.text.trim()).slice(0, 12).join("")}」`;
    return `${relativeTime(entry.lastOpenedAt)} · ${place}`;
  } catch {
    return relativeTime(entry.lastOpenedAt);
  }
}

export default function Shelf() {
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [entries, setEntries] = useState<ShelfEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [draggingImport, setDraggingImport] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<number | null>(null);
  const previewLeaveTimer = useRef<number | null>(null);
  const spineRefs = useRef(new Map<string, HTMLButtonElement>());
  const importRef = useRef<HTMLButtonElement>(null);
  const importPanelRef = useRef<HTMLElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  const refresh = () => {
    const next = loadShelf();
    setEntries(next.entries);
    setStatus(next.unavailable ? "unavailable" : "ready");
    setSelectedId((current) => next.entries.some((entry) => entry.docId === current) ? current : null);
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (previewLeaveTimer.current !== null) window.clearTimeout(previewLeaveTimer.current);
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
  }, [entries.length]);
  useEffect(() => {
    const openId = previewId ?? selectedId;
    const shelf = shelfRef.current;
    const slot = openId ? shelf?.querySelector<HTMLElement>(`[data-doc-id="${openId}"]`) : null;
    if (!shelf || !slot || !overflowing) return;
    const shelfBox = shelf.getBoundingClientRect();
    const slotBox = slot.getBoundingClientRect();
    const inset = 24;
    if (slotBox.left < shelfBox.left + inset) shelf.scrollBy({ left: slotBox.left - shelfBox.left - inset, behavior: "smooth" });
    else if (slotBox.right > shelfBox.right - inset) shelf.scrollBy({ left: slotBox.right - shelfBox.right + inset, behavior: "smooth" });
  }, [overflowing, previewId, selectedId]);
  useEffect(() => {
    const close = () => setMenuId((id) => { if (id) spineRefs.current.get(id)?.focus(); return null; });
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, []);

  const selected = entries.find((entry) => entry.docId === selectedId) ?? null;
  const displayed = entries.find((entry) => entry.docId === detailId) ?? null;
  const recent = useMemo(() => [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null, [entries]);
  const lastReads = useMemo(() => new Map(entries.map((entry) => [entry.docId, computeLastRead(entry)])), [entries]);

  const openPreview = (docId: string) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (previewLeaveTimer.current !== null) window.clearTimeout(previewLeaveTimer.current);
    previewLeaveTimer.current = null;
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      setPreviewId(docId);
      setDetailId(docId);
    }, 120);
  };
  const closePreview = (docId: string) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    if (selectedId === docId) return;
    if (previewLeaveTimer.current !== null) window.clearTimeout(previewLeaveTimer.current);
    previewLeaveTimer.current = window.setTimeout(() => {
      previewLeaveTimer.current = null;
      setPreviewId((current) => current === docId ? null : current);
    }, 150);
  };
  const closeImport = () => {
    setDraggingImport(false);
    setShowImport(false);
    window.setTimeout(() => importRef.current?.focus(), 0);
  };
  const leaveSlot = (docId: string, event: React.MouseEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closePreview(docId);
  };
  const blurSlot = (docId: string, event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closePreview(docId);
  };
  const importDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingImport(true);
  };
  const importDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImport(false);
  };
  const importDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDraggingImport(false);
    const file = event.dataTransfer.files.item(0);
    if (file) setDroppedFile(file);
  };

  async function remove(entry: ShelfEntry) {
    setConfirmingId(null);
    if (!removeShelfDocument(entry.docId)) return;
    await clearGlossCacheForDocument(entry.docId);
    setDetailId((current) => current === entry.docId ? null : current);
    refresh();
    shelfRef.current?.focus();
  }

  if (status === "loading") return <main className="shelf-loading" aria-label="正在读取书架" />;
  if (status === "unavailable") return <main className="shelf-unavailable" role="alert">当前浏览器禁止本地存储，无法读取书架。</main>;

  return (
    <main className="shelf-page" style={{ "--shelf-book": selected ? BOOK_COLORS[Number(selected.colorId.slice(5))] : "transparent" } as CSSProperties}>
      <div className="shelf-frame">
      {entries.length > 0 && <header className="shelf-heading"><span className="shelf-count">本地书架 {entries.length} 本</span></header>}
      {recent && <Link className="continue-reading" href={`/read/${recent.docId}`}><span className="continue-cover" style={{ background: BOOK_COLORS[Number(recent.colorId.slice(5))] }} /><span className="continue-copy"><strong>{recent.title}</strong><small>{lastReads.get(recent.docId)}</small></span><span className="continue-action">继续阅读　→</span></Link>}
      <section className={`${entries.length === 0 ? "shelf empty-shelf" : "shelf"}${overflowing ? " shelf-overflowing" : ""}`} ref={shelfRef} tabIndex={-1} aria-label="我的书架" onKeyDown={(event) => { if (event.key === "Escape") setMenuId((id) => { if (id) spineRefs.current.get(id)?.focus(); return null; }); }} onClick={(event) => { if (event.target === event.currentTarget) setMenuId(null); }}>
        <div className="shelf-track" ref={trackRef}>
        {entries.map((entry) => {
          const color = BOOK_COLORS[Number(entry.colorId.slice(5))];
          const open = (previewId ?? selectedId) === entry.docId;
          return <div className={`book-slot${open ? " book-slot-open" : ""}`} data-doc-id={entry.docId} key={entry.docId} onMouseEnter={() => openPreview(entry.docId)} onMouseLeave={(event) => leaveSlot(entry.docId, event)} onFocus={() => openPreview(entry.docId)} onBlur={(event) => blurSlot(entry.docId, event)}><button ref={(node) => { if (node) spineRefs.current.set(entry.docId, node); else spineRefs.current.delete(entry.docId); }} type="button" className={`book-spine${open ? " selected" : ""}`} style={{ "--book-color": color, "--book-width": `${48 + entry.widthSeed % 5}px`, "--book-height": `${350 + entry.widthSeed % 91}px` } as CSSProperties} onClick={() => { setSelectedId(entry.docId); setPreviewId(null); setDetailId(entry.docId); setMenuId(null); }} onContextMenu={(event) => { event.preventDefault(); setSelectedId(entry.docId); setPreviewId(null); setDetailId(entry.docId); setMenuId(entry.docId); }}><span className="spine-added-at">{importMonth(entry.addedAt)}</span><span className="spine-title">{entry.title}</span></button>{open && <Link className="book-cover" href={`/read/${entry.docId}`} style={{ "--book-color": color } as CSSProperties}><i /><h2>{entry.title}</h2>{entry.author && <p>{entry.author}</p>}<i /><span aria-hidden="true">开始读</span></Link>}{menuId === entry.docId && <div className="spine-menu" role="menu"><span>换颜色</span><div>{BOOK_COLORS.map((_, index) => <button key={index} aria-label={`书色 ${index + 1}`} type="button" className="color-swatch" style={{ background: BOOK_COLORS[index] }} onClick={() => { setShelfColor(entry.docId, `book-${index}`); refresh(); setMenuId(null); }} />)}</div><button type="button" onClick={() => { setMenuId(null); setConfirmingId(entry.docId); }}>从书架移除</button></div>}</div>;
        })}
        <button ref={importRef} type="button" className="import-spine" onClick={() => setShowImport(true)}><span>导入新书</span></button>
        <div className="shelf-ledge" />
        </div>
      </section>
      {entries.length === 0 && <p className="empty-help">拖入或点击上传 · 支持 .docx .txt .pdf</p>}
      {displayed && <section className="book-detail"><div><h2>{displayed.title}</h2>{displayed.author && <p>{displayed.author}</p>}</div><div className="detail-actions"><Link className="read-button" href={`/read/${displayed.docId}`}>开始读</Link><button type="button" className="remove-book" onClick={() => setConfirmingId(displayed.docId)}>从书架移除</button></div><dl>{savedCount(displayed.docId) > 0 && <div><dt>已存白话</dt><dd>{savedCount(displayed.docId)} 处</dd></div>}{lastReads.get(displayed.docId) && <div><dt>上次读到</dt><dd>{lastReads.get(displayed.docId)}</dd></div>}<div><dt>导入日期</dt><dd>{importDate(displayed.addedAt)}</dd></div></dl></section>}
      {confirmingId && <section className="remove-confirm" role="dialog" aria-modal="true"><p>移除后会删除这本书的正文、阅读位置、结构摘要、已存白话、整句理解和自动白话缓存。</p><div><button type="button" onClick={() => setConfirmingId(null)}>取消</button><button type="button" onClick={() => { const entry = entries.find((item) => item.docId === confirmingId); if (entry) void remove(entry); }}>确认移除</button></div></section>}
      {showImport && <div className="import-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeImport(); }}><section ref={importPanelRef} className={`import-panel${draggingImport ? " import-panel-dragging" : ""}`} role="dialog" aria-modal="true" aria-labelledby="import-title" tabIndex={-1} onDragOver={importDragOver} onDragLeave={importDragLeave} onDrop={importDrop}><header><h2 id="import-title">导入新书</h2><button type="button" className="import-close" aria-label="关闭导入新书弹窗" onClick={closeImport}>×</button></header><div className="import-drop-hint" aria-hidden="true">松开以上传文件</div><Upload droppedFile={droppedFile} onDroppedFileHandled={() => setDroppedFile(null)} onStorageFull={() => { closeImport(); shelfRef.current?.focus(); }} /><button type="button" className="paste-link" onClick={() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()}>改用粘贴文本</button></section></div>}
      </div>
    </main>
  );
}

function savedCount(docId: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(`gloss:saved:${docId}`);
    const record = raw ? JSON.parse(raw) as { entries?: unknown[] } : null;
    return Array.isArray(record?.entries) ? record.entries.length : 0;
  } catch { return 0; }
}
