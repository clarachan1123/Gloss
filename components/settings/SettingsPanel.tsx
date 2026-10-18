import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { clearAllGlossCache } from "@/lib/cache";
import { DEFAULT_READER_TYPOGRAPHY, TYPOGRAPHY_RANGES, type ReaderTypography } from "@/lib/reader-typography";
import { THEME_OPTIONS, APPEARANCE_OPTIONS, readerThemeSnapshot, readerAppearanceSnapshot, effectiveThemeSnapshot, setReaderTheme, setReaderAppearance, subscribeReaderTheme } from "@/lib/reader-theme";

const SETTINGS = ["呈现模式", "导出形态"];
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
  const [state, setState] = useState<"idle" | "confirm" | "cleared" | "failed">("idle");

  useEffect(() => {
    if (state !== "confirm" && state !== "cleared" && state !== "failed") return;
    const timer = window.setTimeout(() => setState("idle"), state === "confirm" ? CONFIRM_MS : RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function clear() {
    if (state === "idle") {
      setState("confirm");
      return;
    }
    if (state !== "confirm") return;
    setState((await clearAllGlossCache()) ? "cleared" : "failed");
  }

  const label = state === "confirm" ? "确认清除？" : "清除自动缓存";
  const result = state === "cleared" ? "已清除" : state === "failed" ? "清除失败" : null;

  return (
    <>
      <h2 id="settings-title" className="side-title">
        设置
      </h2>
      <ul className="settings-skeleton">
        <li className="settings-saved-shape">
          <span>白话显示形态</span>
          <div role="group" aria-label="白话显示形态">
            <button type="button" aria-pressed={glossShape === "inline"} onClick={() => onGlossShapeChange("inline")}>
              inline 小字
            </button>
            <button type="button" aria-pressed={glossShape === "bubble"} onClick={() => onGlossShapeChange("bubble")}>
              气泡
            </button>
          </div>
        </li>
        <li className="settings-typography" data-reader-settings>
          <button type="button" className="settings-typography-toggle" aria-expanded={expanded}
            aria-controls={typographyId} onClick={() => setExpanded(!expanded)}>
            阅读排版 <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
          {expanded && <div id={typographyId}><ReaderTypographyControls value={typography} onChange={onTypographyChange}
            onGestureStart={onTypographyGestureStart} onGestureEnd={onTypographyGestureEnd} /></div>}
        </li>
        <li className="settings-appearance" data-reader-settings><ReaderAppearanceControls /></li>
        <li className="settings-theme" data-reader-settings><ReaderThemeControls /></li>
        {SETTINGS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="settings-cache-action">
        <button type="button" className="settings-cache-button" onClick={() => void clear()}>
          {label}
        </button>
        {result && <span className="settings-cache-result" role="status">{result}</span>}
      </div>
    </>
  );
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
export function ReaderTypographyControls({ value, onChange, mobile = false, onGestureStart, onGestureEnd }: {
  value: ReaderTypography; onChange: (value: ReaderTypography, discrete?: boolean) => void; mobile?: boolean;
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
    <button type="button" className="reader-typography-reset" onClick={() => onChange({ ...DEFAULT_READER_TYPOGRAPHY }, true)}>恢复推荐值</button>
  </div>;
}
