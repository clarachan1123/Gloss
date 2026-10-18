import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { clearAllGlossCache } from "@/lib/cache";
import { DEFAULT_READER_TYPOGRAPHY, TYPOGRAPHY_RANGES, type ReaderTypography } from "@/lib/reader-typography";
import { THEME_OPTIONS, APPEARANCE_OPTIONS, readerThemeSnapshot, readerAppearanceSnapshot, effectiveThemeSnapshot, setReaderTheme, setReaderAppearance, subscribeReaderTheme } from "@/lib/reader-theme";

const CONFIRM_MS = 5_000;
const RESULT_MS = 3_000;

export default function SettingsPanel({
  glossShape,
  onGlossShapeChange,
  typography,
  onTypographyChange,
  onTypographyGestureStart,
  onTypographyGestureEnd,
}: {
  glossShape: "inline" | "bubble";
  onGlossShapeChange: (shape: "inline" | "bubble") => void;
  typography: ReaderTypography;
  onTypographyChange: (value: ReaderTypography, discrete?: boolean) => void;
  onTypographyGestureStart?: () => void;
  onTypographyGestureEnd?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const typographyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const appearance = useSyncExternalStore(subscribeReaderTheme, readerAppearanceSnapshot, () => "system");
  const effective = useSyncExternalStore(subscribeReaderTheme, effectiveThemeSnapshot, () => "parchment");
  const theme = useSyncExternalStore(subscribeReaderTheme, readerThemeSnapshot, () => "parchment");
  const appearanceName = APPEARANCE_OPTIONS.find(option => option.value === appearance)!.label;
  const themeName = THEME_OPTIONS.find(option => option.value === theme)!.label;
  const [state, setState] = useState<"idle" | "confirm" | "cleared" | "failed">("idle");
  function close() { setExpanded(false); buttonRef.current?.focus({ preventScroll: true }); }
  useLayoutEffect(() => {
    if (!expanded) return;
    const panel = panelRef.current!, button = buttonRef.current!;
    const locate = () => {
      if (window.innerWidth < 768) { close(); return; }
      const rail = button.closest(".col-right") ?? button;
      const left = rail.getBoundingClientRect().left - 8 - panel.getBoundingClientRect().width;
      const top = Math.max(8, Math.min(button.getBoundingClientRect().top, window.innerHeight - panel.getBoundingClientRect().height - 8));
      setPosition(old => old.left === left && old.top === top ? old : { left, top });
    };
    locate();
    panel.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(locate);
    observer?.observe(panel); observer?.observe(button);
    const outside = (event: MouseEvent) => {
      if (panel.contains(event.target as Node) || button.closest(".reader-tool-rail")?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    window.addEventListener("resize", locate);
    window.addEventListener("scroll", locate, true);
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", keydown, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", locate); window.removeEventListener("scroll", locate, true);
      document.removeEventListener("click", outside, true); document.removeEventListener("keydown", keydown, true); };
  }, [expanded]);
  useEffect(() => {
    if (state !== "confirm" && state !== "cleared" && state !== "failed") return;
    const timer = window.setTimeout(() => setState("idle"), state === "confirm" ? CONFIRM_MS : RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  async function clear() {
    if (state === "idle") { setState("confirm"); return; }
    if (state !== "confirm") return;
    setState((await clearAllGlossCache()) ? "cleared" : "failed");
  }
  const label = state === "confirm" ? "确认清除？" : "清除自动缓存";
  const result = state === "cleared" ? "已清除" : state === "failed" ? "清除失败" : null;
  return <>
    <div className="reader-tool-rail" data-reader-settings>
      <button ref={buttonRef} type="button" className="reader-tool settings-typography-toggle" aria-label="阅读排版"
        aria-expanded={expanded} aria-controls={typographyId} onClick={() => expanded ? close() : setExpanded(true)}>
        <span className="reader-tool-aa" aria-hidden="true">Aa</span><span>排版</span>
      </button>
      <button type="button" className="reader-tool reader-appearance-cycle" aria-label={`外观：${appearanceName}，点击切换`}
        onClick={() => setReaderAppearance(APPEARANCE_OPTIONS[(APPEARANCE_OPTIONS.findIndex(option => option.value === appearance) + 1) % APPEARANCE_OPTIONS.length].value)}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          {effective === "dark" ? <path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>}
        </svg><span>{appearanceName}</span>
      </button>
      <div className="reader-tool reader-paper-options" role="group" aria-label="底色" hidden={effective === "dark"}>
        {THEME_OPTIONS.map(option => <button key={option.value} type="button" className="reader-tool-swatch"
          data-reader-theme={option.value} aria-label={option.label} aria-pressed={theme === option.value}
          style={{ backgroundColor: `var(--swatch-${option.value})` }} onClick={() => setReaderTheme(option.value)} />)}
        <span>{themeName}</span>
      </div>
      <button type="button" className="reader-tool reader-shape-cycle" aria-label={`白话显示形态：${glossShape === "inline" ? "小字" : "气泡"}，点击切换`}
        onClick={() => onGlossShapeChange(glossShape === "inline" ? "bubble" : "inline")}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 5h18M3 12h18M3 19h18" /></svg>
        <span>{glossShape === "inline" ? "小字" : "气泡"}</span>
      </button>
    </div>
    {expanded && createPortal(<div ref={panelRef} id={typographyId} className="reader-typography-popover" data-reader-settings
      role="dialog" aria-labelledby={`${typographyId}-title`} style={position}>
      <div className="reader-popover-header"><h2 id={`${typographyId}-title`} tabIndex={-1}>阅读排版</h2>
        <button type="button" className="reader-typography-reset" onClick={() => onTypographyChange({ ...DEFAULT_READER_TYPOGRAPHY }, true)}>恢复推荐值</button></div>
      <ReaderTypographyControls value={typography} onChange={onTypographyChange} onGestureStart={onTypographyGestureStart}
        onGestureEnd={onTypographyGestureEnd} hideReset />
      <div className="settings-cache-action"><span>白话缓存只存在本机</span>
        <button type="button" className="settings-cache-button" onClick={() => void clear()}>{label}</button>
        {result && <span className="settings-cache-result" role="status">{result}</span>}
      </div>
    </div>, document.body)}
  </>;
}

export function ReaderAppearanceControls() {
  const id = useId();
  const appearance = useSyncExternalStore(subscribeReaderTheme, readerAppearanceSnapshot, () => "system");
  return <fieldset className="reader-theme-options reader-appearance-options" data-reader-settings>
    <legend>外观</legend>
    {APPEARANCE_OPTIONS.map(option => <label key={option.value}>
      <input type="radio" name={`${id}-appearance`} data-reader-appearance={option.value} value={option.value}
        checked={appearance === option.value} onChange={() => setReaderAppearance(option.value)} />{option.label}
    </label>)}
  </fieldset>;
}

export function ReaderThemeControls() {
  const id = useId();
  const theme = useSyncExternalStore(subscribeReaderTheme, readerThemeSnapshot, () => "parchment");
  const effective = useSyncExternalStore(subscribeReaderTheme, effectiveThemeSnapshot, () => "parchment");
  return <fieldset className="reader-theme-options reader-paper-options" hidden={effective === "dark"} data-reader-settings>
    <legend>底色</legend>
    {THEME_OPTIONS.map(option => <label key={option.value}>
      <input type="radio" name={`${id}-theme`} data-reader-theme={option.value} value={option.value}
        checked={theme === option.value} onChange={() => setReaderTheme(option.value)} />
      <span className="reader-theme-swatch" aria-hidden="true" style={{ backgroundColor: `var(--swatch-${option.value})` }} />{option.label}
    </label>)}
  </fieldset>;
}

/** One control set for the desktop disclosure and the nonmodal mobile sheet. */
export function ReaderTypographyControls({ value, onChange, mobile = false, hideReset = false, onGestureStart, onGestureEnd }: {
  value: ReaderTypography; onChange: (value: ReaderTypography, discrete?: boolean) => void; mobile?: boolean; hideReset?: boolean;
  onGestureStart?: () => void; onGestureEnd?: () => void;
}) {
  const id = useId();
  return <div className="reader-typography-controls" data-reader-settings>
    {(Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]).filter(key => !mobile || key !== "lineChars").map(key => {
      const r = TYPOGRAPHY_RANGES[key], rangeId = `${id}-${key}`, helpId = `${rangeId}-help`;
      const start = (r.recommended[0] - r.min) / (r.max - r.min) * 100;
      const end = (r.recommended[1] - r.min) / (r.max - r.min) * 100;
      return <div className="reader-typography-field" key={key}>
        <label htmlFor={rangeId}>{r.label}<output htmlFor={rangeId}>{value[key]}{r.unit}</output></label>
        <input id={rangeId} data-typography={key} type="range" min={r.min} max={r.max} step={r.step} value={value[key]}
          aria-describedby={helpId} aria-valuetext={`${value[key]}${r.unit}`}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); onGestureStart?.(); }}
          onPointerUp={onGestureEnd} onPointerCancel={onGestureEnd}
          onChange={event => onChange({ ...value, [key]: Number(event.currentTarget.value) })} />
        <div className="reader-recommended-band" aria-hidden="true" style={{ "--band-start": `${start}%`, "--band-end": `${end}%` } as CSSProperties} />
        <span id={helpId} className="reader-sr-only">推荐 {r.recommended[0]} 至 {r.recommended[1]}{r.unit}</span>
      </div>;
    })}
    {([['bodyFont', '正文字体'], ['glossFont', '白话字体']] as const).map(([key, label]) =>
      <fieldset className="reader-font-options" key={key}><legend>{label}</legend>
        {([['sans', '黑体'], ['serif', '宋体']] as const).map(([font, name]) => <label key={font}>
          <input type="radio" name={`${id}-${key}`} data-typography={key} value={font} checked={value[key] === font}
            onChange={() => onChange({ ...value, [key]: font }, true)} />{name}
        </label>)}
      </fieldset>)}
    {!hideReset && <button type="button" className="reader-typography-reset" onClick={() => onChange({ ...DEFAULT_READER_TYPOGRAPHY }, true)}>恢复推荐值</button>}
  </div>;
}
