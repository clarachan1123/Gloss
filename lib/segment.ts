import { countChars } from "./parse/validate";

/**
 * 规则切句（PRD 3.9 B 类）。输入 ParsedDocument.paragraphs，输出带全文顺序号的句子，
 * 以及触发降级的段落下标。
 * B1 无标点文本的 AI 断句、B6 AI 断句失败回退不在本文件。
 *
 * 规则：
 * - 段落边界强制断句，跨段不合并（即使上一段没有句末标点）。
 * - B4 句末标点：全角 。！？；． + 半角 ! ? ;。半角 . 不算（1.5、Mr.）。
 *   省略号、破折号不是句末。连续的句末标点合为一句。
 * - B3 成对标点内部不切：“” ‘’ 《》 「」 『』，以及全角 （）［］（PRD 未写，属填空白）。
 *   半角 () 不保护。找不到开标点的闭标点忽略。
 * - 段末栈未清空（有未配对的前标点）→ 判定该段成对标点不可信，放弃保护整段重切。
 *   不猜是哪个标点错了；否则一个漏掉的后引号会让整段变成一个切不动的巨句。
 * - 句末标点后紧跟的闭合标点 ”’』」》）］"'． 并入前一句，不产生只有「”」的残片。
 *   这张表只管吸收，不参与成对标点的栈（半角 ' 也用作撇号，进栈会算乱配对）。
 * - B5 空白段落、句末之后只剩空白的部分，不产生句子。
 * - B2 超过 MAX_SENTENCE_CHARS 字的句子在句中标点（，、：）处切分，切完仍超长则继续切；
 *   只在成对标点外部切，无可切点时不按字数硬切，但 console.warn 留痕（无静默失败）。
 * - 句子文本原样保留（含段首全角空格）；字数用 G-02 的 countChars。
 */

export interface Sentence {
  /** 全文顺序号，从 0 开始。G-06 取上下文窗口、G-09 定位邻句都靠它 */
  index: number;
  /** 所在段落在 paragraphs 中的下标 */
  paraIndex: number;
  /**
   * 本句在原始 paragraphs[paraIndex] 中的 JS 字符串下标（UTF-16 code unit）。
   * 保存白话用它区分同段内的重复句；它不参与切句规则。
   */
  start: number;
  /** 原文原样，含段首全角空格 */
  text: string;
  /** countChars(text)，与 G-02 的 charCount 同一口径 */
  charCount: number;
}

export interface SegmentResult {
  sentences: Sentence[];
  /**
   * 因「段末有未配对前标点」而放弃成对标点保护的段落下标（升序）。
   * 同时是「这份文档的标点有问题」的信号：降级段落多说明来源质量差（G-15 埋点可用）。
   */
  degradedParagraphs: number[];
}

/** B2：超过此字数（countChars 口径）的句子继续切分 */
export const MAX_SENTENCE_CHARS = 250;

const TERMINATORS = new Set(["。", "！", "？", "；", "．", "!", "?", ";"]);

const PAIRS = new Map([
  ["“", "”"],
  ["‘", "’"],
  ["《", "》"],
  ["「", "」"],
  ["『", "』"],
  ["（", "）"],
  ["［", "］"],
]);
const CLOSERS = new Set(PAIRS.values());

/** 紧跟在句末标点之后时并入前一句（只吸收，不进栈） */
const TRAILING = new Set(["”", "’", "』", "」", "》", "）", "］", '"', "'", "．"]);

/** B2 可切点 */
const MID_BREAKS = new Set(["，", "、", "："]);

export function segmentParagraphs(paragraphs: string[]): SegmentResult {
  const sentences: Sentence[] = [];
  const degradedParagraphs: number[] = [];
  paragraphs.forEach((paragraph, paraIndex) => {
    if (paragraph.trim() === "") return;

    // splitByTerminators / splitLong 都只切分、不改写字符；累加 .length 即为原段落的 UTF-16 下标。
    let start = 0;

    const chars = Array.from(paragraph);
    let { pieces, unclosed } = splitByTerminators(chars, true);
    const pairsTrusted = !unclosed;
    if (!pairsTrusted) {
      degradedParagraphs.push(paraIndex);
      ({ pieces } = splitByTerminators(chars, false));
    }

    for (const piece of pieces) {
      for (const text of splitLong(piece, pairsTrusted)) {
        const sentence = { index: sentences.length, paraIndex, start, text, charCount: countChars(text) };
        start += text.length;
        if (sentence.charCount > MAX_SENTENCE_CHARS) {
          console.warn(`[Gloss] 句子超过 ${MAX_SENTENCE_CHARS} 字且无可切点（整句在成对标点内或无句中标点）`, {
            index: sentence.index,
            paraIndex,
            charCount: sentence.charCount,
          });
        }
        sentences.push(sentence);
      }
    }
  });
  return { sentences, degradedParagraphs };
}

/** 更新成对标点栈：开标点入栈；闭标点弹到与之匹配的位置，匹配不到则忽略 */
function track(stack: string[], char: string): void {
  const closer = PAIRS.get(char);
  if (closer !== undefined) {
    stack.push(closer);
  } else if (CLOSERS.has(char)) {
    const at = stack.lastIndexOf(char);
    if (at !== -1) stack.length = at;
  }
}

/** 按句末标点切一段。protectPairs=false 时忽略成对标点。unclosed：段末是否仍有未配对的前标点 */
function splitByTerminators(
  chars: string[],
  protectPairs: boolean,
): { pieces: string[]; unclosed: boolean } {
  const pieces: string[] = [];
  const stack: string[] = [];
  let start = 0;

  for (let i = 0; i < chars.length; i++) {
    if (protectPairs) track(stack, chars[i]);
    if (!TERMINATORS.has(chars[i]) || stack.length > 0) continue;

    let end = i + 1;
    while (end < chars.length && (TERMINATORS.has(chars[end]) || TRAILING.has(chars[end]))) end++;
    pieces.push(chars.slice(start, end).join(""));
    start = end;
    i = end - 1;
  }
  if (start < chars.length) pieces.push(chars.slice(start).join(""));

  return { pieces: pieces.filter((piece) => piece.trim() !== ""), unclosed: stack.length > 0 };
}

function splitLong(sentence: string, protectPairs: boolean): string[] {
  if (countChars(sentence) <= MAX_SENTENCE_CHARS) return [sentence];

  const chars = Array.from(sentence);
  const stack: string[] = [];
  let count = 0;
  let lastWithin = -1;
  let firstBeyond = -1;

  // 不在最后一个字之后切
  for (let i = 0; i < chars.length - 1; i++) {
    if (!/\s/.test(chars[i])) count++;
    if (protectPairs) track(stack, chars[i]);
    if (stack.length > 0 || !MID_BREAKS.has(chars[i])) continue;
    if (count <= MAX_SENTENCE_CHARS) {
      lastWithin = i;
    } else {
      firstBeyond = i;
      break;
    }
  }

  const cut = lastWithin !== -1 ? lastWithin : firstBeyond;
  if (cut === -1) return [sentence];

  const head = chars.slice(0, cut + 1).join("");
  const tail = chars.slice(cut + 1).join("");
  if (tail.trim() === "") return [sentence];
  return [...splitLong(head, protectPairs), ...splitLong(tail, protectPairs)];
}
