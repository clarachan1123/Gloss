import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  GlossOutput,
  MAX_GLOSS_CHARS,
  MarkdownStripper,
  splitTerms,
  stripMarkdown,
  truncateChars,
} from "./output";
import { countChars } from "./parse/validate";
import { GLOSS_REFUSAL_MARKER, TERM_CLOSE, TERM_OPEN } from "./prompts/gloss";

/** 按给定切法把原始输出逐段喂进去，返回全部字块 */
function run(pieces: string[]) {
  const output = new GlossOutput();
  const chunks = pieces.flatMap((p) => output.push(p));
  chunks.push(...output.end());
  return { output, chunks, text: chunks.join("") };
}

const stripInPieces = (pieces: string[]) => {
  const stripper = new MarkdownStripper();
  return pieces.map((p) => stripper.push(p)).join("") + stripper.end();
};

/* ---------------- C8：markdown 清洗 ---------------- */

describe("C8 清洗 markdown，流式切在哪里都一样", () => {
  it("去掉加粗、代码反引号", () => {
    expect(stripMarkdown("**实体**就是`自身`")).toBe("实体就是自身");
  });

  it("行首标题、列表、引用标记去掉，换行合并成一段", () => {
    const raw = "# 标题\n- 第一点\n* 第二点\n1. 第三点\n2、第四点\n> 引用";
    expect(stripMarkdown(raw)).toBe("标题第一点第二点第三点第四点引用");
  });

  it("标记被拆在不同增量里也能识别", () => {
    expect(stripInPieces(["#", "# 标", "题\n", "-", " 第一", "点\n1", ".", " 第二点"])).toBe("标题第一点第二点");
    expect(stripInPieces(["*", "*加", "粗*", "*"])).toBe("加粗");
  });

  it("行首数字不是标记时原样保留：年份、小数", () => {
    expect(stripInPieces(["19", "90", "年"])).toBe("1990年");
    expect(stripInPieces(["1", ".", "5倍"])).toBe("1.5倍");
    expect(stripMarkdown("18世纪末")).toBe("18世纪末");
  });

  it("行首空白去掉；只有标记符号的行整行丢弃", () => {
    expect(stripMarkdown("　 前面有空白\n---\n后面")).toBe("前面有空白后面");
  });

  it("中文破折号、行内的连字符不受影响", () => {
    expect(stripMarkdown("他说——这不是宿命论-式的推理")).toBe("他说——这不是宿命论-式的推理");
  });
});

/* ---------------- C6：拒答标记 ---------------- */

describe("C6 拒答标记只在开头识别，识别到就不输出任何字", () => {
  it("标记被拆开也能识别", () => {
    const { output, chunks } = run(["【无", "法处", "理】"]);
    expect(output.refused).toBe(true);
    expect(chunks).toEqual([]);
  });

  it("标记被加粗、前面有空白也能识别", () => {
    expect(run([`  **${GLOSS_REFUSAL_MARKER}**`]).output.refused).toBe(true);
  });

  it("以【开头的正常白话不误判，文字完整放出", () => {
    const { output, text } = run(["【", "注意】这里说的是", "另一件事。"]);
    expect(output.refused).toBe(false);
    expect(text).toBe("【注意】这里说的是另一件事。");
  });

  it("输出在标记前缀的半路结束：不算拒答，已有的字照样放出", () => {
    const { output, text } = run(["【无法"]);
    expect(output.refused).toBe(false);
    expect(text).toBe("【无法");
  });
});

/* ---------------- C5：150 字截断 ---------------- */

describe("C5 超过 150 字截断，口径与 countChars 一致", () => {
  it("写满 150 字后丢弃后续，并标记 truncated", () => {
    const { output, text } = run(Array.from({ length: 40 }, () => "一二三四五六七"));
    expect(countChars(text)).toBe(MAX_GLOSS_CHARS);
    expect(output.truncated).toBe(true);
    expect(output.charCount).toBe(MAX_GLOSS_CHARS);
  });

  it("恰好 150 字不算超长", () => {
    const { output, text } = run(["字".repeat(MAX_GLOSS_CHARS)]);
    expect(countChars(text)).toBe(MAX_GLOSS_CHARS);
    expect(output.truncated).toBe(false);
  });

  it("空白不计数；扩展区汉字算 1 个字", () => {
    expect(truncateChars("甲 乙\n丙", 2)).toEqual({ text: "甲 乙", truncated: true });
    expect(truncateChars("𠀀𠀁𠀂", 3)).toEqual({ text: "𠀀𠀁𠀂", truncated: false });
  });
});

/* ---------------- PRD 3.7：3–5 字块 ---------------- */

describe("流式吐字：3–5 字一块，拼起来与原文一致", () => {
  it("逐字到达时，除最后一块外每块 3–5 字", () => {
    const source = "按照这一看法，事物之间的联系都是必然的，没有偶然。";
    const { chunks, text } = run(Array.from(source));
    expect(text).toBe(source);
    for (const chunk of chunks.slice(0, -1)) {
      const size = Array.from(chunk).length;
      expect(size).toBeGreaterThanOrEqual(CHUNK_MIN_CHARS);
      expect(size).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    expect(Array.from(chunks.at(-1)!).length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("一次到达一大段时也切成 5 字块", () => {
    const { chunks } = run(["甲乙丙丁戊己庚辛壬癸子丑"]);
    expect(chunks).toEqual(["甲乙丙丁戊", "己庚辛壬癸", "子丑"]);
  });

  it("不把代理对拆成两半", () => {
    const { chunks } = run(["𠀀𠀁𠀂𠀃𠀄𠀅"]);
    expect(chunks).toEqual(["𠀀𠀁𠀂𠀃𠀄", "𠀅"]);
  });

  it("白话开头的空白不发出去", () => {
    expect(run(["\n  ", "从头说起。"]).text).toBe("从头说起。");
  });
});

/* ---------------- 术语标记（G-08） ---------------- */

const T = (text: string) => `${TERM_OPEN}${text}${TERM_CLOSE}`;
const joined = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

describe("术语标记：定界符永不出现在读者眼前", () => {
  it("成对的标记切成普通文字 + 术语两种片段", () => {
    expect(splitTerms(`他说的${T("市民社会")}指的是这个。`)).toEqual([
      { text: "他说的", term: false },
      { text: "市民社会", term: true },
      { text: "指的是这个。", term: false },
    ]);
  });

  it("一句里的多个术语各自成段", () => {
    const segs = splitTerms(`${T("实体")}和${T("样式")}不同。`);
    expect(segs.filter((s) => s.term).map((s) => s.text)).toEqual(["实体", "样式"]);
    expect(joined(segs)).toBe("实体和样式不同。");
  });

  it("只有左半边：生成中按术语显示，写完了按普通文字显示，两种都不露符号", () => {
    const streaming = splitTerms(`他说的${TERM_OPEN}市民社`, true);
    expect(streaming).toEqual([
      { text: "他说的", term: false },
      { text: "市民社", term: true },
    ]);
    const finished = splitTerms(`他说的${TERM_OPEN}市民社会指的是这个。`, false);
    expect(finished).toEqual([{ text: "他说的市民社会指的是这个。", term: false }]);
    for (const segs of [streaming, finished]) expect(joined(segs)).not.toContain(TERM_OPEN);
  });

  it("只有右半边：丢掉符号，文字照常显示", () => {
    expect(splitTerms(`他说的市民社会${TERM_CLOSE}指的是这个。`)).toEqual([
      { text: "他说的市民社会指的是这个。", term: false },
    ]);
  });

  it("嵌套的左半边不重复开启", () => {
    expect(splitTerms(`${TERM_OPEN}绝对${TERM_OPEN}精神${TERM_CLOSE}`)).toEqual([
      { text: "绝对精神", term: true },
    ]);
  });

  it("空标记不产生空片段", () => {
    expect(splitTerms(`前${TERM_OPEN}${TERM_CLOSE}后`)).toEqual([{ text: "前后", term: false }]);
  });

  it("跨数据块被截断：按累计文本解析，与一次到达的结果相同，中途也不露符号", () => {
    const whole = `他说的${T("市民社会")}指的是这个。`;
    const pieces = [`他说的${TERM_OPEN}市`, "民社", `会${TERM_CLOSE}指的`, "是这个。"];
    let acc = "";
    for (const piece of pieces) {
      acc += piece;
      expect(joined(splitTerms(acc, true))).not.toContain(TERM_OPEN);
      expect(joined(splitTerms(acc, true))).not.toContain(TERM_CLOSE);
    }
    expect(splitTerms(acc)).toEqual(splitTerms(whole));
  });

  it("输出管线原样透传标记，由前端解析", () => {
    const { text } = run([`他说的${TERM_OPEN}市`, `民社会${TERM_CLOSE}指的是这个。`]);
    expect(splitTerms(text).filter((s) => s.term).map((s) => s.text)).toEqual(["市民社会"]);
  });

  it("定界符不计入 150 字上限", () => {
    const marked = Array.from({ length: 5 }, () => T("术语")).join("") + "字".repeat(140);
    const { text } = run([marked]);
    const plain = text.replaceAll(TERM_OPEN, "").replaceAll(TERM_CLOSE, "");
    expect(countChars(plain)).toBe(MAX_GLOSS_CHARS);
    expect(text).toContain(TERM_OPEN);
  });
});
