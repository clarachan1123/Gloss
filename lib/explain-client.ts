/** 浏览器侧功能二 NDJSON 客户端。请求生命周期由 Reader 持有，不随 GlossPanel 卸载。 */

export interface ExplainInput {
  sentence: string;
  context: {
    previous: string | null;
    current: string;
    next: string | null;
  };
  /** 读者当时已看到的白话；术语定界符已由 Reader 去除。 */
  gloss: string | null;
  structure: string | null;
}

export type ExplainFailure =
  | "timeout"
  | "unavailable"
  | "rate_limited"
  | "throttled"
  | "refused"
  | "offline"
  | "incomplete"
  | "storage";

export type ExplainResult =
  | { status: "done"; text: string }
  | { status: "failed"; text: string; failure: ExplainFailure };

type WireEvent =
  | { type: "sentence"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

const FAILURE_BY_ERROR: Record<string, ExplainFailure> = {
  timeout: "timeout",
  rate_limited: "rate_limited",
  refused: "refused",
  incomplete: "incomplete",
  unavailable: "unavailable",
};

function parseEvent(line: string): WireEvent | null {
  try {
    const value = JSON.parse(line) as Partial<WireEvent> | null;
    if (value?.type === "sentence" && typeof value.text === "string") return { type: "sentence", text: value.text };
    if (value?.type === "done") return { type: "done" };
    if (value?.type === "error" && typeof value.error === "string") return { type: "error", error: value.error };
    return null;
  } catch {
    return null;
  }
}

export async function streamExplain(
  input: ExplainInput,
  onSentence: (sentence: string, fullText: string) => void,
): Promise<ExplainResult> {
  if (isOffline()) return { status: "failed", text: "", failure: "offline" };

  let response: Response;
  try {
    response = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return { status: "failed", text: "", failure: isOffline() ? "offline" : "unavailable" };
  }

  if (response.status === 403) {
    await response.body?.cancel().catch(() => {});
    return { status: "failed", text: "", failure: "throttled" };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return {
      status: "failed",
      text: "",
      failure: response.status === 429 ? "rate_limited" : "unavailable",
    };
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = parseEvent(line);
        if (!event) return { status: "failed", text, failure: "unavailable" };
        if (event.type === "sentence") {
          text += event.text;
          onSentence(event.text, text);
        } else if (event.type === "done") {
          return text
            ? { status: "done", text }
            : { status: "failed", text: "", failure: "incomplete" };
        } else {
          return { status: "failed", text, failure: FAILURE_BY_ERROR[event.error] ?? "unavailable" };
        }
      }
    }
  } catch {
    return { status: "failed", text, failure: text ? "incomplete" : isOffline() ? "offline" : "unavailable" };
  }

  return { status: "failed", text, failure: text ? "incomplete" : "unavailable" };
}
