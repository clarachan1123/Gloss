import { buildGlossMessages, parseGlossRequest } from "@/lib/context";
import { AiError, MODEL_FAST, MODEL_STRONG, errorResponse, logAiEvent, streamChat, type Usage } from "@/lib/deepseek";
import { GlossOutput } from "@/lib/output";
import { countChars } from "@/lib/parse/validate";
import {
  GLOSS_MAX_TOKENS,
  GLOSS_PROMPT_ARCHIVE,
  GLOSS_PROMPT_VERSION,
  GLOSS_SYSTEM_PROMPT,
  GLOSS_TEMPERATURE,
} from "@/lib/prompts/gloss";

/**
 * POST /api/gloss —— 功能一：一句原文 → 流式白话。
 *
 * 请求体：{ sentence: string, before?: string[], after?: string[], structure?: string }
 *   before / after 各至多 2 句；structure 是调用方传入的全书结构摘要。
 *   本接口绝不内部调用 /api/structure——「每次点句都算一次结构」在结构上就不可能发生。
 *
 * 成功：200 text/plain，白话按 3–5 字一块流式写出。
 * 失败：第一块白话就绪之后才发 200，所以首块之前的异常都有明确的状态码和错误类型：
 *   400 bad_request   请求体不合法
 *   504 timeout       C1 两次各 15 秒内都没有首字（首字前自动重试一次）
 *   502 api_error     C2 上游错误，详情只进日志
 *   429 rate_limited  C3 限流，Retry-After: 5
 *   502 empty         C4 返回为空
 *   422 refused       C6 模型拒答：内容过滤，或输出了约定的拒答标记
 * 首块之后再出错，响应流直接中断（客户端看到连接异常结束），由 G-07 的前端处理（D2）。
 * C5 超长：写满 150 字即截断并中止上游，记 gloss_overlength。
 * D3 / D4 客户端断开：中止上游请求，记 gloss_abort。
 */

const FIRST_TOKEN_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 15_000;
/** 首字超时后给上游一点喘息时间再试；前端慢提示为 10 秒，必须小于这里的 15 秒首字阈值。 */
const FIRST_TOKEN_RETRY_DELAY_MS = 1_000;

/** 等待重试时仍要响应读者收起 / 离页；中止后绝不发出第二次请求。 */
function waitForRetry(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, FIRST_TOKEN_RETRY_DELAY_MS);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

interface Variant {
  model: string;
  promptVersion: string;
  systemPrompt: string;
  temperature: number;
}

const DEFAULT_VARIANT: Variant = {
  model: MODEL_FAST,
  promptVersion: GLOSS_PROMPT_VERSION,
  systemPrompt: GLOSS_SYSTEM_PROMPT,
  temperature: GLOSS_TEMPERATURE,
};

const DEV_MODEL_CHOICES = new Set([MODEL_FAST, MODEL_STRONG]);

/**
 * 仅开发环境：评测脚本可以用请求头临时切换实验参数，做对照实验——
 *   X-Gloss-Model        只认 MODEL_FAST / MODEL_STRONG
 *   X-Gloss-Prompt       只认 GLOSS_PROMPT_ARCHIVE 里的历史版本
 *   X-Gloss-Temperature  只认 0–2 的数字
 * 不合规的值一律忽略。其他环境整个忽略这些头——否则任何人都能指定更贵的模型来烧额度。
 * 实际生效的参数写进响应头，评测脚本据此核对。
 */
function pickVariant(request: Request): Variant {
  if (process.env.NODE_ENV !== "development") return DEFAULT_VARIANT;
  const variant = { ...DEFAULT_VARIANT };

  const model = request.headers.get("x-gloss-model");
  if (model && DEV_MODEL_CHOICES.has(model)) variant.model = model;

  const prompt = request.headers.get("x-gloss-prompt");
  if (prompt && Object.hasOwn(GLOSS_PROMPT_ARCHIVE, prompt)) {
    variant.promptVersion = prompt;
    variant.systemPrompt = GLOSS_PROMPT_ARCHIVE[prompt];
  }

  const temperature = request.headers.get("x-gloss-temperature");
  if (temperature && /^\d+(\.\d+)?$/.test(temperature) && Number(temperature) <= 2) {
    variant.temperature = Number(temperature);
  }
  return variant;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "请求体不是合法的 JSON");
  }
  const parsed = parseGlossRequest(body);
  if (!parsed.ok) return errorResponse("bad_request", parsed.reason);
  const gloss = parsed.value;
  const variant = pickVariant(request);

  const startedAt = Date.now();
  let upstream = new AbortController();
  const abortUpstream = () => upstream.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });
  let cancelled = false;

  let usage: Usage | null = null;
  let firstChunkMs: number | null = null;
  const output = new GlossOutput();
  const createPieces = () =>
    streamChat({
      model: variant.model,
      messages: buildGlossMessages(gloss, variant.systemPrompt),
      temperature: variant.temperature,
      maxTokens: GLOSS_MAX_TOKENS,
      signal: upstream.signal,
      firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      onUsage: (value) => {
        usage = value;
      },
    });
  let pieces = createPieces();

  const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
    logAiEvent(event, {
      model: variant.model,
      prompt: variant.promptVersion,
      temperature: variant.temperature,
      sentenceChars: countChars(gloss.sentence),
      neighbors: gloss.before.length + gloss.after.length,
      hasStructure: gloss.structure !== null,
      ms: Date.now() - startedAt,
      firstChunkMs,
      outputChars: output.charCount,
      cacheHitTokens: usage?.promptCacheHitTokens ?? null,
      cacheMissTokens: usage?.promptCacheMissTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      ...fields,
    });
  };
  const describe = (error: unknown) => ({
    errorType: error instanceof AiError ? error.type : "api_error",
    detail: error instanceof AiError ? error.detail : "unknown",
  });

  // 第一阶段：等到第一块能发的白话。在此之前出的错仍能换成明确的状态码。
  // C1 的第一次超时只在这里重试；一旦发出首块，后续断流仍是原来的 D2 路径。
  const readFirst = async () => {
    let first: string[] = [];
    let finished = false;
    while (first.length === 0 && !output.refused) {
      const next = await pieces.next();
      if (next.done) {
        finished = true;
        first = output.end();
        break;
      }
      first = output.push(next.value);
    }
    return { first, finished };
  };
  const logRetry = (retryOutcome: "success" | "failure" | "aborted") =>
    log("gloss_retry", { retryOutcome, retryDelayMs: FIRST_TOKEN_RETRY_DELAY_MS });

  let retried = false;
  let first: string[] = [];
  let finished = false;
  while (true) {
    try {
      ({ first, finished } = await readFirst());
      break;
    } catch (error) {
      if (request.signal.aborted) {
        if (retried) logRetry("aborted");
        log("gloss_abort", { phase: "waiting" });
        return new Response(null, { status: 499 });
      }
      if (!retried && error instanceof AiError && error.type === "timeout") {
        retried = true;
        // streamChat 的计时器已中止内部 fetch；这里再次显式中止本次上游信号，
        // 并在它完成前不创建第二次请求。
        upstream.abort();
        await pieces.return().catch(() => {});
        if (!(await waitForRetry(request.signal))) {
          logRetry("aborted");
          log("gloss_abort", { phase: "waiting" });
          return new Response(null, { status: 499 });
        }
        usage = null;
        upstream = new AbortController();
        pieces = createPieces();
        continue;
      }
      if (retried) logRetry("failure");
      const { errorType, detail } = describe(error);
      log("gloss_error", { errorType, detail, phase: "waiting" });
      return errorResponse(error instanceof AiError ? error.type : "api_error");
    }
  }
  if (output.refused) {
    upstream.abort();
    await pieces.return();
    if (retried) logRetry("failure");
    log("gloss_error", { errorType: "refused", detail: "refusal_marker", phase: "waiting" });
    return errorResponse("refused");
  }
  if (first.length === 0) {
    if (retried) logRetry("failure");
    log("gloss_error", { errorType: "empty", detail: "no_output", phase: "waiting" });
    return errorResponse("empty");
  }
  firstChunkMs = Date.now() - startedAt;
  if (retried) logRetry("success");
  // 第二阶段：边收边发
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunks: string[]) => {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      };
      const pump = async () => {
        try {
          send(first);
          if (!finished) {
            while (!output.truncated) {
              const next = await pieces.next();
              if (next.done) break;
              send(output.push(next.value));
            }
            if (output.truncated) {
              upstream.abort();
              await pieces.return();
            }
            send(output.end());
          }
          log(output.truncated ? "gloss_overlength" : "gloss_done");
          controller.close();
        } catch (error) {
          if (cancelled || request.signal.aborted) {
            log("gloss_abort", { phase: "streaming" });
          } else {
            log("gloss_error", { ...describe(error), phase: "streaming" });
          }
          try {
            controller.error(error);
          } catch {
            // 客户端已断开，流已关闭
          }
        }
      };
      void pump();
    },
    cancel() {
      cancelled = true;
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // no-transform：避免压缩中间层攒满缓冲区再发，破坏逐块流式
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Gloss-Model": variant.model,
      "X-Gloss-Prompt": variant.promptVersion,
      "X-Gloss-Temperature": String(variant.temperature),
    },
  });
}
