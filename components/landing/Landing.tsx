"use client";

import Link from "next/link";
import { useEffect, useState, type RefObject } from "react";
import { emitAnalytics } from "@/lib/analytics-events";
import { enqueueAnalytics, markReaderEntry } from "@/lib/analytics-local";
import { SAMPLE_DOC_ID, SAMPLE_SOURCE } from "@/lib/sample";
import LandingDemo from "./LandingDemo";

const COPY = {
  title: "哪句不懂，点哪句。",
  subtitle: "Gloss 把难句改写成大白话，就地展开在原句下面，看完接着往下读。",
  supplement: "你的书、读到哪、留下的白话，都存在这个浏览器里，下次打开接着读。",
  sampleButton: "读一段示例",
  importButton: "导入自己的书",
  importNote: "支持 docx、txt、文字版 PDF，也可以直接粘贴。",
  replayButton: "再看一遍",
} as const;

// Strict Mode 会重放 effect；离开首页后的下一个任务才结束这次显示。
let landingViewActive = false;
let leaveTimer: number | null = null;

export default function Landing({ onImport, importButtonRef }: {
  onImport: () => void;
  importButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [replayIndex, setReplayIndex] = useState(0);
  useEffect(() => {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    if (!landingViewActive) {
      landingViewActive = true;
      enqueueAnalytics({ event: "landing_view" });
    }
    return () => {
      leaveTimer = window.setTimeout(() => {
        landingViewActive = false;
        leaveTimer = null;
      }, 0);
    };
  }, []);

  return (
    <main className="landing-page">
      <div className="landing-content">
        <header className="landing-header">
          <span className="wordmark">Gloss</span>
          <h1>{COPY.title}</h1>
          <p className="landing-subtitle">{COPY.subtitle}</p>
        </header>
        <div className="landing-actions">
          <Link href="/read/sample" className="landing-primary" onClick={() => emitAnalytics({ event: "landing_cta_click", target: "sample" })} onNavigate={() => markReaderEntry(SAMPLE_DOC_ID, "landing")}>{COPY.sampleButton}</Link>
          <div className="landing-secondary-group">
            <button ref={importButtonRef} type="button" className="landing-secondary" onClick={() => { emitAnalytics({ event: "landing_cta_click", target: "import" }); onImport(); }}>{COPY.importButton}</button>
            <small>{COPY.importNote}</small>
          </div>
        </div>
        <section className="landing-demonstration" aria-label="点击句子查看白话的演示">
          <LandingDemo replayIndex={replayIndex} />
          <div className="landing-demo-footer">
            <small>{SAMPLE_SOURCE}</small>
            <button type="button" onClick={() => setReplayIndex((index) => index + 1)}>{COPY.replayButton}</button>
          </div>
        </section>
        <p className="landing-supplement">{COPY.supplement}</p>
      </div>
    </main>
  );
}
