import { AiError, MODEL_FAST, errorResponse, logAiEvent, streamChat, type ChatMessage, type Usage } from "./deepseek";
import { aiFailureCode, aiUsageFields, recordServerAnalytics } from "./analytics-server";
import { GlossOutput, limitTerms, splitTerms } from "./output";
import { countChars } from "./parse/validate";
import { TERM_OPEN, TERM_CLOSE } from "./prompts/gloss";

const FIRST_TOKEN_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 15_000;
const FIRST_TOKEN_RETRY_DELAY_MS = 1_000;
export interface SelectionStreamOptions {
  kind: "term" | "range"; promptVersion: string; temperature: number; maxTokens: number; maxChars: number;
  refusalMarker: string; messages: ChatMessage[]; source: string; neighbors: number; hasStructure: boolean; retryFirstTimeout: boolean;
}

/** 先沿用既有清洗、拒答与截断，再稳定输出已校验的术语；未闭合标记暂缓发送。 */
export class SelectionOutput {
  private readonly output: GlossOutput;
  private raw = "";
  private emitted = "";
  private pending: string[] = [];
  constructor(private readonly kind: "term" | "range", private readonly source: string, maxChars: number, refusalMarker: string) {
    this.output = new GlossOutput(maxChars, refusalMarker);
  }
  get refused() { return this.output.refused; }
  get truncated() { return this.output.truncated; }
  get charCount() { return this.output.charCount; }
  push(raw: string): string[] { return this.convert(this.output.push(raw).join(""), false); }
  end(): string[] {
    const chunks = this.convert(this.output.end().join(""), true);
    if (this.pending.length) chunks.push(this.pending.splice(0).join(""));
    return chunks;
  }
  private convert(text: string, final: boolean): string[] {
    this.raw += text;
    let open = -1;
    for (let i = 0; i < this.raw.length; i++) {
      if (this.raw[i] === TERM_OPEN && open < 0) open = i;
      if (this.raw[i] === TERM_CLOSE && open >= 0) open = -1;
    }
    const stable = !final && open >= 0 ? this.raw.slice(0, open) : this.raw;
    const segments = limitTerms(splitTerms(stable), { source: this.source });
    const normalized = segments.map(segment => this.kind === "range" && segment.term ? TERM_OPEN + segment.text + TERM_CLOSE : segment.text).join("");
    if (!normalized.startsWith(this.emitted)) throw new Error("术语输出前缀发生变化");
    this.pending.push(...Array.from(normalized.slice(this.emitted.length)));
    this.emitted = normalized;
    const chunks: string[] = [];
    while (this.pending.length >= 3) chunks.push(this.pending.splice(0, 5).join(""));
    return chunks;
  }
}

/** 等待沿用单句接口的一次首字重试时，仍响应客户端中止。 */
function waitForRetry(signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { if (timer !== undefined) clearTimeout(timer); resolve(false); };
    timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, FIRST_TOKEN_RETRY_DELAY_MS);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function streamSelectionResult(request: Request, options: SelectionStreamOptions): Promise<Response> {
  if (request.signal.aborted) return new Response(null, { status: 499 });
  const variant = { model: MODEL_FAST, promptVersion: options.promptVersion, temperature: options.temperature };
  const startedAt = Date.now();
  let upstream = new AbortController();
  const abortUpstream = () => upstream.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });
  let cancelled = false;

  let usage: Usage | null = null;
  let firstChunkMs: number | null = null;
  const output = new SelectionOutput(options.kind, options.source, options.maxChars, options.refusalMarker);
  const createPieces = () =>
    streamChat({
      model: variant.model,
      messages: options.messages,
      temperature: variant.temperature,
      maxTokens: options.maxTokens,
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
      sentenceChars: countChars(options.source),
      neighbors: options.neighbors,
      hasStructure: options.hasStructure,
      ms: Date.now() - startedAt,
      firstChunkMs,
      outputChars: output.charCount,
      cacheHitTokens: usage?.promptCacheHitTokens ?? null,
      cacheMissTokens: usage?.promptCacheMissTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      ...fields,
    });
  };
  const recordCall = (outcome: "done" | "overlength" | "error" | "abort", type: string | null = null,
    abortPhase: "waiting" | "streaming" | null = null) => recordServerAnalytics({
    event: "ai_call", callKind: options.kind, attempt: retried ? 2 : 1, outcome,
    model: variant.model, promptVersion: variant.promptVersion, durationMs: Date.now() - startedAt,
    firstChunkMs, ...aiUsageFields(usage), failureCode: type === null ? null : aiFailureCode(type), abortPhase,
  });
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
    log(options.kind + "_retry", { retryOutcome, retryDelayMs: FIRST_TOKEN_RETRY_DELAY_MS });

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
        log(options.kind + "_abort", { phase: "waiting" });
        await recordCall("abort", null, "waiting");
        return new Response(null, { status: 499 });
      }
      if (options.retryFirstTimeout && !retried && error instanceof AiError && error.type === "timeout") {
        await recordCall("error", "timeout");
        retried = true;
        // streamChat 的计时器已中止内部 fetch；这里再次显式中止本次上游信号，
        // 并在它完成前不创建第二次请求。
        upstream.abort();
        await pieces.return().catch(() => {});
        if (!(await waitForRetry(request.signal))) {
          logRetry("aborted");
          log(options.kind + "_abort", { phase: "waiting" });
          await recordCall("abort", null, "waiting");
          return new Response(null, { status: 499 });
        }
        usage = null;
        upstream = new AbortController();
        pieces = createPieces();
        continue;
      }
      if (retried) logRetry("failure");
      const { errorType, detail } = describe(error);
      log(options.kind + "_error", { errorType, detail, phase: "waiting" });
      await recordCall("error", errorType);
      return errorResponse(error instanceof AiError ? error.type : "api_error");
    }
  }
  if (output.refused) {
    upstream.abort();
    await pieces.return();
    if (retried) logRetry("failure");
    log(options.kind + "_error", { errorType: "refused", detail: "refusal_marker", phase: "waiting" });
    await recordCall("error", "refused");
    return errorResponse("refused");
  }
  if (first.length === 0) {
    if (retried) logRetry("failure");
    log(options.kind + "_error", { errorType: "empty", detail: "no_output", phase: "waiting" });
    await recordCall("error", "empty");
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
          log(output.truncated ? options.kind + "_overlength" : options.kind + "_done");
          controller.close();
          await recordCall(output.truncated ? "overlength" : "done");
        } catch (error) {
          if (cancelled || request.signal.aborted) {
            log(options.kind + "_abort", { phase: "streaming" });
            await recordCall("abort", null, "streaming");
          } else {
            log(options.kind + "_error", { ...describe(error), phase: "streaming" });
            await recordCall("error", describe(error).errorType);
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
      "X-Selection-Model": variant.model,
      "X-Selection-Prompt": variant.promptVersion,
      "X-Selection-Temperature": String(variant.temperature),
    },
  });
}
