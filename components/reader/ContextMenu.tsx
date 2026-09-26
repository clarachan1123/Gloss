"use client";

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuPoint {
  x: number;
  y: number;
}

export type ContextExplainStatus = "idle" | "loading" | "streaming" | "done" | "failed";

export default function ContextMenu({
  point,
  explainStatus,
  reportDisabled,
  reported,
  reportPending,
  feedback,
  onExplain,
  onExplainBlocked,
  onReport,
}: {
  point: ContextMenuPoint;
  explainStatus: ContextExplainStatus;
  reportDisabled: boolean;
  reported: boolean;
  reportPending: boolean;
  feedback: string | null;
  onExplain: () => void;
  onExplainBlocked: () => void;
  onReport: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const explainDisabled = explainStatus === "done" || explainStatus === "loading" || explainStatus === "streaming";

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    const gap = 8;
    const bounds = menu.getBoundingClientRect();
    const right = point.x + gap + bounds.width <= window.innerWidth - margin
      ? point.x + gap
      : point.x - bounds.width - gap;
    const bottom = point.y + gap + bounds.height <= window.innerHeight - margin
      ? point.y + gap
      : point.y - bounds.height - gap;
    menu.style.left = `${Math.max(margin, Math.min(right, window.innerWidth - bounds.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(bottom, window.innerHeight - bounds.height - margin))}px`;
  }, [feedback, point]);

  return createPortal(
    <div
      ref={menuRef}
      className="reader-context-menu"
      role="menu"
      aria-label="句子操作"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        aria-disabled={explainDisabled}
        onClick={() => {
          if (explainStatus === "done") onExplainBlocked();
          else if (explainStatus !== "loading" && explainStatus !== "streaming") onExplain();
        }}
      >
        听不懂
      </button>
      <button
        type="button"
        role="menuitem"
        aria-disabled={reportDisabled || reported || reportPending}
        onClick={() => {
          if (!reportDisabled && !reported && !reportPending) onReport();
        }}
      >
        {reported ? "已报告" : "翻错了"}
      </button>
      <p className="reader-context-menu-privacy">会把这句原文和白话发给开发者</p>
      {feedback && <p className="reader-context-menu-feedback" role="status">{feedback}</p>}
    </div>,
    document.body,
  );
}
