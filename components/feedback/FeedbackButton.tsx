"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function FeedbackButton({ placement = "inline" }: { placement?: "reader" | "shelf" | "inline" }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"ready" | "copied" | "manual">("ready");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestRef = useRef(0);
  const close = useCallback(() => {
    copyRequestRef.current++;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setOpen(false);
    setCopyState("ready");
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => {
    copyRequestRef.current++;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      const card = cardRef.current;
      if (!button || !card) return;
      const bounds = card.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const below = button.bottom + 8;
      const above = button.top - bounds.height - 8;
      card.style.left = Math.max(16, Math.min(button.right - bounds.width, width - bounds.width - 16)) + "px";
      card.style.top = Math.max(16, Math.min(below + bounds.height <= height - 16 ? below : above, height - bounds.height - 16)) + "px";
    };
    place();
    cardRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      return target && !buttonRef.current?.contains(target) && !cardRef.current?.contains(target);
    };
    // Consume the closing gesture before Reader's document listeners see it.
    const pointer = (event: PointerEvent) => {
      if (!outside(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const click = (event: MouseEvent) => {
      if (!outside(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, close]);

  const copy = async () => {
    const request = ++copyRequestRef.current;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText("Claraiing");
      if (request !== copyRequestRef.current) return;
      setCopyState("copied");
      timerRef.current = setTimeout(() => setCopyState("ready"), 2000);
    } catch {
      if (request !== copyRequestRef.current) return;
      const range = document.createRange();
      if (accountRef.current) {
        range.selectNodeContents(accountRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyState("manual");
    }
  };

  return <span className={"feedback-entry feedback-" + placement} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
    <button ref={buttonRef} type="button" className="feedback-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => open ? close() : setOpen(true)}>提意见</button>
    {open && createPortal(<div ref={cardRef} className="feedback-card" role="dialog" aria-label="提意见" tabIndex={-1} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <p>Gloss 还在测试，很需要你的意见。</p>
      <p>哪里不好用、哪句白话不对，都可以直接告诉我。</p>
      <p>微信：<span ref={accountRef}>Claraiing</span> <button type="button" className="feedback-copy" onClick={() => void copy()}>{copyState === "copied" ? "已复制" : "复制微信号"}</button></p>
      {copyState === "manual" && <p role="status">请手动复制</p>}
      <p>白话不对的话，也可以在白话上右键，点「翻错了」。</p>
    </div>, document.body)}
  </span>;
}
