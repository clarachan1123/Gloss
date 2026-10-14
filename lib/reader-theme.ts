export const READER_THEME_KEY = "gloss:settings:theme";
export const READER_THEMES = ["parchment", "moon-white", "eye-green"] as const;
export type ReaderTheme = (typeof READER_THEMES)[number];
export const THEME_OPTIONS = [
  { value: "parchment", label: "羊皮纸", paper: "#F8F6F0" },
  { value: "moon-white", label: "月白", paper: "#F5F5F7" },
  { value: "eye-green", label: "护眼绿", paper: "#EDF2EA" },
] as const;
export function validateReaderTheme(value: unknown): ReaderTheme {
  return READER_THEMES.includes(value as ReaderTheme) ? value as ReaderTheme : "parchment";
}
export function readReaderTheme(): ReaderTheme {
  try { return validateReaderTheme(globalThis.localStorage.getItem(READER_THEME_KEY)); }
  catch { return "parchment"; }
}
export function readerThemeSnapshot(): ReaderTheme {
  return typeof document === "undefined" ? "parchment" : validateReaderTheme(document.documentElement.dataset.theme);
}
export function setReaderTheme(value: unknown): ReaderTheme {
  let theme = validateReaderTheme(value);
  try { globalThis.localStorage.setItem(READER_THEME_KEY, theme); }
  catch { theme = "parchment"; try { globalThis.localStorage.removeItem(READER_THEME_KEY); } catch { /* Storage may be fully denied. */ } }
  const root = document.documentElement;
  root.dataset.themeTransition = "";
  void root.offsetWidth;
  root.dataset.theme = theme;
  window.dispatchEvent(new Event("gloss:theme-change"));
  return theme;
}
export function subscribeReaderTheme(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key !== READER_THEME_KEY && event.key !== null) return;
    document.documentElement.dataset.theme = readReaderTheme();
    listener();
  };
  window.addEventListener("gloss:theme-change", listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener("gloss:theme-change", listener); window.removeEventListener("storage", storage); };
}
// Runs synchronously in head during HTML parsing; no transition on the first paint.
export const READER_THEME_BOOTSTRAP = `(function(){var r=document.documentElement;try{var t=localStorage.getItem(${JSON.stringify(READER_THEME_KEY)});r.dataset.theme=${JSON.stringify(READER_THEMES)}.includes(t)?t:"parchment"}catch(e){r.dataset.theme="parchment"}})()`;
