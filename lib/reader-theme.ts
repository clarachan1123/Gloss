export const READER_THEME_KEY = "gloss:settings:theme";
export const READER_APPEARANCE_KEY = "gloss:settings:appearance";
export const READER_THEMES = ["parchment", "moon-white", "eye-green"] as const;
export type ReaderTheme = (typeof READER_THEMES)[number];
export const READER_APPEARANCES = ["system", "light", "dark"] as const;
export type ReaderAppearance = (typeof READER_APPEARANCES)[number];
export type EffectiveTheme = ReaderTheme | "dark";
export const THEME_OPTIONS = [
  { value: "parchment", label: "羊皮纸" },
  { value: "moon-white", label: "月白" },
  { value: "eye-green", label: "护眼绿" },
] as const;
export const APPEARANCE_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;
export function validateReaderTheme(value: unknown): ReaderTheme {
  return READER_THEMES.includes(value as ReaderTheme) ? value as ReaderTheme : "parchment";
}
export function validateReaderAppearance(value: unknown): ReaderAppearance {
  return READER_APPEARANCES.includes(value as ReaderAppearance) ? value as ReaderAppearance : "system";
}
function readPreference(key: string): unknown {
  try { return globalThis.localStorage.getItem(key); } catch { return null; }
}
export function readReaderTheme(): ReaderTheme { return validateReaderTheme(readPreference(READER_THEME_KEY)); }
export function readReaderAppearance(): ReaderAppearance { return validateReaderAppearance(readPreference(READER_APPEARANCE_KEY)); }
export function resolveReaderTheme(appearance: ReaderAppearance, theme: ReaderTheme, systemDark: boolean): EffectiveTheme {
  return appearance === "dark" || appearance === "system" && systemDark ? "dark" : theme;
}
function systemIsDark(): boolean { return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches; }
export function readerThemeSnapshot(): ReaderTheme { return readReaderTheme(); }
export function readerAppearanceSnapshot(): ReaderAppearance { return readReaderAppearance(); }
export function effectiveThemeSnapshot(): EffectiveTheme { return resolveReaderTheme(readReaderAppearance(), readReaderTheme(), systemIsDark()); }
const listeners = new Set<() => void>();
export function subscribeReaderTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function writePreference(key: string, value: string): void {
  try { globalThis.localStorage.setItem(key, value); }
  catch { try { globalThis.localStorage.removeItem(key); } catch { /* Storage may be fully denied. */ } }
}
export function setReaderTheme(value: unknown): ReaderTheme {
  writePreference(READER_THEME_KEY, validateReaderTheme(value));
  window.dispatchEvent(new Event("gloss:theme-change"));
  return readReaderTheme();
}
export function setReaderAppearance(value: unknown): ReaderAppearance {
  writePreference(READER_APPEARANCE_KEY, validateReaderAppearance(value));
  window.dispatchEvent(new Event("gloss:appearance-change"));
  return readReaderAppearance();
}
/** Only the root ThemeController owns browser subscriptions and writes the effective theme. */
export function startReaderThemeSync(): () => void {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const sync = (transition: boolean) => {
    const root = document.documentElement;
    const next = resolveReaderTheme(readReaderAppearance(), readReaderTheme(), !!media?.matches);
    if (next !== root.dataset.theme) {
      if (transition) { root.dataset.themeTransition = ""; void root.offsetWidth; }
      root.dataset.theme = next;
    }
    listeners.forEach(listener => listener());
  };
  const changed = () => sync(true);
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === READER_THEME_KEY || event.key === READER_APPEARANCE_KEY) changed();
  };
  window.addEventListener("gloss:theme-change", changed);
  window.addEventListener("gloss:appearance-change", changed);
  window.addEventListener("storage", storage);
  media?.addEventListener("change", changed);
  sync(false);
  return () => {
    window.removeEventListener("gloss:theme-change", changed);
    window.removeEventListener("gloss:appearance-change", changed);
    window.removeEventListener("storage", storage);
    media?.removeEventListener("change", changed);
  };
}
// Independent storage reads preserve the system decision even when either key is denied.
export const READER_THEME_BOOTSTRAP = `(function(){var r=document.documentElement,t=null,a=null;try{t=localStorage.getItem(${JSON.stringify(READER_THEME_KEY)})}catch(e){}try{a=localStorage.getItem(${JSON.stringify(READER_APPEARANCE_KEY)})}catch(e){}t=${JSON.stringify(READER_THEMES)}.includes(t)?t:"parchment";a=${JSON.stringify(READER_APPEARANCES)}.includes(a)?a:"system";var d=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);r.dataset.theme=a==="dark"||a==="system"&&d?"dark":t})()`;
