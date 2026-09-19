/**
 * DeepSeek 调用封装：OpenAI 兼容格式的 Chat Completions，直接 fetch，不装 SDK。只在服务端使用。
 *
 * 模型与价格——2026-09-16 核对官方文档 api-docs.deepseek.com「Models & Pricing」（中英文两页一致）、
 * 「Create Chat Completion」「Thinking Mode」。G-07 按这里算单次成本。
 *
 *   标识符            版本                     用途
 *   deepseek-flash    DeepSeek-V4.1-Flash      功能一白话、结构摘要（MODEL_FAST）
 *   deepseek-v4-pro   DeepSeek-V4-Pro-0813     功能二「听不懂」（G-11，MODEL_STRONG）
 *   旧名 deepseek-v4-flash 已退役：仍可调用，但会被路由到 V4.1-Flash。不要再写旧名。
 *
 *   每百万 tokens           deepseek-flash          deepseek-v4-pro
 *                           空闲       高峰         空闲       高峰
 *   输入（缓存命中）        ¥0.02      ¥0.04        ¥0.15      ¥0.30
 *   输入（缓存未命中）      ¥1         ¥2           ¥4.5       ¥9
 *   输出                    ¥4         ¥8           ¥13.5      ¥27
 *   美元价：flash 命中 $0.003 / $0.006、未命中 $0.15 / $0.30、输出 $0.60 / $1.20；
 *           pro   命中 $0.022 / $0.044、未命中 $0.66 / $1.32、输出 $1.98 / $3.96。
 *
 *   高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00（UTC 01:00–04:00、06:00–10:00）；
 *   其余为空闲时段，价格是高峰的一半。并发上限 flash 2500、pro 500。
 *
 * 两条影响成本和延迟的事实：
 * - 缓存按「前缀」命中。消息里不变的部分必须放在前面（拼装顺序见 lib/context.ts）。
 * - 思考模式默认开启。功能一必须显式关闭：否则先输出一段推理，拖慢首字、多算输出 token，
 *   而且思考模式下 temperature 不生效。
 *
 * 隐私：key 只从环境变量读，不进日志；上游错误的响应体可能回显请求内容，只记状态码，不透传给前端。
 */

import { MODEL_FAST, MODEL_STRONG } from "./models";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * 本地慢上游复现只允许在 development 覆盖到 localhost 或 127.0.0.1；
 * 其他地址一律忽略，避免原句和 key 被发到外部。生产环境始终使用官方地址。
 */
function baseUrl(): string {
  const override = process.env.NODE_ENV === "development" ? process.env.DEEPSEEK_BASE_URL : undefined;
  if (override) {
    try {
      const url = new URL(override);
      if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && !url.username && !url.password) {
        return override.replace(/\/$/, "");
      }
    } catch {
      // 无效覆盖地址按外部地址处理，回退官方地址。
    }
  }
  return DEFAULT_BASE_URL;
}

export { MODEL_FAST, MODEL_STRONG };

/** PRD 3.9 C 类里能在调用层判定的几种；C4 返回为空、C5 超长由调用方根据输出判定 */
export type AiErrorType = "timeout" | "api_error" | "rate_limited" | "refused";

export class AiError extends Error {
  constructor(
    readonly type: AiErrorType,
    /** 只进服务端日志，不给用户看（C2） */
    readonly detail: string,
  ) {
    super(`${type}: ${detail}`);
    this.name = "AiError";
  }
}

/** 接口对外的错误类型：调用层的几种，加上请求不合法、返回为空（C4） */
export type ApiErrorType = AiErrorType | "bad_request" | "empty";

const ERROR_STATUS: Record<ApiErrorType, number> = {
  bad_request: 400,
  timeout: 504,
  api_error: 502,
  rate_limited: 429,
  empty: 502,
  refused: 422,
};

/**
 * /api/gloss 与 /api/structure 共用的错误响应。只返回错误类型，上游详情只进日志（C2）。
 * bad_request 附带原因，便于调试请求体（原因里不回显请求内容）。C3 限流带 Retry-After: 5。
 */
export function errorResponse(type: ApiErrorType, message?: string): Response {
  return Response.json(message ? { error: type, message } : { error: type }, {
    status: ERROR_STATUS[type],
    headers: type === "rate_limited" ? { "Retry-After": "5" } : undefined,
  });
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface Usage {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** 调用方主动中止（客户端断开、服务端截断）。中止时迭代以原始 AbortError 结束，不转成 AiError */
  signal: AbortSignal;
  /** 从发出请求到第一段正文的上限（C1） */
  firstTokenTimeoutMs: number;
  /** 正文开始后，两段之间的最长间隔；卡住的流不能无限挂着 */
  idleTimeoutMs: number;
  onUsage?: (usage: Usage) => void;
}

/**
 * 流式调用，逐段产出正文。
 * 上游 HTTP 错误、超时、内容过滤在产出第一段之前就会抛出 AiError，调用方可据此返回明确的错误码。
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<string, void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new AiError("api_error", "DEEPSEEK_API_KEY 未配置");

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const forwardAbort = () => controller.abort();
  if (options.signal.aborted) controller.abort();
  options.signal.addEventListener("abort", forwardAbort, { once: true });
  arm(options.firstTokenTimeoutMs);

  const fail = (error: unknown): unknown => {
    if (timedOut) return new AiError("timeout", "等待模型输出超时");
    if (options.signal.aborted) return error;
    if (error instanceof AiError) return error;
    return new AiError("api_error", error instanceof Error ? error.name : "unknown");
  };

  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw fail(error);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // 401 key 错、402 余额不足、400/422 参数错、500/503 服务端问题：对用户都是「暂时无法生成」（C2）
      throw new AiError(response.status === 429 ? "rate_limited" : "api_error", `HTTP ${response.status}`);
    }
    if (!response.body) throw new AiError("api_error", "响应没有正文");

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<string>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw fail(error);
        }
        if (chunk.done) throw new AiError("api_error", "stream ended before [DONE]");
        buffer += chunk.value;

        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          // SSE：空行分隔事件，「: keep-alive」之类的注释行忽略
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;

          const event = parseEvent(data);
          if (event.usage) options.onUsage?.(event.usage);
          if (event.content) {
            arm(options.idleTimeoutMs);
            yield event.content;
          }
          if (event.finishReason === "content_filter") throw new AiError("refused", "content_filter");
          if (event.finishReason === "insufficient_system_resource" || event.finishReason === "aborted") {
            throw new AiError("api_error", `finish_reason=${event.finishReason}`);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", forwardAbort);
  }
}

interface ChunkPayload {
  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_cache_hit_tokens?: unknown; prompt_cache_miss_tokens?: unknown; completion_tokens?: unknown } | null;
}

interface StreamEvent {
  content: string;
  finishReason: string | null;
  usage: Usage | null;
}

function parseEvent(data: string): StreamEvent {
  let payload: ChunkPayload;
  try {
    payload = JSON.parse(data) as ChunkPayload;
  } catch {
    throw new AiError("api_error", "流式数据无法解析");
  }
  const choice = payload.choices?.[0];
  const usage = payload.usage;
  return {
    content: typeof choice?.delta?.content === "string" ? choice.delta.content : "",
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: usage
      ? {
          promptCacheHitTokens: Number(usage.prompt_cache_hit_tokens) || 0,
          promptCacheMissTokens: Number(usage.prompt_cache_miss_tokens) || 0,
          completionTokens: Number(usage.completion_tokens) || 0,
        }
      : null,
  };
}

/**
 * 服务端结构化日志。G-15 接入正式埋点前先落在这里。
 * 只记长度、耗时、token 数、错误类型——不记原句、白话正文和 key。
 */
export function logAiEvent(event: string, fields: Record<string, string | number | boolean | null>): void {
  const line = JSON.stringify({ event, at: new Date().toISOString(), ...fields });
  if (event.endsWith("_error") || event.endsWith("_overlength")) console.warn(line);
  else console.info(line);
}
