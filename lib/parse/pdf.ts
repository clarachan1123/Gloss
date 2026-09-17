import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import {
  ParseError,
  assembleDocument,
  countChars,
  type ParsedDocument,
  type WarningCode,
} from "./validate";

/**
 * 文字层 PDF 解析（G-02B）。全部在浏览器内完成：pdf.js 与 worker 随站点打包，
 * cMap 字符映射表从本站 /pdfjs/<版本号>/cmaps/ 读取（scripts/copy-pdfjs-assets.mjs 生成），
 * 不请求任何第三方地址，文件内容不离开本页。
 *
 * 流程：逐页取文字与图片 → 判定扫描页（A5 / A6）→ 乱码检查 → 去页眉页脚 → 行拼成段落。
 *
 * 阈值（依据 2026-09-17 的 5 份样本，逐页数据见 KANBAN G-02B）：
 * - 扫描页 = 字数 < SCAN_PAGE_MAX_CHARS 且 最大一张图片面积 ≥ SCAN_PAGE_MIN_IMAGE_COVERAGE。
 *   样本中扫描页 0 字、图片占 44.5%–62.7%；双层 PDF（扫描图 + 文字层）每页 ≥ 420 字，不会误判；
 *   没有图片的文字页最少 14 字，因为无图也不会误判。
 * - 兜底：没有任何一页被判成扫描页，但全书平均每页字数 < SPARSE_DOC_MAX_CHARS_PER_PAGE → A5。
 *   覆盖 JPX / JBIG2 图片识别不出来（wasm 未托管）的扫描书，以及 0 字、无图的 PDF。
 * - 乱码：无法识别的字符超过非空白字符的 GARBLED_RATIO_THRESHOLD → 阻断。未经样本校准（样本全部 0%）。
 */

/** 单页字数低于此值（且有大图）才可能是扫描页。样本扫描页均为 0 字，留出页码等零碎文字的余量 */
export const SCAN_PAGE_MAX_CHARS = 20;
/** 单页最大一张图片占页面面积的比例达到此值才算扫描页。样本扫描页最低 44.5%，排除小图标、小插图 */
export const SCAN_PAGE_MIN_IMAGE_COVERAGE = 0.3;
/** 兜底：全书平均每页字数低于此值直接判为扫描件（仅在没有任何一页被判成扫描页时生效） */
export const SPARSE_DOC_MAX_CHARS_PER_PAGE = 20;
/** 乱码字符占比超过此值阻断。暂定值，未经样本校准 */
export const GARBLED_RATIO_THRESHOLD = 0.05;
/** 页顶 / 页底同一行至少在这么多页出现，才当作页眉页脚去掉 */
export const REPEATED_EDGE_MIN_PAGES = 3;

/** 一行文字及其位置（PDF 坐标，y 向上增大） */
export interface PdfLine {
  text: string;
  /** 行首横坐标 */
  x: number;
  /** 行末横坐标 */
  right: number;
  /** 基线纵坐标 */
  y: number;
  /** 字号 */
  size: number;
}

export interface PdfPageData {
  /** 按 pdf.js 给出的内容顺序 */
  lines: PdfLine[];
  charCount: number;
  /** 最大一张图片占页面面积的比例，0–1。字数不少的页不计算，记 0 */
  imageCoverage: number;
}

export interface PdfParseResult {
  doc: ParsedDocument;
  /** A6（及后续 checkParsed 的 A9 由调用方合并） */
  warnings: WarningCode[];
  /** 被跳过的扫描页，从 1 起 */
  skippedPages: number[];
}

/* ---------------- 浏览器入口 ---------------- */

type PdfjsModule = typeof import("pdfjs-dist");

export async function parsePdf(file: File): Promise<PdfParseResult> {
  let pdfjs: PdfjsModule;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    // 组件没加载下来（通常是断网），不是文件的问题
    throw new ParseError("LOAD");
  }

  let worker: Worker;
  try {
    // 由打包器把 worker 作为独立文件随站点发布，不走 CDN
    worker = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), {
      type: "module",
    });
  } catch {
    throw new ParseError("LOAD");
  }

  const cmap = { failed: false };
  // pdf.js 自己实例化这个类，传入 { cMapUrl, standardFontDataUrl, wasmUrl }。
  // 只托管了 cMap：标准字体和 wasm（JPX / JBIG2 图片解码）一律不请求，pdf.js 会自行降级。
  class LocalCMapFactory {
    private readonly cMapUrl: string | null;
    constructor({ cMapUrl = null }: { cMapUrl?: string | null }) {
      this.cMapUrl = cMapUrl;
    }
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      if (kind !== "cMapUrl" || !this.cMapUrl) throw new Error(`${kind} is not hosted`);
      try {
        const res = await fetch(`${this.cMapUrl}${filename}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        cmap.failed = true;
        throw err;
      }
    }
  }

  const port = pdfjs.PDFWorker.create({ port: worker, verbosity: pdfjs.VerbosityLevel.ERRORS });
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pages = await readPdfPages(pdfjs, {
      data,
      worker: port,
      cMapUrl: `/pdfjs/${pdfjs.version}/cmaps/`,
      cMapPacked: true,
      useWorkerFetch: false,
      BinaryDataFactory: LocalCMapFactory,
      // 只取文字，不往页面里注入字体
      disableFontFace: true,
    });
    // 缺 cMap 时 pdf.js 只丢字、不报错，会被误判成扫描件：按组件加载失败处理
    if (cmap.failed) throw new ParseError("LOAD");
    return buildPdfDocument(pages, file.name);
  } finally {
    port.destroy();
    worker.terminate();
  }
}

/* ---------------- 读取（浏览器与测试共用） ---------------- */

type GetDocumentParams = Parameters<PdfjsModule["getDocument"]>[0] & object;

/** 打开 PDF 并逐页取文字行与图片面积。加密 → A4，其他打不开 → A3 */
export async function readPdfPages(pdfjs: PdfjsModule, params: GetDocumentParams): Promise<PdfPageData[]> {
  const task = pdfjs.getDocument({ verbosity: pdfjs.VerbosityLevel.ERRORS, ...params });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    // 需要打开密码（不带密码时 code 为 NEED_PASSWORD）；只限制打印 / 复制的 PDF 不会走到这里
    if (err instanceof pdfjs.PasswordException) throw new ParseError("A4");
    throw new ParseError("A3");
  }

  try {
    const pages: PdfPageData[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = itemsToLines(content.items.filter((it): it is TextItem => "str" in it));
      const charCount = lines.reduce((sum, l) => sum + countChars(l.text), 0);
      // 只有字少的页才可能是扫描页，才需要看图片（取操作列表要解码图片，开销大）
      const imageCoverage = charCount < SCAN_PAGE_MAX_CHARS ? await maxImageCoverage(pdfjs, page) : 0;
      pages.push({ lines, charCount, imageCoverage });
      page.cleanup();
    }
    return pages;
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError("A3");
  } finally {
    await task.destroy();
  }
}

/** pdf.js 的文字片段按 hasEOL 拼成行，记下行首、行末、基线和字号 */
export function itemsToLines(items: TextItem[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let current: PdfLine | null = null;
  for (const item of items) {
    if (item.str.trim() !== "") {
      const [a, b, c, d, e, f] = item.transform as number[];
      const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height;
      if (!current) current = { text: "", x: e, right: e + item.width, y: f, size };
      current.x = Math.min(current.x, e);
      current.right = Math.max(current.right, e + item.width);
      current.size = Math.max(current.size, size);
    }
    if (current) current.text += item.str;
    if (item.hasEOL && current) {
      lines.push(current);
      current = null;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintInlineImageXObject",
  "paintImageMaskXObject",
  "paintImageXObjectRepeat",
  "paintInlineImageXObjectGroup",
  "paintImageMaskXObjectGroup",
  "paintImageMaskXObjectRepeat",
  "paintSolidColorImageMask",
] as const;

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: number[]): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * 最大一张图片占页面面积的比例。图片画在单位正方形上，经当前变换矩阵放大到页面，
 * 面积 = 矩阵行列式的绝对值。
 */
async function maxImageCoverage(pdfjs: PdfjsModule, page: PDFPageProxy): Promise<number> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS as unknown as Record<string, number>;
  const imageOps = new Set(IMAGE_OP_NAMES.map((name) => OPS[name]).filter((v) => v !== undefined));
  const [x0, y0, x1, y1] = page.view;
  const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let best = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (fn === OPS.paintFormXObjectBegin && Array.isArray(args?.[0]) && args[0].length === 6) {
        ctm = multiply(ctm, args[0]);
      }
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, args);
    } else if (imageOps.has(fn)) {
      best = Math.max(best, Math.min(1, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea));
    }
  }
  return best;
}

/* ---------------- 纯逻辑（不依赖 pdf.js） ---------------- */

export function isScannedPage(page: PdfPageData): boolean {
  return page.charCount < SCAN_PAGE_MAX_CHARS && page.imageCoverage >= SCAN_PAGE_MIN_IMAGE_COVERAGE;
}

/**
 * 判定顺序：
 * 1. 逐页判定扫描页。全部页都是 → A5；部分页是 → A6（跳过这些页，不阻断）。
 * 2. 没有任何一页被判成扫描页，但平均每页字数 < SPARSE_DOC_MAX_CHARS_PER_PAGE → A5。
 * 3. 保留页里乱码占比 > GARBLED_RATIO_THRESHOLD → GARBLED。
 * A7（0 字）/ A8（超字数）/ A9（非中文）由调用方的 checkParsed 统一处理。
 */
export function buildPdfDocument(pages: PdfPageData[], fileName: string | null): PdfParseResult {
  const scanned = pages.map(isScannedPage);
  const skippedPages = scanned.flatMap((s, i) => (s ? [i + 1] : []));
  if (pages.length === 0 || skippedPages.length === pages.length) throw new ParseError("A5");
  if (skippedPages.length === 0) {
    const total = pages.reduce((sum, p) => sum + p.charCount, 0);
    if (total / pages.length < SPARSE_DOC_MAX_CHARS_PER_PAGE) throw new ParseError("A5");
  }

  const kept = pages.map((p, i) => (scanned[i] ? null : p));
  const keptText = kept.flatMap((p) => p?.lines.map((l) => l.text) ?? []).join("");
  if (garbledRatio(keptText) > GARBLED_RATIO_THRESHOLD) throw new ParseError("GARBLED");

  const bodies = stripPageEdges(kept);
  const paragraphs = linesToParagraphs(bodies);
  return {
    doc: assembleDocument({ paragraphs, headings: [], footnotes: [] }, "pdf", fileName, pages.length),
    warnings: skippedPages.length > 0 ? ["A6"] : [],
    skippedPages,
  };
}

/**
 * 无法识别的字符：替换符 U+FFFD、私用区（字体没有 Unicode 映射时常落在这里）、控制字符。
 * 已知盲区：字符映射错位但输出的仍是正常汉字时，按字符类型检测不出来。
 */
function isGarbled(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    cp === 0xfffd ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    cp >= 0xf0000 ||
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f)
  );
}

export function garbledRatio(text: string): number {
  const chars = Array.from(text.replace(/\s/g, ""));
  if (chars.length === 0) return 0;
  return chars.filter(isGarbled).length / chars.length;
}

/**
 * 页眉页脚比对用：去空白，剥掉首尾的字母数字（页码常贴在页眉两端，OCR 文字层还会把
 * 10、12 认成「1o」「1z」），中间的数字串统一成 #。「序言 3」「导论1z」「19导论」都归为同一行。
 */
const edgeKey = (text: string) =>
  text
    .replace(/\s/g, "")
    .replace(/^[0-9０-９A-Za-z]+|[0-9０-９A-Za-z]+$/g, "")
    .replace(/[0-9０-９]+/g, "#");
const isPageNumber = (text: string) => /^[0-9０-９]+$/.test(text.replace(/\s/g, ""));

/**
 * 去页眉页脚。两条规则都只看每页最上面一行和最下面一行（按纵坐标，不按内容顺序：
 * Word 导出的 PDF 常把页眉页脚写在内容流的开头或末尾）：
 * - 同一行（edgeKey 相同）在 ≥ REPEATED_EDGE_MIN_PAGES 页的同一位置（页顶或页底）出现，
 *   且本行高度与这些行的中位高度相差不超过 1.5 个字 → 去掉；
 * - 纯数字行 → 当作页码去掉。
 * 只处理首末各一行：页眉下面紧跟的第二行即使也重复，也不动。
 * null 表示被跳过的扫描页，原样保留位置，用来打断跨页段落。
 */
export function stripPageEdges(pages: (PdfPageData | null)[]): (PdfLine[] | null)[] {
  const edges = pages.map((p) => {
    if (!p || p.lines.length === 0) return null;
    let top = 0;
    let bottom = 0;
    p.lines.forEach((l, i) => {
      if (l.y > p.lines[top].y) top = i;
      if (l.y < p.lines[bottom].y) bottom = i;
    });
    return { top, bottom };
  });

  /** 每个 key 在页顶（或页底）出现时的纵坐标 */
  const collect = (pos: "top" | "bottom") => {
    const ys = new Map<string, number[]>();
    pages.forEach((p, i) => {
      const e = edges[i];
      if (!p || !e) return;
      const line = p.lines[e[pos]];
      const key = edgeKey(line.text);
      // 整行只有字母数字（英文正文、纯页码）时 key 为空，不参与重复计数
      if (key !== "") ys.set(key, [...(ys.get(key) ?? []), line.y]);
    });
    return ys;
  };
  const topYs = collect("top");
  const bottomYs = collect("bottom");

  return pages.map((p, i) => {
    const e = edges[i];
    if (!p) return null;
    if (!e) return [];
    const drop = new Set<number>();
    const check = (idx: number, ys: Map<string, number[]>) => {
      const line = p.lines[idx];
      if (isPageNumber(line.text)) {
        drop.add(idx);
        return;
      }
      const seen = ys.get(edgeKey(line.text)) ?? [];
      // 还要落在这组页眉通常所在的高度附近：章首页的大标题常与页眉同名，但位置低得多，不能删
      if (seen.length >= REPEATED_EDGE_MIN_PAGES && Math.abs(line.y - median(seen)) <= 1.5 * line.size) {
        drop.add(idx);
      }
    };
    check(e.top, topYs);
    check(e.bottom, bottomYs);
    return p.lines.filter((_, idx) => !drop.has(idx));
  });
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * 出现次数最多的值（按 1pt 取整），用来估计本页正文的左边界和右边界。
 * 次数相同时，左边界取最靠左的，右边界取最靠右的（缩进行、短行不会被当成边界）。
 */
const mode = (values: number[], prefer: "min" | "max") => {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(Math.round(v), (counts.get(Math.round(v)) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [v, c] of counts) {
    const better = prefer === "min" ? v < best : v > best;
    if (c > bestCount || (c === bestCount && better)) [best, bestCount] = [v, c];
  }
  return best;
};

interface PageLayout {
  left: number;
  right: number;
  /** 相邻行基线的典型间距 */
  pitch: number;
}

/** 行数太少的页估不准边界，改用全书的值 */
const MIN_LINES_FOR_PAGE_LAYOUT = 3;

function layoutOf(lines: PdfLine[]): PageLayout {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) pitches.push(gap);
  }
  return {
    left: mode(lines.map((l) => l.x), "min"),
    right: mode(lines.map((l) => l.right), "max"),
    pitch: median(pitches),
  };
}

/**
 * 行拼成段落。L 是当前行，M 是下一行，满足任一条件就在 L 之后分段，否则说明段落没结束，接上：
 * - L 没写满：行末离本页右边界 ≥ 1.5 个字（中文两端对齐，只有段末行会提前结束）；
 * - M 有缩进：行首比本页左边界靠右 ≥ 0.8 个字（首行缩进、居中的标题）；
 * - 同一页内行距超过典型行距的 1.6 倍（空行、段间距）。跨页时不看这一条。
 * 不按字号分段：双层 PDF（扫描图 + OCR 文字层）同一段里字号会乱跳，pdf-real.pdf 上按字号分段
 * 会把 78 个段落从句子中间切开（去掉这条后是 15 个，多为标题）；标题本来就又短又居中，前两条已能分开。
 * 跨页：上一页最后一行和下一页第一行按同样规则判断，所以没写完的段落会接到下一页。
 * 扫描页（null）一律打断段落。
 * 已知限制：页底的脚注混进正文，会打断跨页段落；英文长单词换行会让行末提前，被误判为段末。
 */
export function linesToParagraphs(pages: (PdfLine[] | null)[]): string[] {
  const allLines = pages.flatMap((p) => p ?? []);
  const docLayout = layoutOf(allLines);
  const paragraphs: string[] = [];
  let current = "";
  let prev: { line: PdfLine; layout: PageLayout; page: number } | null = null;

  const flush = () => {
    if (current.trim() !== "") paragraphs.push(current.trimEnd());
    current = "";
  };

  pages.forEach((lines, pageIndex) => {
    if (lines === null) {
      flush();
      prev = null;
      return;
    }
    const own = layoutOf(lines);
    const layout =
      lines.length >= MIN_LINES_FOR_PAGE_LAYOUT ? { ...own, pitch: own.pitch || docLayout.pitch } : docLayout;
    for (const line of lines) {
      if (line.text.trim() === "") continue;
      if (prev && endsParagraph(prev.line, prev.layout, line, layout, prev.page === pageIndex)) flush();
      current = joinLine(current, line.text);
      prev = { line, layout, page: pageIndex };
    }
  });
  flush();
  return paragraphs;
}

function endsParagraph(
  l: PdfLine,
  lLayout: PageLayout,
  m: PdfLine,
  mLayout: PageLayout,
  samePage: boolean,
): boolean {
  if (lLayout.right - l.right >= 1.5 * l.size) return true;
  if (m.x - mLayout.left >= 0.8 * m.size) return true;
  if (samePage && lLayout.pitch > 0 && l.y - m.y > 1.6 * lLayout.pitch) return true;
  return false;
}

/** 行与行直接相连；两侧都是英文字母或数字时补一个空格 */
function joinLine(acc: string, next: string): string {
  if (acc === "") return next;
  const left = acc.trimEnd();
  if (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(next)) return `${left} ${next}`;
  return left + next;
}
