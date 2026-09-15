"use client";

import { useRouter } from "next/navigation";
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
import { StorageError, saveDocument, type StorageErrorCode } from "@/lib/storage";

interface UploadNotice {
  key: string;
  tone: "block" | "banner";
  message: string;
  offerPaste: boolean;
}

/** 本 issue 只做阻断提示；导出入口、删除旧文档入口留给后续 issue */
const STORAGE_MESSAGES: Record<StorageErrorCode, string> = {
  E1: "本地存储空间已满，暂时无法打开阅读器。",
  E2: "当前浏览器禁止本地存储，暂时无法打开阅读器。",
};

const fromParseNotice = (n: NoticeContent): UploadNotice => ({
  key: n.code,
  tone: n.tone,
  message: n.message,
  offerPaste: n.offerPaste,
});

/**
 * 上传 / 粘贴入口。解析全部在浏览器内完成：
 * 不调用 Server Action、不请求任何 API，文件内容不离开本页。
 * 解析成功后存入 localStorage：无警告直接进入阅读器；有警告（A9）留在本页，由用户点「开始阅读」。
 */
export default function Upload() {
  const router = useRouter();
  const [notices, setNotices] = useState<UploadNotice[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [readyDocId, setReadyDocId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  function reset() {
    setNotices([]);
    setSummary(null);
    setReadyDocId(null);
  }

  async function accept(doc: ParsedDocument) {
    const warnings = checkParsed(doc);
    console.log("[Gloss] 解析结果", doc);
    console.log(doc.text);
    setSummary(
      `已解析${doc.meta.fileName ? `「${doc.meta.fileName}」` : "粘贴文本"}：` +
        `${doc.meta.charCount} 字 · ${doc.paragraphs.length} 段`,
    );

    let docId: string;
    try {
      docId = await saveDocument(doc);
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      setNotices([{ key: err.code, tone: "block", message: STORAGE_MESSAGES[err.code], offerPaste: false }]);
      return;
    }

    if (warnings.length === 0) {
      router.push(`/read/${docId}`);
      return;
    }
    setNotices(warnings.map((code) => fromParseNotice(noticeContent(code))));
    setReadyDocId(docId);
  }

  function fail(err: unknown, fallback: BlockingCode) {
    if (err instanceof ParseError) {
      setNotices([fromParseNotice(noticeContent(err.code, err.charCount))]);
    } else {
      console.error("[Gloss] 解析异常", err);
      setNotices([fromParseNotice(noticeContent(fallback))]);
    }
    setSummary(null);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    reset();
    try {
      const format = checkFile(file);
      await accept(format === "docx" ? await parseDocx(file) : await parseTxt(file));
    } catch (err) {
      fail(err, "A3");
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste() {
    setBusy(true);
    reset();
    try {
      await accept(plainTextToDocument(pasteRef.current?.value ?? "", "paste", null));
    } catch (err) {
      fail(err, "A7");
    } finally {
      setBusy(false);
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
            key={n.key}
            tone={n.tone}
            message={n.message}
            action={n.offerPaste ? { label: "改用粘贴文本", onClick: focusPaste } : undefined}
          />
        ))}
      </div>

      {summary && <p className={styles.summary}>{summary}</p>}

      {readyDocId && (
        <button type="button" className={styles.button} onClick={() => router.push(`/read/${readyDocId}`)}>
          开始阅读
        </button>
      )}
    </section>
  );
}
