import { GLOSS_REFUSAL_MARKER, TERM_CLOSE, TERM_OPEN } from "./prompts/gloss";

/**
 * 模型原始输出 → 发给前端的字块。四道工序依次串联，全部流式处理，不等整段生成完：
 * ① 清洗 markdown（PRD C8）→ ② 识别拒答标记（C6）→ ③ 150 字截断（C5）→ ④ 切成 3–5 字的块（PRD 3.7）。
 * 字数口径与 G-02 的 countChars 一致：按 Unicode 码点计数，不计空白。
 */

export const MAX_GLOSS_CHARS = 150;
export const CHUNK_MIN_CHARS = 3;
export const CHUNK_MAX_CHARS = 5;

/**
 * 行首可能构成 markdown 标记的前缀：标题 #、引用 >、无序列表 - * +、有序列表 1. 1) 1、 1），
 * 以及分隔线 --- *** ___ ===。
 * 行首字符先扣住，确定不是标记再放出来——否则「1990 年」的「1」、「1.5 倍」的「1.」会被误删。
 */
const MARKER_PREFIX = /^\s*(?:#{1,6}|>|[-*+]|[-*_=]{2,}|\d{1,3}[.、)）]?)?\s*$/u;
/** 完整的行首标记。「1.」「1)」后面必须跟空白才算（否则是小数、编号引用）；「1、」「1）」不必 */
const COMPLETE_MARKER = /^\s*(?:(?:#{1,6}|>|[-*+]|\d{1,3}[.)])\s+|\d{1,3}[、）]\s*)$/u;
/** 一行只有这些符号就结束了：是标记残片或分隔线，整行丢弃 */
const MARKER_ONLY = /^[\s#>*+_=-]*$/u;

export class MarkdownStripper {
  private lineStart = true;
  private pending = "";

  push(text: string): string {
    let out = "";
    for (const ch of text) out += this.feed(ch);
    return out;
  }

  end(): string {
    const out = this.lineStart ? this.releasePending() : "";
    this.lineStart = true;
    return out;
  }

  private feed(ch: string): string {
    if (ch === "\r") return "";
    if (ch === "\n") {
      const out = this.lineStart ? this.releasePending() : "";
      this.lineStart = true;
      // 换行本身不输出：白话是一段连续的文字，汉字之间也不需要补空格
      return out;
    }
    if (!this.lineStart) return stripInline(ch);

    const candidate = this.pending + ch;
    if (MARKER_PREFIX.test(candidate)) {
      this.pending = candidate;
      return "";
    }
    const pending = this.pending;
    this.pending = "";
    this.lineStart = false;
    if (COMPLETE_MARKER.test(pending)) return stripInline(ch);
    return stripInline(candidate.replace(/^\s+/u, ""));
  }

  private releasePending(): string {
    const pending = this.pending;
    this.pending = "";
    return MARKER_ONLY.test(pending) ? "" : stripInline(pending.replace(/^\s+/u, ""));
  }
}

/** 行内标记：加粗 / 斜体的星号、代码的反引号。中文正文里不会用到这两个符号 */
function stripInline(text: string): string {
  return text.replace(/[*`]/g, "");
}

/** 输出开头若是拒答标记（C6）就吞掉并标记；可能还在输出标记的途中时先扣住，确定不是再放行 */
class RefusalGate {
  refused = false;
  private decided = false;
  private held = "";

  push(text: string): string {
    if (this.refused) return "";
    if (this.decided) return text;
    this.held += text;
    const head = this.held.replace(/^\s+/u, "");
    if (head.startsWith(GLOSS_REFUSAL_MARKER)) {
      this.refused = true;
      this.held = "";
      return "";
    }
    if (GLOSS_REFUSAL_MARKER.startsWith(head)) return "";
    return this.release(head);
  }

  end(): string {
    if (this.refused || this.decided) return "";
    return this.release(this.held.replace(/^\s+/u, ""));
  }

  private release(text: string): string {
    this.decided = true;
    this.held = "";
    return text;
  }
}

class CharLimiter {
  count = 0;
  truncated = false;

  /** uncounted：不计入上限、但照常放行的字符（术语标记的 ⟦⟧，PRD 3.7 的 150 字是给读者看的字数） */
  constructor(
    private readonly max: number,
    private readonly uncounted = "",
  ) {}

  push(text: string): string {
    if (this.truncated) return "";
    let out = "";
    for (const ch of text) {
      const counted = !/\s/u.test(ch) && !this.uncounted.includes(ch);
      if (counted && this.count >= this.max) {
        this.truncated = true;
        break;
      }
      out += ch;
      if (counted) this.count++;
    }
    return out;
  }
}

/** 攒够 3 个字就发，每块最多 5 个字；结尾不足 3 个字的余量单独成块。按码点切，不拆代理对 */
class Chunker {
  private held: string[] = [];

  push(text: string): string[] {
    this.held.push(...Array.from(text));
    const out: string[] = [];
    while (this.held.length >= CHUNK_MIN_CHARS) out.push(this.held.splice(0, CHUNK_MAX_CHARS).join(""));
    return out;
  }

  end(): string[] {
    if (this.held.length === 0) return [];
    const out = [this.held.join("")];
    this.held = [];
    return out;
  }
}

/** 一次功能一调用的输出管线。push 喂模型的原始增量，返回可以立刻发给前端的字块 */
export class GlossOutput {
  private readonly stripper = new MarkdownStripper();
  private readonly gate = new RefusalGate();
  private readonly limiter = new CharLimiter(MAX_GLOSS_CHARS, TERM_OPEN + TERM_CLOSE);
  private readonly chunker = new Chunker();

  get refused(): boolean {
    return this.gate.refused;
  }

  /** 已写满 150 字、后续输出被丢弃（C5） */
  get truncated(): boolean {
    return this.limiter.truncated;
  }

  get charCount(): number {
    return this.limiter.count;
  }

  push(raw: string): string[] {
    return this.chunker.push(this.limiter.push(this.gate.push(this.stripper.push(raw))));
  }

  /** 上游结束（或被截断中止）后调用一次，放出所有扣住的字 */
  end(): string[] {
    const tail = this.gate.push(this.stripper.end()) + this.gate.end();
    return [...this.chunker.push(this.limiter.push(tail)), ...this.chunker.end()];
  }
}

/* ---------------- 术语标记（G-08） ---------------- */

export interface GlossSegment {
  text: string;
  /** true：承重概念，渲染成灰蓝色标记且整词不折行 */
  term: boolean;
}

/**
 * 把带 ⟦⟧ 标记的白话切成「普通文字 / 术语」两种片段。**定界符本身永不出现在结果里**，
 * 所以配对失败时读者看到的仍是通顺的纯文本（PRD 3.7：不做「为什么不翻」的说明，更不能露出内部符号）。
 *
 * - 只有左半边：`unterminatedIsTerm` 为 true 时后面的字先按术语显示（流式中途，右半边还没到），
 *   为 false 时按普通文字显示（已经写完了还没配上，判定为模型写坏了）。
 * - 只有右半边：丢掉这个符号，文字照常显示。
 * - 嵌套的左半边：忽略，不重复开启。
 * - 跨数据块被截断：调用方每次都用「到目前为止收到的全文」重新解析，chunk 边界不影响结果。
 */
export function splitTerms(text: string, unterminatedIsTerm = false): GlossSegment[] {
  const segments: GlossSegment[] = [];
  let buffer = "";
  let inTerm = false;
  // 相邻的同类片段合并：空标记、未配对的符号被丢掉之后，两边的文字应当连成一段
  const flush = (term: boolean) => {
    if (buffer !== "") {
      const last = segments.at(-1);
      if (last && last.term === term) last.text += buffer;
      else segments.push({ text: buffer, term });
    }
    buffer = "";
  };
  for (const ch of text) {
    if (ch === TERM_OPEN) {
      if (!inTerm) {
        flush(false);
        inTerm = true;
      }
      continue;
    }
    if (ch === TERM_CLOSE) {
      if (inTerm) {
        flush(true);
        inTerm = false;
      }
      continue;
    }
    buffer += ch;
  }
  flush(inTerm && unterminatedIsTerm);
  return segments;
}

/** 非流式场景（结构摘要）用的整段清洗 */
export function stripMarkdown(text: string): string {
  const stripper = new MarkdownStripper();
  return (stripper.push(text) + stripper.end()).trim();
}

export function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  const limiter = new CharLimiter(max);
  const out = limiter.push(text);
  // 截断是在下一个计数字到来时才发现的，此前放行的空白留在了结尾
  return { text: limiter.truncated ? out.trimEnd() : out, truncated: limiter.truncated };
}
