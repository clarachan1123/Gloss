"use client";

import Link from "next/link";
import localFont from "next/font/local";
import FeedbackButton from "@/components/feedback/FeedbackButton";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { emitAnalytics } from "@/lib/analytics-events";
import { enqueueAnalytics, markReaderEntry } from "@/lib/analytics-local";
import { SAMPLE_DOC_ID } from "@/lib/sample";
import LandingDemo from "./LandingDemo";

const titleFont = localFont({ src: "./fonts/noto-serif-sc-title-900.woff2", weight: "900", display: "swap", fallback: ["Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", "Noto Serif SC", "serif"], adjustFontFallback: false });
const COPY = {
  sampleButton: "读一段示例", importButton: "导入自己的书", replayButton: "再看一遍",
  formats: "docx · txt · 文字版 PDF · 粘贴", mobileFormats: "docx · txt · PDF · 粘贴",
  privacy: "书和白话只存在你的浏览器里",
} as const;
const LANDING_STEPS = [
  ["句子太绕、结构复杂？", "点一下句子，原地转成大白话"],
  ["还是不懂？", "点「听不懂」，结合前后文讲清这一句"],
] as const;
const MOBILE_STEPS = ["点一下句子，转成大白话", "还不懂？点「听不懂」，结合前后文讲清"];

// Strict Mode 会重放 effect；离开首页后的下一个任务才结束这次显示。
let landingViewActive = false;
let leaveTimer: number | null = null;

export default function Landing({ onImport, importButtonRef, importOpen = false }: {
  onImport: () => void;
  importOpen?: boolean;
  importButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [replayIndex, setReplayIndex] = useState(0);
  const [currentStep, setCurrentStep] = useState<0 | 1 | 2>(0);
  const pageRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    // 尾部留白跟随真实按钮区高度，支持文字缩放和安全区。
    const measure = () => pageRef.current?.style.setProperty("--landing-actions-height", `${actions.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(actions);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [importOpen]);
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let active = true;
    let positioned = false;
    // 只用首个完整原文状态确定首屏居中位置，播放增长不得重新居中。
    const position = () => {
      if (!active || positioned || window.innerWidth < 1000 || !page.querySelector(".landing-demo-visible")) return;
      const copy = page.querySelector<HTMLElement>(".landing-copy")!;
      const demo = page.querySelector<HTMLElement>(".landing-demonstration")!;
      const header = page.querySelector<HTMLElement>(".landing-header")!;
      page.style.setProperty("--landing-copy-height", `${copy.offsetHeight}px`);
      const height = Math.max(copy.offsetHeight + 36 + (actionsRef.current?.offsetHeight ?? 0), demo.offsetHeight);
      page.style.setProperty("--landing-hero-top", `${Math.max(40, (window.innerHeight - header.offsetHeight - 40 - 56 - height) / 2 + 40)}px`);
      positioned = true;
    };
    const observer = new MutationObserver(position);
    const resize = () => { positioned = false; position(); };
    void (document.fonts?.ready ?? Promise.resolve()).then(() => { if (active) { observer.observe(page, { subtree: true, childList: true }); position(); } });
    window.addEventListener("resize", resize);
    return () => { active = false; observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);
  const stepsRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const steps = stepsRef.current;
    const slider = sliderRef.current;
    const active = steps?.querySelector<HTMLElement>(".landing-step-current");
    if (!steps || !slider) return;
    const position = () => {
      if (steps.getClientRects().length === 0) {
        slider.style.opacity = "0";
        delete slider.dataset.positioned;
        return;
      }
      if (!active) { slider.style.opacity = "0"; return; }
      slider.style.transform = `translateY(${active.offsetTop}px)`;
      slider.style.height = `${active.offsetHeight}px`;
      if (!slider.dataset.positioned) {
        slider.style.transition = "none";
        slider.style.opacity = "0";
        void slider.offsetHeight;
        slider.style.transition = "";
        slider.dataset.positioned = "true";
      }
      slider.style.opacity = "1";
    };
    position();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", position);
      return () => window.removeEventListener("resize", position);
    }
    const observer = new ResizeObserver(position);
    observer.observe(steps);
    return () => observer.disconnect();
  }, [currentStep]);
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
    <main ref={pageRef} className={`landing-page${importOpen ? " landing-import-open" : ""}`}>
      <div className="landing-content">
        <header className="landing-header">
          <span className="wordmark">GLOSS</span><FeedbackButton appearance="landing" />
        </header>
        <div className="landing-layout">
        <div className="landing-copy">
          <h1 className={titleFont.className}><span>哪句不懂，</span><span>点<em>哪句</em>。</span></h1>
          <p className="landing-subtitle">把难句改写成大白话，就地展开在原句下面，看完<strong>接着往下读</strong>。</p>
          <div className="landing-steps" ref={stepsRef}>
            <span className="landing-step-slider" ref={sliderRef} aria-hidden="true" />
            <ol>
            {LANDING_STEPS.map(([question, answer], ordinal) => {
              const step = ordinal + 1;
              return <li key={step} className={`landing-step${currentStep === step ? " landing-step-current" : currentStep > step ? " landing-step-completed" : ""}`} aria-current={currentStep === step ? "step" : undefined}>
                <span className="landing-step-number" aria-hidden="true">{step}</span>
                <div><p className="landing-step-question">{question}</p><p className="landing-step-answer">{answer}</p></div>
              </li>;
            })}
            </ol>
          </div>
        </div>
        <section className="landing-demonstration" aria-label="点击句子查看白话的演示">
          <div className="landing-demo-header">
            <small>《社会哲学概论》（1924）· 善与恶</small>
            <button type="button" onClick={() => setReplayIndex((index) => index + 1)}>{COPY.replayButton}</button>
          </div>
          <ol className="landing-demo-steps">
            {LANDING_STEPS.map(([question, answer], ordinal) => {
              const step = ordinal + 1;
              return <li key={step} className={`landing-demo-step${currentStep === step ? " landing-demo-step-current" : currentStep > step ? " landing-demo-step-completed" : ""}`} aria-current={currentStep === step ? "step" : undefined}>
                <span className="landing-demo-step-number" aria-hidden="true">{step}</span>
                <span className="landing-demo-step-text">{MOBILE_STEPS[ordinal]}</span>
              </li>;
            })}
          </ol>
          <LandingDemo replayIndex={replayIndex} onStepChange={setCurrentStep} />
        </section>
        <div className="landing-action-area" ref={actionsRef} inert={importOpen}>
          <div className="landing-actions">
            <Link href="/read/sample" className="landing-primary" onClick={() => emitAnalytics({ event: "landing_cta_click", target: "sample" })} onNavigate={() => markReaderEntry(SAMPLE_DOC_ID, "landing")}>{COPY.sampleButton}<span aria-hidden="true"> →</span></Link>
            <div className="landing-secondary-group"><button ref={importButtonRef} type="button" className="landing-secondary" onClick={() => { emitAnalytics({ event: "landing_cta_click", target: "import" }); onImport(); }}>{COPY.importButton}</button><small className="landing-mobile-formats">{COPY.mobileFormats}</small></div>
          </div>
          <p className="landing-formats"><span>{COPY.formats}</span><i aria-hidden="true"/><span>{COPY.privacy}</span></p>
        </div>
        </div>
      </div>
    </main>
  );
}
