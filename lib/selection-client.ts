import type { GlossFailure, GlossResult } from "./gloss-client";
import type { TermRequest, RangeGlossRequest } from "./selection-context";

export interface SelectionClientOptions { signal: AbortSignal; onText: (text: string) => void }

const FAILURE_BY_ERROR: Record<string, GlossFailure> = {
  timeout: "timeout",
  api_error: "unavailable",
  empty: "unavailable",
  bad_request: "unavailable",
  rate_limited: "rate_limited",
  refused: "refused",
};

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function streamSelection(
  endpoint: "/api/term" | "/api/range-gloss", input: TermRequest | RangeGlossRequest,
  { signal, onText }: { signal: AbortSignal; onText: (text: string) => void },
): Promise<GlossResult> {
  if (isOffline()) return { status: "failed", failure: "offline", text: "", rawErrorCode: "offline" };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
  } catch {
    if (signal.aborted) return { status: "aborted" };
    return { status: "failed", failure: isOffline() ? "offline" : "unavailable", text: "", rawErrorCode: isOffline() ? "offline" : "network" };
  }

  // 403 发生在流开始之前，与读流中途断开（interrupted）是两条路径
  if (response.status === 403) {
    await response.body?.cancel().catch(() => {});
    return signal.aborted ? { status: "aborted" } : { status: "failed", failure: "throttled", text: "", rawErrorCode: "waf_403" };
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (signal.aborted) return { status: "aborted" };
    const failure =
      response.status === 429 ? "rate_limited" : (FAILURE_BY_ERROR[String(payload?.error)] ?? "unavailable");
    return { status: "failed", failure, text: "", rawErrorCode: response.status === 429 ? "upstream_429" : String(payload?.error ?? "api_error") };
  }
  if (!response.body) return { status: "failed", failure: "unavailable", text: "", rawErrorCode: "empty" };

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
      onText(text);
    }
  } catch {
    if (signal.aborted) return { status: "aborted" };
    // 服务端在首块之后出错会直接中断响应流，读到这里和网络断开是同一个样子
    return { status: "failed", failure: text ? "interrupted" : isOffline() ? "offline" : "unavailable", text, rawErrorCode: text ? "interrupted" : isOffline() ? "offline" : "network" };
  }

  if (signal.aborted) return { status: "aborted" };
  return text ? { status: "done", text } : { status: "failed", failure: "unavailable", text: "", rawErrorCode: "empty" };
}

/** 两类划选结果沿用单句客户端的错误码、断流及中止结果。 */
export const streamTerm = (input: TermRequest, options: SelectionClientOptions): Promise<GlossResult> => streamSelection("/api/term", input, options);
export const streamRangeGloss = (input: RangeGlossRequest, options: SelectionClientOptions): Promise<GlossResult> => streamSelection("/api/range-gloss", input, options);
