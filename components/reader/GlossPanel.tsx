import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { GlossFailure } from "@/lib/gloss-client";
import { limitTerms, splitTerms } from "@/lib/output";
import type { StorageErrorCode } from "@/lib/storage";
import ActionRow from "./ActionRow";
import TermMark from "./TermMark";

/**
 * 撑开区。插在被点击句所在的「行尾」之后，占据布局空间、推动下文（D9）。
 * 临时撑开区不加框、不加底色，仅一条左竖线；G-10b 决定白话统一为 14px。
 *
 * 白话按 3–5 字一块逐步出现（PRD 3.7）。服务端已按这个粒度切块，但传输层会把几块并成一次到达，
 * 视觉节奏只能在这里保证：收到的字先进队列，按固定节奏放出来。
 */

export type GlossStatus = "loading" | "streaming" | "done" | "failed";

export interface GlossView {
  status: GlossStatus;
  /** 目前收到的全部白话（失败时是断流前收到的部分） */
  text: string;
  failure: GlossFailure | null;
  /** 本次会话里生成过的句子：整段直接出现，不再逐块放 */
  instant: boolean;
}

export const LOADING_VIEW: GlossView = { status: "loading", text: "", failure: null, instant: false };

/** 每块放出的字数（PRD 3.7：3–5 字一块）与间隔。约 90 字/秒，150 字上限约 1.7 秒放完 */
const REVEAL_CHARS = 4;
const REVEAL_INTERVAL_MS = 45;

/** C3：限流后 5 秒才能重试 */
const RATE_LIMIT_WAIT_MS = 5000;

/**
 * 前端从发请求开始 10 秒未收到首字时给读者反馈。服务端首字重试阈值是 15 秒，
 * 这个值必须小于服务端阈值；任一侧改动时要一起核对，否则慢提示会失去意义。
 */
const SLOW_NOTICE_MS = 10_000;

/** 措辞只说发生了什么，不说「出错了」这类把责任推给读者的话 */
const NOTES: Record<GlossFailure, string> = {
  timeout: "这次没能生成，点「重试」通常就好。",
  unavailable: "暂时无法生成。",
  rate_limited: "请求有点多，稍后再试。",
  throttled: "点得太快了，过几分钟再试。",
  refused: "这一句无法处理。",
  offline: "网络已断开，连上网络后再试。",
  interrupted: "网络中断，这段白话没有写完。",
};

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export default function GlossPanel({
  ref,
  view,
  onRetry,
  saved,
  onSave,
  source,
  presentation = "inline",
  actionVisible = true,
}: {
  ref?: Ref<HTMLDivElement>;
  view: GlossView;
  onRetry: () => void;
  saved: boolean;
  onSave: () => Promise<"saved" | "removed" | StorageErrorCode>;
  /**
   * 被点击的原句。传了就逐字校验标记（标记里的词必须出现在原句里，G-08 验收 a）；
   * 不传只做数量、长度、去重三道检查（Reader 从 2026-09-18 起传入）
   */
  source?: string;
  /** G-10b：所有白话共用显示形态；已保存与否只影响颜色与操作行。 */
  presentation?: "inline" | "bubble";
  actionVisible?: boolean;
}) {
  const chars = Array.from(view.text);
  const [reducedMotion] = useState(prefersReducedMotion);
  // 每次渲染都判断：重复点击时面板先以「加载中」出现，下一次渲染才拿到会话缓存
  const immediate = view.instant || reducedMotion;
  const [shown, setShown] = useState(0);
  const visible = immediate ? chars.length : Math.min(shown, chars.length);
  const revealing = visible < chars.length;

  useEffect(() => {
    if (!revealing) return;
    const timer = window.setTimeout(() => setShown(visible + REVEAL_CHARS), REVEAL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealing, visible]);

  // 断流时先把已收到的字放完，再显示提示
  const failure = view.status === "failed" && !revealing ? view.failure : null;
  const busy = !failure && (view.status === "loading" || view.status === "streaming" || revealing);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!busy || visible > 0) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [busy, visible]);

  /*
   * 仅未保存的 transient 撑开期间高度只增不减（决议：生成结束不是用户操作，由它引起的位移违反产品不变量）。
   * 常驻区的操作行是读者显式显示／隐藏的 UI，必须按实际高度收缩，并由 Reader 事务锚定。
   * 生成中按 CSS 预留 3 行；写完的白话不足 3 行、或换成一行失败提示时，内容会变矮——
   * 每次渲染后、绘制前量一次高度，比历史最高矮就用 min-height 顶住，下方内容不动。
   * 收起时撑开区整个移除，自然缩回；重试会换 key 重新挂载，从头计算（那是读者自己的操作）。
   * 只量高度，不影响宽度方向的排版。
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tallestRef = useRef(0);
  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (saved) {
      tallestRef.current = 0;
      panel.style.minHeight = "";
      return;
    }
    const height = panel.getBoundingClientRect().height;
    if (height >= tallestRef.current) {
      tallestRef.current = height;
    } else {
      panel.style.minHeight = `${tallestRef.current}px`;
    }
  });

  const [cooling, setCooling] = useState(false);
  useEffect(() => {
    if (failure !== "rate_limited") return;
    setCooling(true);
    const timer = window.setTimeout(() => setCooling(false), RATE_LIMIT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [failure]);

  return (
    <div
      ref={setPanelRef}
      className={`gloss-panel gloss-panel-${presentation}${saved ? " gloss-panel-saved" : ""}`}
      role="region"
      aria-label="白话"
      aria-busy={busy}
      data-state={busy ? "busy" : failure ? "failed" : "done"}
    >
      {visible > 0 && (
        <p className="gloss-panel-text">
          {/*
            每次渲染都拿「已经放出来的那一段全文」重新解析：定界符可能被 3–5 字的分块切开，
            按累计文本解析就不受分块边界影响。生成中未配对的左半边先按术语显示（右半边还没到），
            写完了仍未配对就按普通文字显示。定界符本身不会出现在任何一段里。
          */}
          {limitTerms(splitTerms(chars.slice(0, visible).join(""), busy), { source }).map((seg, i) =>
            seg.term ? <TermMark key={i}>{seg.text}</TermMark> : <span key={i}>{seg.text}</span>,
          )}
        </p>
      )}
      {busy && visible === 0 && (
        <p className="gloss-panel-pending" aria-label="正在生成">
          ……
        </p>
      )}
      {busy && visible === 0 && slow && <p className="gloss-panel-note">这句有点慢，再等一下…</p>}
      {failure && (
        <p className="gloss-panel-note">
          {NOTES[failure]}
          {/*
            不给重试：C6 拒答再试一次也一样；被 WAF 限流时窗口还没过，马上点也会再被拦。
            限流过去之后，收起再点这一句就会重新请求（失败结果不进会话缓存）
          */}
          {failure !== "refused" && failure !== "throttled" && (
            <button type="button" className="gloss-panel-retry" onClick={onRetry} disabled={cooling}>
              重试
            </button>
          )}
        </p>
      )}
      {actionVisible && <ActionRow saved={saved} disabled={view.status !== "done" || revealing} onToggle={onSave} />}
    </div>
  );
}
