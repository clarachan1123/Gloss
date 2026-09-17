import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 三套主题的对比度（G-08 验收：术语色在三套主题下均达 WCAG AA）。
 *
 * 直接读 styles/tokens.css 的色值，按 WCAG 2.1 的相对亮度公式算对比度：
 * 颜色一改，这个测试立刻失败，不依赖浏览器、不依赖模型。
 *
 * 阈值 4.5:1 用的是正文标准，不是大字号的 3:1——术语与正文同字号（16.5px），
 * 按 WCAG 的定义（< 18.66px 粗体 / < 24px 常规）属于正文。
 */

const AA_NORMAL_TEXT = 4.5;

const CSS = readFileSync(path.resolve(__dirname, "../styles/tokens.css"), "utf8");

type Token = "--paper-main" | "--paper-side" | "--ink" | "--gloss" | "--term";

/** 从 tokens.css 里取某套主题的色值。主题块按 [data-theme="…"] 分段 */
function themeColors(theme: string): Record<Token, string> {
  const start = CSS.indexOf(`[data-theme="${theme}"]`);
  if (start < 0) throw new Error(`tokens.css 里没有主题 ${theme}`);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const read = (token: Token) => {
    const m = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(block);
    if (!m) throw new Error(`主题 ${theme} 缺少 ${token}`);
    return m[1];
  };
  return {
    "--paper-main": read("--paper-main"),
    "--paper-side": read("--paper-side"),
    "--ink": read("--ink"),
    "--gloss": read("--gloss"),
    "--term": read("--term"),
  };
}

/** WCAG 2.1 相对亮度 */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = ["parchment", "moon-white", "eye-green"] as const;

describe("三套主题的对比度", () => {
  it.each(THEMES)("%s：术语色在中栏底色上达 WCAG AA（≥ 4.5:1）", (theme) => {
    const c = themeColors(theme);
    expect(contrast(c["--term"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each(THEMES)("%s：正文墨色与白话色也达 AA（术语不是唯一要读的字）", (theme) => {
    const c = themeColors(theme);
    expect(contrast(c["--ink"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(c["--gloss"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * 「术语色 vs 白话正文色」不是 WCAG 项：两者都是文字，WCAG 不约束文字之间的对比。
   * 但如果这两个颜色太接近，标记等于没做。这里只记录数字不做断言，最终由 Clara 肉眼在三套主题下确认。
   */
  it("记录：术语色与白话正文色的差异", () => {
    const rows = THEMES.map((theme) => {
      const c = themeColors(theme);
      const pair = (a: Token, b: Token) => contrast(c[a], c[b]).toFixed(2);
      return (
        `${theme.padEnd(11)} 术语 ${c["--term"]} 底 ${c["--paper-main"]}` +
        ` | 术语vs底 ${pair("--term", "--paper-main")}` +
        ` | 白话vs底 ${pair("--gloss", "--paper-main")}` +
        ` | 正文vs底 ${pair("--ink", "--paper-main")}` +
        ` | 术语vs白话 ${pair("--term", "--gloss")}`
      );
    });
    expect(rows).toHaveLength(3);
    console.log(rows.join("\n"));
  });
});
