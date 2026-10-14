/** Browser-wide reader preferences; document and saved-gloss formats are independent. */
export const READER_TYPOGRAPHY_KEY = "gloss:settings:reader-typography";
export type ReaderFont = "sans" | "serif";
export interface ReaderTypography {
  version: 1;
  fontSize: number;
  lineHeight: number;
  lineChars: number;
  bodyFont: ReaderFont;
  glossFont: ReaderFont;
}
export const DEFAULT_READER_TYPOGRAPHY: Readonly<ReaderTypography> = Object.freeze({
  version: 1, fontSize: 17.5, lineHeight: 1.75, lineChars: 32, bodyFont: "sans", glossFont: "serif",
});
export const TYPOGRAPHY_RANGES = {
  fontSize: { min: 15, max: 21, step: 0.5, recommended: [17, 18], label: "字号", unit: "px" },
  lineHeight: { min: 1.5, max: 2.1, step: 0.05, recommended: [1.7, 1.8], label: "行高", unit: "" },
  lineChars: { min: 20, max: 45, step: 1, recommended: [25, 40], label: "每行字数", unit: "字" },
} as const;
function onStep(value: unknown, min: number, max: number, step: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max &&
    Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-9;
}
export function validateReaderTypography(value: unknown): ReaderTypography {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_READER_TYPOGRAPHY };
  const v = value as Record<string, unknown>;
  const valid = v.version === 1 && Object.entries(TYPOGRAPHY_RANGES).every(([key, r]) => onStep(v[key], r.min, r.max, r.step)) &&
    (v.bodyFont === "sans" || v.bodyFont === "serif") && (v.glossFont === "sans" || v.glossFont === "serif");
  return valid ? { version: 1, fontSize: v.fontSize as number, lineHeight: v.lineHeight as number,
    lineChars: v.lineChars as number, bodyFont: v.bodyFont as ReaderFont, glossFont: v.glossFont as ReaderFont } : { ...DEFAULT_READER_TYPOGRAPHY };
}
export function readReaderTypography(): ReaderTypography {
  try { return validateReaderTypography(JSON.parse(globalThis.localStorage?.getItem(READER_TYPOGRAPHY_KEY) ?? "null")); }
  catch { return { ...DEFAULT_READER_TYPOGRAPHY }; }
}
export function writeReaderTypography(value: ReaderTypography): void {
  try { globalThis.localStorage?.setItem(READER_TYPOGRAPHY_KEY, JSON.stringify(validateReaderTypography(value))); }
  catch { /* A denied/full store must not interrupt this reading session. */ }
}
