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

function lastRead(entry: ShelfEntry): string {
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
  const shelfRef = useRef<HTMLElement>(null);

  const refresh = () => {
    const next = loadShelf();
    setEntries(next.entries);
    setStatus(next.unavailable ? "unavailable" : "ready");
    setSelectedId((current) => next.entries.some((entry) => entry.docId === current) ? current : null);
  };

  useEffect(() => { refresh(); }, []);

  const selected = entries.find((entry) => entry.docId === selectedId) ?? null;
  const recent = useMemo(() => [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null, [entries]);

  async function remove(entry: ShelfEntry) {
    if (!window.confirm(`确定从书架移除《${entry.title}》吗？这会删除本机保存的正文、阅读位置和白话。`)) return;
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
      {recent && <Link className="continue-reading" href={`/read/${recent.docId}`}><span className="continue-cover" style={{ background: BOOK_COLORS[Number(recent.colorId.slice(5))] }} /><span className="continue-copy"><strong>{recent.title}</strong><small>{lastRead(recent)}</small></span><span className="continue-action">继续阅读　→</span></Link>}
      <section className={entries.length === 0 ? "shelf empty-shelf" : "shelf"} ref={shelfRef} tabIndex={-1} aria-label="我的书架">
        {entries.map((entry) => {
          const color = BOOK_COLORS[Number(entry.colorId.slice(5))];
          const selectedBook = entry.docId === selectedId;
          return <div className="book-slot" key={entry.docId}><button type="button" className={`book-spine${selectedBook ? " selected" : ""}`} style={{ "--book-color": color, "--book-width": `${48 + entry.widthSeed % 5}px`, "--book-height": `${350 + entry.widthSeed % 91}px` } as CSSProperties} onClick={() => { setSelectedId(entry.docId); setMenuId(null); }} onContextMenu={(event) => { event.preventDefault(); setSelectedId(entry.docId); setMenuId(entry.docId); }}><span>{entry.title}</span></button>{menuId === entry.docId && <div className="spine-menu" role="menu"><span>换颜色</span><div>{BOOK_COLORS.map((_, index) => <button key={index} aria-label={`书色 ${index + 1}`} type="button" className="color-swatch" style={{ background: BOOK_COLORS[index] }} onClick={() => { setShelfColor(entry.docId, `book-${index}`); refresh(); setMenuId(null); }} />)}</div><button type="button" onClick={() => { setMenuId(null); void remove(entry); }}>从书架移除</button></div>}</div>;
        })}
        <button type="button" className="import-spine" onClick={() => setShowImport(true)}><span>导入新书</span></button>
        <div className="shelf-ledge" />
      </section>
      {entries.length === 0 && <p className="empty-help">拖入或点击上传 · 支持 .docx .txt .pdf</p>}
      {selected && <section className="book-detail"><h2>{selected.title}</h2>{selected.author && <p>著者：{selected.author}</p>}<p>已存白话：{savedCount(selected.docId)} 处</p><p>上次读到：{lastRead(selected)}</p><Link className="read-button" href={`/read/${selected.docId}`}>开始读</Link><button type="button" className="remove-book" onClick={() => void remove(selected)}>从书架移除</button></section>}
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
