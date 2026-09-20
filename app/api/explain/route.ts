import { parseGlossRequest, type GlossRequest } from "@/lib/context";
import { AiError, MODEL_STRONG, logAiEvent, streamChat, type ChatMessage, type Usage } from "@/lib/deepseek";
import { countChars } from "@/lib/parse/validate";
import { MarkdownStripper } from "@/lib/output";
import {
  EXPLAIN_EXTENSION_LEADS,
  EXPLAIN_MAX_CHARS,
  EXPLAIN_MAX_TOKENS,
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_REFUSAL_MARKER,
  EXPLAIN_SYSTEM_PROMPT,
  EXPLAIN_TEMPERATURE,
} from "@/lib/prompts/explain";

const FIRST_TOKEN_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 15_000;
const SENTENCE_END = /[。！？]/u;
const CLOSING_MARK = /[”’」』】）》）］"']/u;
const LEADING_MARKS = /^[\s“”‘’「」『』【】（(\[\]"']+/u;

export type ExplainStreamEvent =
  | { type: "sentence"; text: string }
  | { type: "done" }
  | { type: "error"; error: "timeout" | "rate_limited" | "refused" | "unavailable" | "incomplete" };
type ExplainWireError = Extract<ExplainStreamEvent, { type: "error" }>["error"];

/**
 * 上游可以在任意字符处切 chunk。句末后暂缓一次：下一 chunk 可能才送来闭引号，
 * 只有看到闭引号之后的字符（或流正常结束）才确认边界，避免把闭引号留给下一句。
 */
export class CompleteSentenceBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    return this.take(false).sentences;
  }

  finish(): { sentences: string[]; remainder: string } {
    const result = this.take(true);
    this.pending = "";
    return result;
  }

  private take(atEnd: boolean): { sentences: string[]; remainder: string } {
    const sentences: string[] = [];
    let start = 0;
    for (let index = 0; index < this.pending.length; index += 1) {
      const char = this.pending[index]!;
      if (!SENTENCE_END.test(char)) continue;
      let boundary = index + 1;
      while (boundary < this.pending.length && CLOSING_MARK.test(this.pending[boundary]!)) boundary += 1;
      if (boundary === this.pending.length && !atEnd) break;
      sentences.push(this.pending.slice(start, boundary));
      start = boundary;
      index = boundary - 1;
    }
    const remainder = this.pending.slice(start);
    this.pending = remainder;
    return { sentences, remainder };
  }
}

/** 只判断清洗后输出的开头；标记跨上游 chunk 时先扣住，避免正文误发。 */
class ExplainRefusalGate {
  refused = false;
  private decided = false;
  private held = "";

  push(text: string): string {
    if (this.refused) return "";
    if (this.decided) return text;
    this.held += text;
    const head = this.held.replace(/^\s+/u, "");
    if (head.startsWith(EXPLAIN_REFUSAL_MARKER)) {
      this.refused = true;
      this.held = "";
      return "";
    }
    if (EXPLAIN_REFUSAL_MARKER.startsWith(head)) return "";
    this.decided = true;
    this.held = "";
    return head;
  }

  end(): string {
    if (this.refused || this.decided) return "";
    this.decided = true;
    const text = this.held.replace(/^\s+/u, "");
    this.held = "";
    return text;
  }
}

export function buildExplainMessages(input: GlossRequest): ChatMessage[] {
  return [
    { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
    { role: "user", content: `【全书结构摘要】\n${input.structure ?? "暂无"}` },
    {
      role: "user",
      content: `【前文】\n${input.before.length > 0 ? input.before.join("\n") : "暂无"}\n\n【后文】\n${input.after.length > 0 ? input.after.join("\n") : "暂无"}`,
    },
    { role: "user", content: `【目标句】\n${input.sentence}` },
  ];
}

export function startsWithExtension(sentence: string): boolean {
  const start = sentence.trimStart().replace(LEADING_MARKS, "");
  return EXPLAIN_EXTENSION_LEADS.some((lead) => start.startsWith(lead));
}

function encodeEvent(encoder: TextEncoder, event: ExplainStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function explainError(error: unknown): ExplainWireError {
  if (!(error instanceof AiError)) return "unavailable";
  if (error.type === "timeout") return "timeout";
  if (error.type === "rate_limited") return "rate_limited";
  if (error.type === "refused") return "refused";
  return "unavailable";
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_request", message: "请求体不是合法的 JSON" }, { status: 400 });
  }
  const parsed = parseGlossRequest(body);
  if (!parsed.ok) return Response.json({ error: "bad_request", message: parsed.reason }, { status: 400 });

  const input = parsed.value;
  const encoder = new TextEncoder();
  const upstream = new AbortController();
  let usage: Usage | null = null;
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const buffer = new CompleteSentenceBuffer();
      const stripper = new MarkdownStripper();
      const refusalGate = new ExplainRefusalGate();
      let acceptedText = "";
      let sentenceCount = 0;
      let closed = false;

      const send = (event: ExplainStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeEvent(encoder, event));
        } catch {
          // 浏览器完整离页时响应流可能先被取消；G-29 再负责把取消传到上游。
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 消费端已经取消；不留下未处理的 Promise 拒绝。
        }
      };
      const finishCut = (event: "explain_truncated" | "explain_extension_cut") => {
        // 安全截断由服务端主动终止上游，后续 token 不再继续生成。
        upstream.abort();
        logAiEvent(event, { outputChars: countChars(acceptedText), sentenceCount });
        send(acceptedText ? { type: "done" } : { type: "error", error: "incomplete" });
        close();
      };
      const accept = (sentence: string): "accepted" | "cut" => {
        if (startsWithExtension(sentence)) {
          finishCut("explain_extension_cut");
          return "cut";
        }
        if (countChars(acceptedText) + countChars(sentence) > EXPLAIN_MAX_CHARS) {
          finishCut("explain_truncated");
          return "cut";
        }
        acceptedText += sentence;
        sentenceCount += 1;
        send({ type: "sentence", text: sentence });
        return "accepted";
      };
      const acceptCleanText = (text: string): "accepted" | "cut" | "refused" => {
        const safeText = refusalGate.push(text);
        if (refusalGate.refused) {
          upstream.abort();
          send({ type: "error", error: "refused" });
          close();
          return "refused";
        }
        for (const sentence of buffer.push(safeText)) {
          if (accept(sentence) === "cut") return "cut";
        }
        return "accepted";
      };

      try {
        const pieces = streamChat({
          model: MODEL_STRONG,
          messages: buildExplainMessages(input),
          temperature: EXPLAIN_TEMPERATURE,
          maxTokens: EXPLAIN_MAX_TOKENS,
          signal: upstream.signal,
          firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          onUsage: (value) => {
            usage = value;
          },
        });

        for await (const piece of pieces) {
          const result = acceptCleanText(stripper.push(piece));
          if (result !== "accepted") return;
        }

        const finalText = refusalGate.push(stripper.end()) + refusalGate.end();
        if (refusalGate.refused) {
          send({ type: "error", error: "refused" });
          close();
          return;
        }
        for (const sentence of buffer.push(finalText)) {
          if (accept(sentence) === "cut") return;
        }

        const tail = buffer.finish();
        for (const sentence of tail.sentences) {
          if (accept(sentence) === "cut") return;
        }
        if (tail.remainder.trim().length > 0 || acceptedText.length === 0) {
          send({ type: "error", error: "incomplete" });
          close();
          return;
        }

        logAiEvent("explain_done", {
          model: MODEL_STRONG,
          prompt: EXPLAIN_PROMPT_VERSION,
          ms: Date.now() - startedAt,
          outputChars: countChars(acceptedText),
          sentenceCount,
          cacheHitTokens: usage?.promptCacheHitTokens ?? null,
          cacheMissTokens: usage?.promptCacheMissTokens ?? null,
          completionTokens: usage?.completionTokens ?? null,
        });
        send({ type: "done" });
        close();
      } catch (error) {
        if (closed) return;
        logAiEvent("explain_error", {
          model: MODEL_STRONG,
          prompt: EXPLAIN_PROMPT_VERSION,
          ms: Date.now() - startedAt,
          outputChars: countChars(acceptedText),
          sentenceCount,
          errorType: error instanceof AiError ? error.type : "api_error",
          detail: error instanceof AiError ? error.detail : "unknown",
        });
        send({ type: "error", error: acceptedText ? "incomplete" : explainError(error) });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
