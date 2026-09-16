import type { ChatMessage } from "./deepseek";
import { countChars } from "./parse/validate";
import { GLOSS_LABELS, GLOSS_SYSTEM_PROMPT } from "./prompts/gloss";
import { STRUCTURE_SYSTEM_PROMPT } from "./prompts/structure";

/**
 * 上下文窗口的校验与拼装（PRD 3.8、KANBAN G-06）。
 *
 * 功能一的窗口 = 目标句 + 前后各至多 2 句 + 全书结构摘要，不传整章。
 * 拼装顺序服务于 DeepSeek 的前缀缓存：系统提示词（所有请求相同）→ 全书结构（同一本书相同）
 * → 前文 → 目标句 → 后文。越稳定的放越前面，同一本书连续点句时，前两段能命中缓存。
 *
 * 请求体只取已知字段，其余一律丢弃：调用方带来的任何其他字段（例如评测集里的批注）都不可能进入提示词。
 */

/**
 * 前文至多 2 句、后文至多 2 句，不传整章。
 * 2026-09-16 G-06 窗口实验对比了「前 2 句 / 前 5 句 / 前约 1000 字」：输入相同的三对判定全部不一致，
 * 判定不稳，看不出宽窗口更好；唯一只有宽窗口拿得到所指的句子，三种窗口都判为说清了。
 * 按事先定好的规则回到前 2 句，指代问题改由提示词里的正向指令处理（gloss-v4）。
 */
export const MAX_BEFORE = 2;
export const MAX_AFTER = 2;
/** B2 会把句子切到 250 字以内；切不动的巨句也放行，到这里为止 */
export const MAX_SENTENCE_CHARS = 1000;
/** 前后文单句上限：原文里真有三四百字一句的长句 */
export const MAX_NEIGHBOR_CHARS = 1000;
/** 结构摘要本应 ≤300 字；手写的摘要留余量 */
export const MAX_STRUCTURE_CHARS = 1000;
/** PRD 3.8 单文档字数上限 */
export const MAX_DOCUMENT_CHARS = 50_000;
export const MAX_TITLE_CHARS = 200;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ---------------- 功能一 ---------------- */

export interface GlossRequest {
  sentence: string;
  before: string[];
  after: string[];
  /** 全书结构摘要，由调用方传入；本服务从不为了功能一去计算它 */
  structure: string | null;
}

export function parseGlossRequest(body: unknown): Parsed<GlossRequest> {
  if (!isRecord(body)) return fail("请求体必须是 JSON 对象");

  const sentence = typeof body.sentence === "string" ? body.sentence.trim() : "";
  if (countChars(sentence) === 0) return fail("sentence 必须是非空字符串");
  if (countChars(sentence) > MAX_SENTENCE_CHARS) return fail(`sentence 超过 ${MAX_SENTENCE_CHARS} 字`);

  const before = parseNeighbors(body.before, "before", MAX_BEFORE);
  if (!before.ok) return fail(before.reason);
  const after = parseNeighbors(body.after, "after", MAX_AFTER);
  if (!after.ok) return fail(after.reason);

  let structure: string | null = null;
  if (body.structure !== undefined && body.structure !== null) {
    if (typeof body.structure !== "string") return fail("structure 必须是字符串");
    structure = body.structure.trim() || null;
    if (structure && countChars(structure) > MAX_STRUCTURE_CHARS) {
      return fail(`structure 超过 ${MAX_STRUCTURE_CHARS} 字`);
    }
  }

  return { ok: true, value: { sentence, before: before.value, after: after.value, structure } };
}

function parseNeighbors(value: unknown, name: string, max: number): Parsed<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return fail(`${name} 必须是字符串数组`);
  }
  if (value.length > max) return fail(`${name} 至多 ${max} 句（不传整章）`);
  const items = (value as string[]).map((item) => item.trim()).filter((item) => countChars(item) > 0);
  if (items.some((item) => countChars(item) > MAX_NEIGHBOR_CHARS)) {
    return fail(`${name} 单句超过 ${MAX_NEIGHBOR_CHARS} 字`);
  }
  return { ok: true, value: items };
}

/** systemPrompt 默认用生效中的版本；只有开发环境的对照实验会传入历史版本 */
export function buildGlossMessages(request: GlossRequest, systemPrompt: string = GLOSS_SYSTEM_PROMPT): ChatMessage[] {
  const sections: string[] = [];
  if (request.structure) sections.push(`${GLOSS_LABELS.structure}\n${request.structure}`);
  if (request.before.length > 0) sections.push(`${GLOSS_LABELS.before}\n${request.before.join("\n")}`);
  sections.push(`${GLOSS_LABELS.target}\n${request.sentence}`);
  if (request.after.length > 0) sections.push(`${GLOSS_LABELS.after}\n${request.after.join("\n")}`);
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: sections.join("\n\n") },
  ];
}

/* ---------------- 结构摘要 ---------------- */

export interface StructureRequest {
  title: string | null;
  headings: string[];
  paragraphs: string[];
}

export function parseStructureRequest(body: unknown): Parsed<StructureRequest> {
  if (!isRecord(body)) return fail("请求体必须是 JSON 对象");

  const { paragraphs, headings, title } = body;
  if (!Array.isArray(paragraphs) || paragraphs.some((p) => typeof p !== "string")) {
    return fail("paragraphs 必须是字符串数组");
  }
  const cleanParagraphs = (paragraphs as string[]).map((p) => p.trim()).filter((p) => countChars(p) > 0);
  if (cleanParagraphs.length === 0) return fail("paragraphs 不能为空");
  if (countChars(cleanParagraphs.join("")) > MAX_DOCUMENT_CHARS) return fail(`正文超过 ${MAX_DOCUMENT_CHARS} 字`);

  if (headings !== undefined && (!Array.isArray(headings) || headings.some((h) => typeof h !== "string"))) {
    return fail("headings 必须是字符串数组");
  }
  if (title !== undefined && title !== null && typeof title !== "string") return fail("title 必须是字符串");
  const cleanTitle = typeof title === "string" ? title.trim() || null : null;
  if (cleanTitle && countChars(cleanTitle) > MAX_TITLE_CHARS) return fail(`title 超过 ${MAX_TITLE_CHARS} 字`);

  return {
    ok: true,
    value: {
      title: cleanTitle,
      headings: ((headings as string[] | undefined) ?? []).map((h) => h.trim()).filter(Boolean),
      paragraphs: cleanParagraphs,
    },
  };
}

export function buildStructureMessages(request: StructureRequest): ChatMessage[] {
  const sections: string[] = [];
  if (request.title) sections.push(`【标题】\n${request.title}`);
  if (request.headings.length > 0) sections.push(`【目录】\n${request.headings.join("\n")}`);
  sections.push(`【正文】\n${request.paragraphs.join("\n")}`);
  return [
    { role: "system", content: STRUCTURE_SYSTEM_PROMPT },
    { role: "user", content: sections.join("\n\n") },
  ];
}
