"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FEEDBACK_BODY_MAX, FEEDBACK_CONTACT_MAX, feedbackLength } from "@/lib/feedback";

export default function FeedbackButton({ placement = "inline", openRequest = 0, returnFocus }: {
  placement?: "reader" | "shelf" | "inline"; openRequest?: number; returnFocus?: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"ready" | "copied" | "manual">("ready");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestRef = useRef(0);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  const requestRef = useRef<AbortController | null>(null);
  const close = useCallback(() => {
    copyRequestRef.current++;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setOpen(false);
    setCopyState("ready");
    setStatus(value => value === "success" ? "idle" : value);
    (returnFocus?.() ?? buttonRef.current)?.focus({ preventScroll: true });
  }, [returnFocus]);

  useEffect(() => { if (openRequest > 0) { setStatus(value => value === "success" ? "idle" : value); setOpen(true); } }, [openRequest]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyRequestRef.current++;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      requestRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = (returnFocus?.() ?? buttonRef.current)?.getBoundingClientRect();
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
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (cardRef.current) observer?.observe(cardRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
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
      event.stopImmediatePropagation();
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
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
  const bodyLength = feedbackLength(body);
  const contactLength = feedbackLength(contact);
  const invalid = bodyLength === 0 || bodyLength > FEEDBACK_BODY_MAX || contactLength > FEEDBACK_CONTACT_MAX;
  const send = async () => {
    if (sendingRef.current || invalid) return;
    sendingRef.current = true;
    setStatus("sending");
    const controller = new AbortController();
    requestRef.current = controller;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        fetch("/api/feedback", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ id: crypto.randomUUID(), body: body.trim(), contact: contact.trim(), source: placement === "inline" ? "landing" : placement }),
        }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, 15_000);
        }),
      ]);
      if (response.status !== 200) throw new Error("unavailable");
      if (mountedRef.current) { setBody(""); setContact(""); setStatus("success"); }
    } catch {
      if (mountedRef.current) setStatus("error");
    } finally {
      clearTimeout(deadline);
      sendingRef.current = false;
      requestRef.current = null;
    }
  };

  return <span className={"feedback-entry feedback-" + placement} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <button ref={buttonRef} type="button" className="feedback-button" aria-label="体验反馈" aria-expanded={open} aria-haspopup="dialog" onClick={() => {
      if (open) close();
      else { setStatus(value => value === "success" ? "idle" : value); setOpen(true); }
    }}>{placement === "shelf" ? <><svg className="feedback-shelf-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><span className="feedback-desktop-label">体验反馈</span><span className="feedback-mobile-label">反馈</span></> : "体验反馈"}</button>
    {open && createPortal(<div ref={cardRef} className="feedback-card" role="dialog" aria-label="体验反馈" tabIndex={-1}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
      <p>Gloss 还在测试，很需要你的意见。</p>
      {status === "success" ? <p role="status">已收到，谢谢！</p> : <div className="feedback-form">
        <textarea aria-label="意见" placeholder="哪里不好用、哪句白话不对，直接写在这里" value={body} onChange={event => setBody(event.target.value)} disabled={status === "sending"} />
        {bodyLength > FEEDBACK_BODY_MAX && <p className="feedback-error" role="status">超过 1000 字了，删一些再发</p>}
        <input type="text" aria-label="联系方式（选填）" placeholder="选填：想让我回复的话，留个微信或邮箱" value={contact} onChange={event => setContact(event.target.value)} disabled={status === "sending"} />
        {contactLength > FEEDBACK_CONTACT_MAX && <p className="feedback-error" role="status">联系方式太长了</p>}
        <button type="button" className="feedback-send" disabled={invalid || status === "sending"} onClick={() => void send()}>{status === "sending" ? "发送中…" : "发送"}</button>
        {status === "error" && <p className="feedback-error" role="status">没发出去，可以稍后再试，或加微信 Claraiing</p>}
      </div>}
      <p className="feedback-contact">内容只发给开发者，不会公开。想直接聊，非常欢迎加微信：<span ref={accountRef}>Claraiing</span> <button type="button" className="feedback-copy" onClick={() => void copy()}>{copyState === "copied" ? "已复制" : "复制"}</button></p>
      {copyState === "manual" && <p role="status">请手动复制</p>}
      <p>💡 白话不对的话，也可以在白话上右键，点「翻错了」。</p>
    </div>, document.body)}
  </span>;
}
