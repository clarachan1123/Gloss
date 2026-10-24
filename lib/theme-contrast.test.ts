import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 三套主题的对比度（G-08 验收：术语色在三套主题下均达 WCAG AA）。
 *
 * 直接读 styles/tokens.css 的色值，按 WCAG 2.1 的相对亮度公式算对比度：
 * 颜色一改，这个测试立刻失败，不依赖浏览器、不依赖模型。
 *
 * 阈值 4.5:1 用的是正文标准，不是大字号的 3:1——术语与正文同字号（17.5px），
 * 按 WCAG 的定义（< 18.66px 粗体 / < 24px 常规）属于正文。
 */

const AA_NORMAL_TEXT = 4.5;

const CSS = readFileSync(path.resolve(__dirname, "../styles/tokens.css"), "utf8");

type Token = "--selection-bg" | "--selection-start-bg" | "--tool-active-bg" | "--text-body" | "--paper-main" | "--paper-side" | "--ink" | "--gloss" | "--saved-inline" | "--term" | "--hover" | "--sentence-active-bg";

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
    "--selection-bg": read("--selection-bg"),
    "--selection-start-bg": read("--selection-start-bg"),
    "--tool-active-bg": read("--tool-active-bg"),
    "--paper-main": read("--paper-main"),
    "--paper-side": read("--paper-side"),
    "--ink": read("--ink"),
    "--text-body": read("--text-body"),
    "--gloss": read("--gloss"),
    "--saved-inline": read("--saved-inline"),
    "--term": read("--term"),
    "--hover": read("--hover"),
    "--sentence-active-bg": read("--sentence-active-bg"),
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

/**
 * CIEDE2000 色差：把色相也算进去（对比度只看亮度）。
 * 用来保证原句悬停色和术语色拉得开——悬停的原句不能看起来像被标了术语。
 */
function toLab(hex: string): [number, number, number] {
  const lin = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(0), lin(1), lin(2)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const Y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const Z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

export function deltaE00(hex1: string, hex2: string): number {
  const [L1, a1, b1] = toLab(hex1);
  const [L2, a2, b2] = toLab(hex2);
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * deg + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * deg + 360) % 360;
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm += h1p + h2p < 360 ? 360 : -360;
    hpm /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hpm - 30) * rad) +
    0.24 * Math.cos(2 * hpm * rad) +
    0.32 * Math.cos((3 * hpm + 6) * rad) -
    0.2 * Math.cos((4 * hpm - 63) * rad);
  const SL = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const SC = 1 + 0.045 * Cpm;
  const SH = 1 + 0.015 * Cpm * T;
  const RT = -2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hpm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

/** 悬停色与术语色至少要差这么多（2026-09-18 选悬停色时的约束） */
const MIN_HOVER_TERM_DELTA_E = 10;

const LIGHT_THEMES = ["parchment", "moon-white", "eye-green"];
const THEMES = [...LIGHT_THEMES, "dark"] as const;

describe("三套主题的对比度", () => {
  it.each(THEMES)("%s：G-66 正文与底色对比度在 [7, 12]", (theme) => {
    const c = themeColors(theme);
    const ratio = contrast(c["--text-body"], c["--paper-main"]);
    expect(ratio).toBeGreaterThanOrEqual(7);
    expect(ratio).toBeLessThanOrEqual(12);
    console.log(JSON.stringify({ theme, textBodyContrast: ratio }));
  });

  it.each(THEMES)("%s：术语色在中栏底色上达 WCAG AA（≥ 4.5:1）", (theme) => {
    const c = themeColors(theme);
    expect(contrast(c["--term"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each(THEMES)("%s：原句悬停色落在正文上，同样达 WCAG AA（≥ 4.5:1）", (theme) => {
    const c = themeColors(theme);
    expect(contrast(c["--hover"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each(THEMES)("%s：悬停色与术语色色差 ≥ 10，悬停的原句不会看起来像被标了术语", (theme) => {
    const c = themeColors(theme);
    expect(deltaE00(c["--hover"], c["--term"])).toBeGreaterThanOrEqual(MIN_HOVER_TERM_DELTA_E);
  });

  it.each(LIGHT_THEMES)("%s：悬停色比正文墨色更显眼（色差大于换色前的悬停色）", (theme) => {
    const c = themeColors(theme);
    // 换色前的悬停色（羊皮纸 / 月白 #3F4B53，护眼绿 #37505A）与墨色的色差约 14.5–15.1；C 档要比它大
    const before = theme === "eye-green" ? "#37505A" : "#3F4B53";
    expect(deltaE00(c["--hover"], c["--text-body"])).toBeGreaterThan(deltaE00(before, c["--text-body"]));
  });

  it("色差计算与已知值一致（换色前的月白悬停色 vs 墨色 ≈ 14.5）", () => {
    expect(deltaE00("#3F4B53", "#212121")).toBeCloseTo(14.5, 1);
    expect(deltaE00("#212121", "#212121")).toBe(0);
  });

  it.each(THEMES)("%s：14px 临时撑开区白话 --gloss 在中栏底色上达 WCAG AA（≥ 4.5:1）", (theme) => {
    const c = themeColors(theme);
    expect(contrast(c["--ink"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(c["--gloss"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each(THEMES)("%s：14px inline 保存白话在中栏底色上达 WCAG AA（≥ 4.5:1）", (theme) => {
    const c = themeColors(theme);
    expect(contrast(c["--saved-inline"], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
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
    expect(rows).toHaveLength(4);
    console.log(rows.join("\n"));
  });
});

describe("G-13 书架色板对比度", () => {
  const books = Array.from({ length: 11 }, (_, index) => {
    const match = new RegExp(`--shelf-book-${index}:\\s*(#[0-9A-Fa-f]{6})`).exec(CSS);
    if (!match) throw new Error(`缺少书色 ${index}`);
    return match[1];
  });
  const inkOnDark = /--shelf-ink-on-dark:\s*(#[0-9A-Fa-f]{6})/.exec(CSS)?.[1] ?? "";
  const inkOnDarkMuted = /--shelf-ink-on-dark-muted:\s*(#[0-9A-Fa-f]{6})/.exec(CSS)?.[1] ?? "";
  const cover = /--shelf-cover:\s*(#[0-9A-Fa-f]{6})/.exec(CSS)?.[1] ?? "";
  const mix = (paper: string, book: string) => {
    const channels = [0, 1, 2].map((i) => Math.round(parseInt(paper.slice(1 + i * 2, 3 + i * 2), 16) * .94 + parseInt(book.slice(1 + i * 2, 3 + i * 2), 16) * .06));
    return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  };

  it.each(THEMES)("%s：每个书色混入页面背景后，正文与次级字均达 AA", (theme) => {
    const c = themeColors(theme);
    for (const book of books) {
      const background = mix(c["--paper-main"], book);
      expect(contrast(c["--ink"], background)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrast(c["--gloss"], background)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it("每个书脊与书名、导入年月、选中封面与封面字均达 AA", () => {
    for (const book of books) expect(contrast(book, inkOnDark)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    for (const book of books) expect(contrast(book, inkOnDarkMuted)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(cover, inkOnDark)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

/**
 * 标记的视觉只有颜色（2026-09-18 Clara 定）：不要底色、下划线、边框、图标。
 * white-space: nowrap 保留（整词不折行）。reader.css 里 .gloss-term 多一条别的属性，这里就失败。
 */
describe("术语标记只有颜色", () => {
  const READER = readFileSync(path.resolve(__dirname, "../styles/reader.css"), "utf8");

  it(".gloss-term 只有 color 与 white-space: nowrap 两条声明", () => {
    const m = /\.gloss-term\s*\{([^}]*)\}/.exec(READER);
    expect(m).not.toBeNull();
    const decls = m![1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => d.split(":")[0].trim());
    expect(decls.sort()).toEqual(["color", "white-space"]);
    expect(m![1]).toMatch(/color:\s*var\(--term\)/);
    expect(m![1]).toMatch(/white-space:\s*nowrap/);
  });

  it("reader.css 里只有一处给 .gloss-term 定样式（没有别处偷偷加底色）", () => {
    expect(READER.match(/\.gloss-term\b/g)).toHaveLength(1);
  });

  it("示例句呼吸期间关闭自身颜色过渡", () => {
    const rule = /\.reader-body-sample-breathing\s+\.sentence-breathe\s*\{([^}]*)\}/.exec(READER);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|;)\s*transition:\s*none\s*;/);
  });
});

describe("G-60b 实心反馈按钮配色", () => {
  it.each(THEMES)("%s：正常态纸色字对墨色底 >= 4.5", theme => {
    const c = themeColors(theme);
    expect(contrast(c["--paper-main"], c["--ink"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
  it.each(THEMES)("%s：悬停态纸色字对白话色底 >= 4.5", theme => {
    const c = themeColors(theme);
    expect(contrast(c["--paper-main"], c["--gloss"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe("G-19 完整主题", () => {
  it.each(THEMES)("%s：所有阅读文字角色在实际纸色上达 AA，中栏最亮", theme => {
    const c = themeColors(theme);
    for (const role of ["--text-body", "--ink", "--gloss", "--saved-inline", "--term", "--hover"] as const)
      expect(contrast(c[role], c["--paper-main"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    for (const role of ["--ink", "--gloss", "--hover"] as const)
      expect(contrast(c[role], c["--paper-side"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    if (theme === "dark") expect(luminance(c["--paper-main"])).toBeLessThan(luminance(c["--paper-side"]));
    else expect(luminance(c["--paper-main"])).toBeGreaterThan(luminance(c["--paper-side"]));
  });
  it.each(THEMES)("%s：层板五项均在本主题定义", theme => {
    const start = CSS.indexOf(`[data-theme="${theme}"]`), block = CSS.slice(start, CSS.indexOf("}", start));
    for (const part of ["top", "mid", "bottom", "edge", "shadow"])
      expect(block).toMatch(new RegExp(`--shelf-ledge-${part}:\\s*#[0-9a-fA-F]{6};`));
  });
});


describe("G-69 活动原句配色", () => {
  const backgrounds = { parchment: "#E7E9E6", "moon-white": "#E4E8ED", "eye-green": "#DCE4E0", dark: "#252524" };
  it.each(THEMES)("%s：指定底色与悬停字色达到 AA", (theme) => {
    const c = themeColors(theme);
    expect(c["--sentence-active-bg"]).toBe(backgrounds[theme as keyof typeof backgrounds]);
    expect(contrast(c["--hover"], c["--sentence-active-bg"])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
  it("默认羊皮纸、继承属性注册及主题过渡均覆盖新 token", () => {
    expect(CSS).toMatch(/:root,\s*\[data-theme="parchment"\]/);
    expect(CSS).toContain('@property --sentence-active-bg { syntax: "<color>"; inherits: true; initial-value: #E7E9E6; }');
    expect(CSS.slice(CSS.indexOf("html[data-theme-transition]"))).toMatch(/transition-property:[^;]*--sentence-active-bg/);
  });
});

describe("G-64a 划选颜色对比度", () => {
  for (const theme of ["parchment", "moon-white", "eye-green", "dark"]) {
    it(theme, () => { const c = themeColors(theme); for (const [fg,bg] of [["--text-body","--selection-bg"],["--text-body","--selection-start-bg"],["--ink","--tool-active-bg"]] as const) expect(contrast(c[fg],c[bg])).toBeGreaterThanOrEqual(4.5); });
  }
});
