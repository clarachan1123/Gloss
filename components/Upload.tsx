"use client";

import { useRef, useState, type ChangeEvent } from "react";
import Notice from "./Notice";
import styles from "./Upload.module.css";
import { parseDocx } from "@/lib/parse/docx";
import { parseTxt, plainTextToDocument } from "@/lib/parse/txt";
import {
  ParseError,
  checkFile,
  checkParsed,
  noticeContent,
  type BlockingCode,
  type NoticeContent,
  type ParsedDocument,
} from "@/lib/parse/validate";

/**
 * 上传 / 粘贴入口。解析全部在浏览器内完成：
 * 不调用 Server Action、不请求任何 API，文件内容不离开本页。
 */
export default function Upload() {
  const [notices, setNotices] = useState<NoticeContent[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  function accept(doc: ParsedDocument) {
    const warnings = checkParsed(doc);
    console.log("[Gloss] 解析结果", doc);
    console.log(doc.text);
    setNotices(warnings.map((code) => noticeContent(code)));
    setSummary(
      `已解析${doc.meta.fileName ? `「${doc.meta.fileName}」` : "粘贴文本"}：` +
        `${doc.meta.charCount} 字 · ${doc.paragraphs.length} 段（纯文本已打印到控制台）`,
    );
  }

  function fail(err: unknown, fallback: BlockingCode) {
    if (err instanceof ParseError) {
      setNotices([noticeContent(err.code, err.charCount)]);
    } else {
      console.error("[Gloss] 解析异常", err);
      setNotices([noticeContent(fallback)]);
    }
    setSummary(null);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    setNotices([]);
    setSummary(null);
    try {
      const format = checkFile(file);
      accept(format === "docx" ? await parseDocx(file) : await parseTxt(file));
    } catch (err) {
      fail(err, "A3");
    } finally {
      setBusy(false);
    }
  }

  function handlePaste() {
    setNotices([]);
    setSummary(null);
    try {
      accept(plainTextToDocument(pasteRef.current?.value ?? "", "paste", null));
    } catch (err) {
      fail(err, "A7");
    }
  }

  function focusPaste() {
    pasteRef.current?.scrollIntoView({ block: "center" });
    pasteRef.current?.focus();
  }

  return (
    <section className={styles.upload} aria-busy={busy}>
      <label className={styles.fileLabel}>
        <span>{busy ? "正在解析…" : "选择文件（.docx / .txt）"}</span>
        <input type="file" className={styles.fileInput} onChange={handleFile} disabled={busy} />
      </label>

      <textarea
        ref={pasteRef}
        className={styles.paste}
        placeholder="或者把正文粘贴到这里"
        rows={6}
      />
      <button type="button" className={styles.button} onClick={handlePaste} disabled={busy}>
        使用粘贴的文本
      </button>

      <div className={styles.notices}>
        {notices.map((n) => (
          <Notice
            key={n.code}
            tone={n.tone}
            message={n.message}
            action={n.offerPaste ? { label: "改用粘贴文本", onClick: focusPaste } : undefined}
          />
        ))}
      </div>

      {summary && <p className={styles.summary}>{summary}</p>}
    </section>
  );
}
