import { buildStructureMessages, parseStructureRequest } from "@/lib/context";
import { AiError, MODEL_FAST, errorResponse, logAiEvent, streamChat, type Usage } from "@/lib/deepseek";
import { stripMarkdown, truncateChars } from "@/lib/output";
import { countChars } from "@/lib/parse/validate";
import {
  STRUCTURE_MAX_CHARS,
  STRUCTURE_MAX_TOKENS,
  STRUCTURE_PROMPT_VERSION,
  STRUCTURE_TEMPERATURE,
} from "@/lib/prompts/structure";

/**
 * POST /api/structure —— 全书结构摘要。
 *
 * 每份文档只调一次，结果由调用方缓存（G-07：前端按 docId 存 localStorage）。/api/gloss 从不调用本接口。
 *
 * 请求体：{ title?: string, headings?: string[], paragraphs: string[] }，正文总字数 ≤5 万（PRD 3.8）。
 * 成功：200 { structure: string, prompt: string }
 * 失败：状态码与错误类型同 /api/gloss（400 / 504 / 502 / 429 / 422）。
 *
 * 服务端不持久化原文：正文只在本次请求内转发给模型，不进日志、不落盘。
 */

/** 要先读完整本书（最多 5 万字）才开始输出，首字等待比功能一宽 */
const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 15_000;
/** 超过 STRUCTURE_MAX_CHARS 只记超长；超过这里才截断——摘要被拦腰截断，比稍长一点更伤上下文 */
const HARD_LIMIT_CHARS = STRUCTURE_MAX_CHARS + 100;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "请求体不是合法的 JSON");
  }
  const parsed = parseStructureRequest(body);
  if (!parsed.ok) return errorResponse("bad_request", parsed.reason);
  const structure = parsed.value;

  const startedAt = Date.now();
  const upstream = new AbortController();
  const abortUpstream = () => upstream.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });

  let usage: Usage | null = null;
  const log = (event: string, fields: Record<string, string | number | boolean | null>) => {
    request.signal.removeEventListener("abort", abortUpstream);
    logAiEvent(event, {
      model: MODEL_FAST,
      prompt: STRUCTURE_PROMPT_VERSION,
      documentChars: countChars(structure.paragraphs.join("")),
      ms: Date.now() - startedAt,
      cacheHitTokens: usage?.promptCacheHitTokens ?? null,
      cacheMissTokens: usage?.promptCacheMissTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      ...fields,
    });
  };

  let raw = "";
  try {
    for await (const piece of streamChat({
      model: MODEL_FAST,
      messages: buildStructureMessages(structure),
      temperature: STRUCTURE_TEMPERATURE,
      maxTokens: STRUCTURE_MAX_TOKENS,
      signal: upstream.signal,
      firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      onUsage: (value) => {
        usage = value;
      },
    })) {
      raw += piece;
    }
  } catch (error) {
    if (request.signal.aborted) {
      log("structure_abort", {});
      return new Response(null, { status: 499 });
    }
    const type = error instanceof AiError ? error.type : "api_error";
    log("structure_error", { errorType: type, detail: error instanceof AiError ? error.detail : "unknown" });
    return errorResponse(type);
  }

  const cleaned = stripMarkdown(raw);
  if (countChars(cleaned) === 0) {
    log("structure_error", { errorType: "empty", detail: "no_output" });
    return errorResponse("empty");
  }
  const { text, truncated } = truncateChars(cleaned, HARD_LIMIT_CHARS);
  const outputChars = countChars(cleaned);
  log(outputChars > STRUCTURE_MAX_CHARS ? "structure_overlength" : "structure_done", { outputChars, truncated });

  return Response.json(
    { structure: text, prompt: STRUCTURE_PROMPT_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}
