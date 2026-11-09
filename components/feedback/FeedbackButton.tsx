"use client";

import { useCallback, useId, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FEEDBACK_BODY_MAX, FEEDBACK_CONTACT_MAX, feedbackLength } from "@/lib/feedback";

export default function FeedbackButton({ placement = "inline", openRequest = 0, returnFocus, appearance, closeRequest = 0, onOpen }: {
  closeRequest?: number; onOpen?: () => void;
  appearance?: "landing";
  placement?: "reader" | "shelf" | "inline"; openRequest?: number; returnFocus?: () => HTMLElement | null;
}) {
  const dragRef = useRef<{ start: number; y: number; time: number; speed: number } | null>(null);
  const draggedRef = useRef(false);
  const [dragY, setDragY] = useState(0);
  const contactId = useId();
  const [mobile, setMobile] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeFrame = useRef<number | null>(null);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
    return () => window.clearTimeout(timer);
  }, [closing]);
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
    draggedRef.current = false;
    dragRef.current = null; setDragY(0);
    if (cardRef.current?.classList.contains("feedback-sheet")) setClosing(true);
    setOpen(false);
    setCopyState("ready");
    setStatus(value => value === "success" ? "idle" : value);
    // 先解除背景惰性，再恢复入口焦点。
    layerRef.current?.dispatchEvent(new Event("feedback-unlock"));
    (returnFocus?.() ?? buttonRef.current)?.focus({ preventScroll: true });
  }, [returnFocus]);

  useEffect(() => { if (closeRequest > 0) close(); }, [closeRequest, close]);
  useEffect(() => { if (open) onOpen?.(); }, [open, onOpen]);
  useEffect(() => { if (openRequest > 0) { setStatus(value => value === "success" ? "idle" : value); setClosing(false); setOpen(true); } }, [openRequest]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeFrame.current !== null) cancelAnimationFrame(closeFrame.current);
      copyRequestRef.current++;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      requestRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const media = window.matchMedia("(max-width: 767.98px)");
    const update = () => setMobile(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const card = cardRef.current;
      if (!card) return;
      if (mobile) {
        const viewport = window.visualViewport;
        const height = viewport?.height ?? window.innerHeight;
        card.style.left = "0px"; card.style.top = "auto";
        card.style.bottom = Math.max(0, window.innerHeight - ((viewport?.offsetTop ?? 0) + height)) + "px";
        card.style.maxHeight = Math.max(0, height - 32) + "px";
        return;
      }
      card.style.bottom = ""; card.style.maxHeight = "";
      const button = (returnFocus?.() ?? buttonRef.current)?.getBoundingClientRect();
      if (!button) return;
      const width = document.documentElement.clientWidth, height = window.innerHeight;
      // offset 尺寸不受进入动画的 transform 影响。
      const w = card.offsetWidth, h = card.offsetHeight;
      const below = button.bottom + 8, above = button.top - h - 8;
      const flipped = (placement === "reader" && window.innerWidth >= 1000) || below + h > height - 16;
      const left = Math.max(16, Math.min(button.right - w, width - w - 16));
      card.style.left = left + "px";
      card.style.top = Math.max(16, Math.min(flipped ? above : below, height - h - 16)) + "px";
      const arrow = (button.left + button.right) / 2 - left;
      card.style.setProperty("--feedback-arrow-x", (arrow - card.clientLeft) + "px");
      card.dataset.side = flipped ? "above" : "below";
      card.dataset.arrow = String(arrow >= 14 && arrow <= w - 14 && button.top >= 0 && button.bottom <= height && button.left >= 0 && button.right <= width);
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (cardRef.current) observer?.observe(cardRef.current);
    const viewport = window.visualViewport;
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    viewport?.addEventListener("resize", place); viewport?.addEventListener("scroll", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      viewport?.removeEventListener("resize", place); viewport?.removeEventListener("scroll", place);
    };
  }, [open, mobile, returnFocus, placement]);

  useLayoutEffect(() => {
    if (!open) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mobile) return;
    const layer = layerRef.current, root = document.documentElement;
    const previous = root.style.overflow;
    const saved = new Map<HTMLElement, boolean>();
    const protect = () => {
      for (const node of document.body.children) if (node instanceof HTMLElement && node !== layer && !saved.has(node)) {
        saved.set(node, node.inert); node.inert = true;
      }
    };
    protect();
    const observer = new MutationObserver(protect); observer.observe(document.body, { childList: true });
    root.style.overflow = "hidden";
    const unlock = () => {
      root.style.overflow = previous;
      for (const [node, inert] of saved) node.inert = inert;
      observer.disconnect();
    };
    layer?.addEventListener("feedback-unlock", unlock);
    const wheel = (event: WheelEvent) => { if (!cardRef.current?.contains(event.target as Node)) event.preventDefault(); };
    let lastY = 0;
    const touchStart = (event: TouchEvent) => {
      draggedRef.current = false;
      dragRef.current = null; setDragY(0);
      lastY = event.touches[0]?.clientY ?? 0;
      const target = event.target as Element;
      if (event.touches.length !== 1 || !cardRef.current?.contains(target) || !target.closest(".feedback-grip,.feedback-header") || target.closest("button,input,textarea,select,a")) return;
      draggedRef.current = false;
      dragRef.current = { start: lastY, y: lastY, time: event.timeStamp, speed: 0 };
    };
    const touchMove = (event: TouchEvent) => {
      const card = cardRef.current, y = event.touches[0]?.clientY ?? lastY, delta = y - lastY;
      lastY = y;
      const drag = dragRef.current;
      if (drag) {
        if (event.touches.length !== 1) { draggedRef.current = false; dragRef.current = null; setDragY(0); return; }
        const elapsed = event.timeStamp - drag.time;
        drag.speed = elapsed > 0 ? (y - drag.y) / elapsed : 0;
        drag.y = y; drag.time = event.timeStamp;
        draggedRef.current ||= Math.abs(y - drag.start) > 4;
        setDragY(Math.max(0, y - drag.start));
        event.preventDefault(); return;
      }
      if (!card?.contains(event.target as Node) || (delta > 0 && card.scrollTop <= 0) ||
          (delta < 0 && card.scrollTop + card.clientHeight >= card.scrollHeight)) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      const drag = dragRef.current;
      draggedRef.current = false;
      dragRef.current = null; setDragY(0);
      if (!drag || event.type === "touchcancel") return;
      const distance = drag.y - drag.start;
      if (distance > 80 || (distance >= 20 && event.timeStamp - drag.time <= 80 && drag.speed >= .5)) {
        if (closeFrame.current !== null) cancelAnimationFrame(closeFrame.current);
        closeFrame.current = requestAnimationFrame(() => { closeFrame.current = null; close(); });
      }
    };
    const focus = () => {
      const card = cardRef.current, active = document.activeElement;
      if (!card || !(active instanceof HTMLElement) || !active.matches("textarea,input") || !card.contains(active)) return;
      const a = active.getBoundingClientRect(), b = card.getBoundingClientRect();
      if (a.bottom > b.bottom - 12) card.scrollTop += a.bottom - b.bottom + 12;
      else if (a.top < b.top + 12) card.scrollTop -= b.top + 12 - a.top;
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", focus); viewport?.addEventListener("scroll", focus);
    layer?.addEventListener("focusin", focus);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("touchstart", touchStart, { passive: true });
    window.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("touchend", touchEnd); window.addEventListener("touchcancel", touchEnd);
    return () => {
      unlock(); layer?.removeEventListener("feedback-unlock", unlock);
      layer?.removeEventListener("focusin", focus);
      viewport?.removeEventListener("resize", focus); viewport?.removeEventListener("scroll", focus);
      draggedRef.current = false; dragRef.current = null;
      window.removeEventListener("touchend", touchEnd); window.removeEventListener("touchcancel", touchEnd);
      window.removeEventListener("wheel", wheel); window.removeEventListener("touchstart", touchStart); window.removeEventListener("touchmove", touchMove);
    };
  }, [open, mobile, close]);

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
      if (mobile && event.key === "Tab") {
        const controls = [...(cardRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled)") ?? [])].filter(el => el.getClientRects().length > 0);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (controls.length && (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))) {
          event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus({ preventScroll: true });
        }
        return;
      }
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
  }, [open, close, mobile]);

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

  return <span className={"feedback-entry feedback-" + (appearance ?? placement)} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <button ref={buttonRef} type="button" className="feedback-button" aria-label="体验反馈" aria-expanded={open} aria-haspopup="dialog" onClick={() => {
      if (open) close();
      else { setStatus(value => value === "success" ? "idle" : value); setClosing(false); setOpen(true); }
    }}>{placement === "reader" || placement === "shelf" || appearance === "landing" ? <><svg className="feedback-shelf-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><span className="feedback-desktop-label">体验反馈</span>{placement !== "reader" && <span className="feedback-mobile-label">{appearance === "landing" ? "体验反馈" : "反馈"}</span>}</> : "体验反馈"}</button>
    {(open || closing) && createPortal(<div ref={layerRef} className="feedback-layer" data-closing={closing || undefined} inert={closing} aria-hidden={closing || undefined}>
      {mobile && <div className="feedback-backdrop" aria-hidden="true" />}
      <div ref={cardRef} className={"feedback-card" + (mobile ? " feedback-sheet" : "")} onAnimationEnd={event => { if (event.target === event.currentTarget) { if (event.animationName === "reader-sheet-out") setClosing(false); else event.currentTarget.dataset.entered = "true"; } }} style={{ translate: `0 ${dragY}px` }} data-dragging={dragRef.current !== null || undefined}
        onPointerDownCapture={() => { draggedRef.current = false; }}
        onClickCapture={event => { if (draggedRef.current) { draggedRef.current = false; event.preventDefault(); event.stopPropagation(); } }} role="dialog" aria-label="体验反馈" aria-modal={mobile || undefined} tabIndex={-1}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
        <div className="feedback-grip" aria-hidden="true" />
        <span className="feedback-arrow" aria-hidden="true" />
        <header className="feedback-header"><div><h2>体验反馈</h2><p>{mobile ? "哪里不好用、哪句白话不对，直接说。" : "哪里不好用、哪句白话不对，欢迎告诉我。"}</p></div>
          {!mobile && <button type="button" className="feedback-close" aria-label="关闭" onClick={close}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>}
        </header>
        {status === "success" ? <div className="feedback-success">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="20" cy="20" r="18" /><path d="m12 20 6 6 11-12" /></svg>
          <p role="status" className="feedback-success-title">已收到，谢谢！</p><p>每一条都会看。</p>
          <button type="button" className={mobile ? "feedback-send" : "feedback-again"} onClick={() => {
            if (mobile) close();
            else { setStatus("idle"); requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true })); }
          }}>{mobile ? "回到阅读" : "再写一条"}</button>
        </div> : <div className="feedback-form">
          <div className="feedback-body-field"><textarea ref={textareaRef} aria-label="意见" placeholder="比如：第二段的白话好像讲错了……" value={body} onChange={event => setBody(event.target.value)} disabled={status === "sending"} />
            <span className={"feedback-count" + (bodyLength > FEEDBACK_BODY_MAX ? " feedback-error" : "")}>{bodyLength} / 1000</span></div>
          {bodyLength > FEEDBACK_BODY_MAX && <p className="feedback-error" role="status">超过 1000 字了，删一些再发</p>}
          <div className="feedback-contact-field"><label htmlFor={contactId}>联系方式 · 选填</label>
            <input id={contactId} type="text" placeholder="微信或邮箱，想让我回复的话" value={contact} onChange={event => setContact(event.target.value)} disabled={status === "sending"} /></div>
          {contactLength > FEEDBACK_CONTACT_MAX && <p className="feedback-error" role="status">联系方式太长了</p>}
          {status === "error" && <p className="feedback-failure" role="status">没发出去，内容还在。稍后再试，或加微信：Claraiing</p>}
          <button type="button" className="feedback-send" disabled={invalid || status === "sending"} onClick={() => void send()}>{status === "sending" && <svg className="feedback-spinner" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1a7 7 0 1 1-7 7" /></svg>}{status === "sending" ? "发送中…" : status === "error" ? "重新发送" : "发送"}</button>
          <p className="feedback-private">只发给开发者，不会公开</p>
        </div>}
        <footer className="feedback-footer"><p className="feedback-contact"><span>想直接聊：微信 <span ref={accountRef} className="feedback-account">Claraiing</span></span><button type="button" className="feedback-copy" onClick={() => void copy()}>{copyState === "copied" ? "已复制" : "复制"}</button></p>
          {copyState === "manual" && <p role="status">请手动复制</p>}
          <p className="feedback-report-tip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M9 18h6m-6 3h6M8 14a7 7 0 1 1 8 0l-1 2H9z" /></svg><span>白话翻错了？也可以在白话上右键，点「翻错了」。</span></p>
        </footer>
      </div>
    </div>, document.body)}
  </span>;
}
