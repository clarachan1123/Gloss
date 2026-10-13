"use client";

import Link from "next/link";
import FeedbackButton from "@/components/feedback/FeedbackButton";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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

const LANDING_STEPS = [
  ["句子太绕、结构复杂？", "点一下句子，转成大白话"],
  ["还是不懂？", "点「听不懂」，结合前后文讲清这句"],
] as const;

// Strict Mode 会重放 effect；离开首页后的下一个任务才结束这次显示。
let landingViewActive = false;
let leaveTimer: number | null = null;

export default function Landing({ onImport, importButtonRef }: {
  onImport: () => void;
  importButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [replayIndex, setReplayIndex] = useState(0);
  const [currentStep, setCurrentStep] = useState<0 | 1 | 2>(0);
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
    <main className="landing-page">
      <div className="landing-content">
        <header className="landing-header">
          <span className="wordmark">Gloss</span>
        </header>
        <div className="landing-layout">
        <div className="landing-copy">
          <h1>{COPY.title}</h1>
          <p className="landing-subtitle">{COPY.subtitle}</p>
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
        <div className="landing-actions">
          <Link href="/read/sample" className="landing-primary" onClick={() => emitAnalytics({ event: "landing_cta_click", target: "sample" })} onNavigate={() => markReaderEntry(SAMPLE_DOC_ID, "landing")}>{COPY.sampleButton}</Link>
          <div className="landing-secondary-group">
            <button ref={importButtonRef} type="button" className="landing-secondary" onClick={() => { emitAnalytics({ event: "landing_cta_click", target: "import" }); onImport(); }}>{COPY.importButton}</button>
            <small>{COPY.importNote}</small>
          </div>
        </div>
        <p className="landing-supplement">{COPY.supplement}</p>
        </div>
        <section className="landing-demonstration" aria-label="点击句子查看白话的演示">
          <div className="landing-demo-header">
            <small>{SAMPLE_SOURCE}</small>
            <button type="button" onClick={() => setReplayIndex((index) => index + 1)}>{COPY.replayButton}</button>
          </div>
          <ol className="landing-demo-steps">
            {LANDING_STEPS.map(([question, answer], ordinal) => {
              const step = ordinal + 1;
              return <li key={step} className={`landing-demo-step${currentStep === step ? " landing-demo-step-current" : currentStep > step ? " landing-demo-step-completed" : ""}`} aria-current={currentStep === step ? "step" : undefined}>
                <span className="landing-demo-step-number" aria-hidden="true">{step}</span>
                <span className="landing-demo-step-text">{question}{answer}</span>
              </li>;
            })}
          </ol>
          <LandingDemo replayIndex={replayIndex} onStepChange={setCurrentStep} />
        </section>
        </div>
        <p className="landing-feedback">测试版，很需要你的意见。<FeedbackButton /></p>
      </div>
    </main>
  );
}
