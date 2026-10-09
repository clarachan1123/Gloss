import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_AFTER,
  MAX_BEFORE,
  MAX_DOCUMENT_CHARS,
  MAX_EXPLAIN_CONTEXT_CHARS,
  MAX_SENTENCE_CHARS,
  buildGlossMessages,
  buildStructureMessages,
  parseGlossRequest,
  parseExplainRequest,
  parseStructureRequest,
  type GlossRequest,
} from "./context";
import {
  GLOSS_LABELS,
  GLOSS_PROMPT_ARCHIVE,
  GLOSS_PROMPT_VERSION,
  GLOSS_REFUSAL_MARKER,
  GLOSS_SYSTEM_PROMPT,
} from "./prompts/gloss";
import { STRUCTURE_SYSTEM_PROMPT } from "./prompts/structure";

function accept(body: unknown): GlossRequest {
  const result = parseGlossRequest(body);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/* ---------------- 请求校验 ---------------- */

describe("parseGlossRequest：只接受合法的上下文窗口", () => {
  it("非对象、缺句子、空白句子一律拒绝", () => {
    for (const body of [null, "甲。", [], {}, { sentence: "" }, { sentence: "　 \n" }, { sentence: 42 }]) {
      expect(parseGlossRequest(body).ok).toBe(false);
    }
  });

  it("前后文各至多 2 句——不传整章", () => {
    const sentences = (n: number) => Array.from({ length: n }, (_, i) => `第${i + 1}句。`);
    expect(parseGlossRequest({ sentence: "甲。", before: sentences(MAX_BEFORE + 1) }).ok).toBe(false);
    expect(accept({ sentence: "甲。", before: sentences(MAX_BEFORE) }).before).toHaveLength(MAX_BEFORE);
    expect(parseGlossRequest({ sentence: "甲。", after: sentences(MAX_AFTER + 1) }).ok).toBe(false);
    expect(accept({ sentence: "甲。", after: sentences(MAX_AFTER) }).after).toHaveLength(MAX_AFTER);
    expect(accept({ sentence: " 甲。 ", before: ["一。", "二。"], after: ["三。"] })).toEqual({
      sentence: "甲。",
      before: ["一。", "二。"],
      after: ["三。"],
      structure: null,
    });
  });

  it("前后文必须是字符串数组，空白项丢弃；缺省为空", () => {
    expect(parseGlossRequest({ sentence: "甲。", before: "一。" }).ok).toBe(false);
    expect(parseGlossRequest({ sentence: "甲。", after: [1] }).ok).toBe(false);
    expect(accept({ sentence: "甲。", before: ["　", "一。"] }).before).toEqual(["一。"]);
    expect(accept({ sentence: "甲。" })).toMatchObject({ before: [], after: [] });
  });

  it("结构摘要可选；空字符串视为没有", () => {
    expect(accept({ sentence: "甲。", structure: "  " }).structure).toBeNull();
    expect(parseGlossRequest({ sentence: "甲。", structure: 1 }).ok).toBe(false);
  });

  it("超长句子拒绝", () => {
    expect(parseGlossRequest({ sentence: "字".repeat(MAX_SENTENCE_CHARS + 1) }).ok).toBe(false);
    expect(parseGlossRequest({ sentence: "字".repeat(MAX_SENTENCE_CHARS) }).ok).toBe(true);
  });

  it("未知字段一律丢弃，进不了提示词", () => {
    const value = accept({
      sentence: "甲。",
      Clara原批注_仅供语气参考_非标准答案: "批注里的标记XYZ",
      extra: "额外字段的标记QWE",
    });
    expect(Object.keys(value).sort()).toEqual(["after", "before", "sentence", "structure"]);
    const sent = buildGlossMessages(value).map((m) => m.content).join("\n");
    expect(sent).not.toContain("XYZ");
    expect(sent).not.toContain("QWE");
  });
});

describe("parseExplainRequest：功能二独立的三段上下文协议", () => {
  const valid = {
    sentence: "灯塔亮了。",
    context: { previous: "海面起雾。", current: "守塔人守到深夜。灯塔亮了。", next: "船只改向。" },
    gloss: "灯光出现了。",
    structure: "一篇虚构的海港故事。",
  };

  it("接受三段上下文、可为空的相邻段和明确的无白话", () => {
    const parsed = parseExplainRequest({ ...valid, context: { previous: null, current: valid.context.current, next: null }, gloss: null });
    expect(parsed).toMatchObject({ ok: true, value: { gloss: null, context: { previous: null, next: null } } });
  });

  it("拒绝缺当前段、错误字段类型及超过 2000 字的三段合计", () => {
    expect(parseExplainRequest({ ...valid, context: { previous: null, next: null } }).ok).toBe(false);
    expect(parseExplainRequest({ ...valid, context: [valid.context] }).ok).toBe(false);
    expect(parseExplainRequest({ ...valid, gloss: ["不是文本"] }).ok).toBe(false);
    expect(parseExplainRequest({ ...valid, context: { previous: "字".repeat(MAX_EXPLAIN_CONTEXT_CHARS), current: "甲。", next: null } }).ok).toBe(false);
  });

  it("功能二未知字段同样不会进入解析结果", () => {
    const parsed = parseExplainRequest({ ...valid, hiddenNote: "不能送给模型" });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(Object.keys(parsed.value).sort()).toEqual(["context", "gloss", "sentence", "structure"]);
  });
});

/* ---------------- 拼装顺序 ---------------- */

describe("buildGlossMessages：稳定的部分在前，服务于前缀缓存", () => {
  const full = accept({ sentence: "目标句。", before: ["前一。", "前二。"], after: ["后一。"], structure: "结构摘要。" });

  it("系统提示词单独一条，用户消息按 结构 → 前文 → 目标句 → 后文 排列", () => {
    const [system, user] = buildGlossMessages(full);
    expect(system).toEqual({ role: "system", content: GLOSS_SYSTEM_PROMPT });
    expect(user.role).toBe("user");
    const order = [GLOSS_LABELS.structure, GLOSS_LABELS.before, GLOSS_LABELS.target, GLOSS_LABELS.after].map((label) =>
      user.content.indexOf(label),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(user.content.startsWith(`${GLOSS_LABELS.structure}\n结构摘要。`)).toBe(true);
  });

  it("同一本书的两次点句，系统提示词与结构段逐字相同", () => {
    const other = accept({ sentence: "另一句。", before: ["别的。"], structure: "结构摘要。" });
    const a = buildGlossMessages(full);
    const b = buildGlossMessages(other);
    expect(b[0]).toEqual(a[0]);
    const prefix = `${GLOSS_LABELS.structure}\n结构摘要。\n\n`;
    expect(a[1].content.startsWith(prefix) && b[1].content.startsWith(prefix)).toBe(true);
  });

  it("没有结构和前后文时，只有目标句一节", () => {
    const [, user] = buildGlossMessages(accept({ sentence: "只有这句。" }));
    expect(user.content).toBe(`${GLOSS_LABELS.target}\n只有这句。`);
  });
});

/* ---------------- 提示词的硬规则 ---------------- */

/** 生效版本和存档里的历史版本都要守这些规则：对照实验跑的也是真实产品会发出去的提示词 */
const ALL_PROMPTS = Object.entries({ [GLOSS_PROMPT_VERSION]: GLOSS_SYSTEM_PROMPT, ...GLOSS_PROMPT_ARCHIVE });

describe("gloss-v9 生效版本与存档", () => {
  it("gloss-v9 生效提示词与 origin/main 逐字相同", () => {
    const digest = createHash("sha256").update(GLOSS_SYSTEM_PROMPT, "utf8").digest("hex");
    expect(digest).toBe("2e208ed558dbda99d4b127692d16bc8928d0b40a3d1048d74497c47bb8875057");
  });

  it("gloss-v10 存档与 5b491fc 生效提示词逐字相同", () => {
    const digest = createHash("sha256").update(GLOSS_PROMPT_ARCHIVE["gloss-v10"], "utf8").digest("hex");
    expect(digest).toBe("38b86e88f6f808abd402b12775acfe46a23a54d3c11425d928f97ff8473b9c64");
  });

  it("gloss-v11 存档与 c551a4c 生效提示词逐字相同", () => {
    const digest = createHash("sha256").update(GLOSS_PROMPT_ARCHIVE["gloss-v11"], "utf8").digest("hex");
    expect(digest).toBe("b790a1a04ed5c53c0f51e8eed231e13bf3686e50b40f2c5e5db031ebafb83732");
  });

  it("gloss-v10 相比 v9 恰好新增五条指定指令", () => {
    const additions = [
      "原句省了主语或承接关系时，若目标句及可见前后文足以确定，就在白话里点明谁在做什么、这层关系怎样接上；不能确定就不要补造。",
      "写完再看白话里新用了哪些‘这、那、这些’等回指；若读者只看白话不能认出所指，且前文能明确指出，就写出所指的名字。",
      "不承载理论的文言词、成语和固定说法，如果照搬后读者仍难懂，也换成日常说法；不要因它是常见成语就原样留下。",
      "同一个词在这里可能有不同意思时，结合目标句的搭配和可见前后文确定本句用法；把这个词在本句承担的意思讲出来，不要漏掉。证据不足时保留原句的含混。",
      "白话从【要讲白的句子】开始；若开头写成了【前文】某句的改写，就删去那一段，只讲目标句。",
    ];
    const currentLines = GLOSS_PROMPT_ARCHIVE["gloss-v10"].split("\n");
    const archiveLines = GLOSS_SYSTEM_PROMPT.split("\n");
    expect(currentLines.filter((line) => !archiveLines.includes(line))).toEqual(additions);
    expect(currentLines.filter((line) => !additions.includes(line))).toEqual(archiveLines);
  });

  it("gloss-v11 相比 v9 恰好新增文言词和成语一行，其余四条不出现", () => {
    const idiomRule = "不承载理论的文言词、成语和固定说法，如果照搬后读者仍难懂，也换成日常说法；不要因它是常见成语就原样留下。";
    const v9Lines = GLOSS_SYSTEM_PROMPT.split("\n");
    const v10Additions = GLOSS_PROMPT_ARCHIVE["gloss-v10"].split("\n").filter((line) => !v9Lines.includes(line));
    const v11Lines = GLOSS_PROMPT_ARCHIVE["gloss-v11"].split("\n");
    expect(v10Additions).toHaveLength(5);
    expect(v11Lines.filter((line) => !v9Lines.includes(line))).toEqual([idiomRule]);
    expect(v11Lines.filter((line) => line !== idiomRule)).toEqual(v9Lines);
    for (const line of v10Additions.filter((line) => line !== idiomRule)) expect(v11Lines).not.toContain(line);
  });

  it("gloss-v12 相比 v9 只在不能做的末尾新增成语白话化一行", () => {
    const rule = "- 原句里的成语、四字格和文言说法（理论概念和专名除外），不要原样照搬进白话；用今天的口语把它的意思讲出来。";
    const v9Lines = GLOSS_SYSTEM_PROMPT.split("\n");
    const v12Lines = GLOSS_PROMPT_ARCHIVE["gloss-v12"].split("\n");
    const anchor = "- 前文、后文、全书结构只用来帮你弄懂这一句。不要复述它们，也不要把它们的内容讲进来。";
    const at = v9Lines.indexOf(anchor);
    expect(at).toBeGreaterThan(0);
    expect(v12Lines).toEqual([...v9Lines.slice(0, at + 1), rule, ...v9Lines.slice(at + 1)]);
    expect(GLOSS_PROMPT_VERSION).toBe("gloss-v9");
  });
});

describe.each(ALL_PROMPTS)("功能一提示词 %s 的硬规则", (_version, prompt) => {
  it("不含任何长度比例约束（PRD F4：比例规则已废除）", () => {
    expect(prompt).not.toMatch(/%|％|百分之|比例|一半|倍/);
  });

  it("提到的各节名称与用户消息里的标题一致", () => {
    for (const label of Object.values(GLOSS_LABELS)) {
      expect(prompt).toContain(label.slice(1, -1));
    }
  });

  it("约定了拒答标记", () => {
    expect(prompt).toContain(GLOSS_REFUSAL_MARKER);
  });
});

describe("对照实验可以换用历史版本的提示词", () => {
  it("传入的系统提示词替换默认版本，用户消息不变", () => {
    const request = accept({ sentence: "甲。" });
    const [system, user] = buildGlossMessages(request, GLOSS_PROMPT_ARCHIVE["gloss-v3"]);
    expect(system.content).toBe(GLOSS_PROMPT_ARCHIVE["gloss-v3"]);
    expect(user).toEqual(buildGlossMessages(request)[1]);
  });
});

/* ---------------- 结构摘要 ---------------- */

describe("结构摘要请求", () => {
  it("正文必填、超过 5 万字拒绝", () => {
    expect(parseStructureRequest({}).ok).toBe(false);
    expect(parseStructureRequest({ paragraphs: ["　"] }).ok).toBe(false);
    expect(parseStructureRequest({ paragraphs: ["字".repeat(MAX_DOCUMENT_CHARS + 1)] }).ok).toBe(false);
    expect(parseStructureRequest({ paragraphs: ["字".repeat(MAX_DOCUMENT_CHARS)] }).ok).toBe(true);
  });

  it("标题、目录、正文依次拼进用户消息", () => {
    const result = parseStructureRequest({ title: "书名", headings: ["第一章", ""], paragraphs: ["第一段。", "第二段。"] });
    if (!result.ok) throw new Error(result.reason);
    const [system, user] = buildStructureMessages(result.value);
    expect(system.content).toBe(STRUCTURE_SYSTEM_PROMPT);
    expect(user.content).toBe("【标题】\n书名\n\n【目录】\n第一章\n\n【正文】\n第一段。\n第二段。");
  });
});
