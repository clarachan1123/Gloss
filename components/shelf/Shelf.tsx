"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Upload from "@/components/Upload";
import { clearGlossCacheForDocument } from "@/lib/cache";
import { loadReadingPosition, loadShelf, removeShelfDocument, setShelfColor, type ShelfEntry } from "@/lib/storage";
import { segmentParagraphs } from "@/lib/segment";

const BOOK_COLORS = Array.from({ length: 11 }, (_, index) => `var(--shelf-book-${index})`);

function relativeTime(value: number): string {
  const days = Math.max(0, Math.floor((Date.now() - value) / 86_400_000));
  return days === 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
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
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<number | null>(null);
  const spineRefs = useRef(new Map<string, HTMLButtonElement>());
  const [overflowing, setOverflowing] = useState(false);

  const refresh = () => {
    const next = loadShelf();
    setEntries(next.entries);
    setStatus(next.unavailable ? "unavailable" : "ready");
    setSelectedId((current) => next.entries.some((entry) => entry.docId === current) ? current : null);
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => () => { if (previewTimer.current !== null) window.clearTimeout(previewTimer.current); }, []);
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
    const close = () => setMenuId((id) => { if (id) spineRefs.current.get(id)?.focus(); return null; });
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, []);

  const selected = entries.find((entry) => entry.docId === selectedId) ?? null;
  const recent = useMemo(() => [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null, [entries]);
  const lastReads = useMemo(() => new Map(entries.map((entry) => [entry.docId, computeLastRead(entry)])), [entries]);

  const openPreview = (docId: string) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => setPreviewId(docId), 120);
  };
  const closePreview = (docId: string) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    if (selectedId !== docId) setPreviewId((current) => current === docId ? null : current);
  };

  async function remove(entry: ShelfEntry) {
    setConfirmingId(null);
    if (!removeShelfDocument(entry.docId)) return;
    await clearGlossCacheForDocument(entry.docId);
    refresh();
    shelfRef.current?.focus();
  }

  if (status === "loading") return <main className="shelf-loading" aria-label="正在读取书架" />;
  if (status === "unavailable") return <main className="shelf-unavailable" role="alert">当前浏览器禁止本地存储，无法读取书架。</main>;

  return (
    <main className="shelf-page" style={{ "--shelf-book": selected ? BOOK_COLORS[Number(selected.colorId.slice(5))] : "transparent" } as CSSProperties}>
      <div className="shelf-frame">
      <header className="shelf-heading"><span className="wordmark">Gloss</span><h1>我的书架</h1>{entries.length > 0 && <p>{entries.length} 本书。点开任意一本，接着上次的地方读。</p>}</header>
      {recent && <Link className="continue-reading" href={`/read/${recent.docId}`}><span className="continue-cover" style={{ background: BOOK_COLORS[Number(recent.colorId.slice(5))] }} /><span className="continue-copy"><strong>{recent.title}</strong><small>{lastReads.get(recent.docId)}</small></span><span className="continue-action">继续阅读　→</span></Link>}
      <section className={`${entries.length === 0 ? "shelf empty-shelf" : "shelf"}${overflowing ? " shelf-overflowing" : ""}`} ref={shelfRef} tabIndex={-1} aria-label="我的书架" onKeyDown={(event) => { if (event.key === "Escape") setMenuId((id) => { if (id) spineRefs.current.get(id)?.focus(); return null; }); }} onClick={(event) => { if (event.target === event.currentTarget) setMenuId(null); }}>
        <div className="shelf-track" ref={trackRef}>
        {entries.map((entry) => {
          const color = BOOK_COLORS[Number(entry.colorId.slice(5))];
          const open = selectedId === entry.docId || previewId === entry.docId;
          return <div className="book-slot" key={entry.docId}><button ref={(node) => { if (node) spineRefs.current.set(entry.docId, node); else spineRefs.current.delete(entry.docId); }} type="button" className={`book-spine${open ? " selected" : ""}`} style={{ "--book-color": color, "--book-width": `${48 + entry.widthSeed % 5}px`, "--book-height": `${350 + entry.widthSeed % 91}px` } as CSSProperties} onMouseEnter={() => openPreview(entry.docId)} onMouseLeave={() => closePreview(entry.docId)} onFocus={() => openPreview(entry.docId)} onBlur={() => closePreview(entry.docId)} onClick={() => { setSelectedId(entry.docId); setPreviewId(entry.docId); setMenuId(null); }} onContextMenu={(event) => { event.preventDefault(); setSelectedId(entry.docId); setPreviewId(entry.docId); setMenuId(entry.docId); }}><span>{entry.title}</span></button>{open && <article className="book-cover" style={{ "--book-color": color } as CSSProperties}><i /><h2>{entry.title}</h2>{entry.author && <p>{entry.author}</p>}<i /><Link href={`/read/${entry.docId}`}>开始读</Link></article>}{menuId === entry.docId && <div className="spine-menu" role="menu"><span>换颜色</span><div>{BOOK_COLORS.map((_, index) => <button key={index} aria-label={`书色 ${index + 1}`} type="button" className="color-swatch" style={{ background: BOOK_COLORS[index] }} onClick={() => { setShelfColor(entry.docId, `book-${index}`); refresh(); setMenuId(null); }} />)}</div><button type="button" onClick={() => { setMenuId(null); setConfirmingId(entry.docId); }}>从书架移除</button></div>}</div>;
        })}
        <button type="button" className="import-spine" onClick={() => setShowImport(true)}><span>导入新书</span></button>
        <div className="shelf-ledge" />
        </div>
      </section>
      {entries.length === 0 && <p className="empty-help">拖入或点击上传 · 支持 .docx .txt .pdf</p>}
      {selected && <section className="book-detail"><div><h2>{selected.title}</h2>{selected.author && <p>{selected.author}</p>}</div><div className="detail-actions"><Link className="read-button" href={`/read/${selected.docId}`}>开始读</Link><button type="button" className="remove-book" onClick={() => setConfirmingId(selected.docId)}>从书架移除</button></div><dl>{savedCount(selected.docId) > 0 && <div><dt>已存白话</dt><dd>{savedCount(selected.docId)} 处</dd></div>}<div><dt>上次读到</dt><dd>{lastReads.get(selected.docId)}</dd></div></dl></section>}
      {confirmingId && <section className="remove-confirm" role="dialog" aria-modal="true"><p>移除后会删除这本书的正文、阅读位置、结构摘要、已存白话、整句理解和自动白话缓存。</p><div><button type="button" onClick={() => setConfirmingId(null)}>取消</button><button type="button" onClick={() => { const entry = entries.find((item) => item.docId === confirmingId); if (entry) void remove(entry); }}>确认移除</button></div></section>}
      {showImport && <section className="import-panel" aria-label="导入新书"><button type="button" onClick={() => setShowImport(false)}>关闭</button><Upload onStorageFull={() => { setShowImport(false); shelfRef.current?.focus(); }} /><button type="button" className="paste-link" onClick={() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()}>改用粘贴文本</button></section>}
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
