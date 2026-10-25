import { errorResponse } from "@/lib/deepseek";
import { buildTermMessages, parseTermRequest } from "@/lib/selection-context";
import { streamSelectionResult } from "@/lib/selection-stream";
import { TERM_MAX_CHARS, TERM_MAX_TOKENS, TERM_PROMPT_VERSION, TERM_REFUSAL_MARKER, TERM_TEMPERATURE } from "@/lib/prompts/term";

/** 语境释义只接收源句与裁剪后的三段，不接收批注或已读白话。 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return errorResponse("bad_request", "请求体不是合法的 JSON"); }
  const parsed = parseTermRequest(body);
  if (!parsed.ok) return errorResponse("bad_request", parsed.reason);
  const input = parsed.value;
  return streamSelectionResult(request, {
    kind: "term", promptVersion: TERM_PROMPT_VERSION, temperature: TERM_TEMPERATURE, maxTokens: TERM_MAX_TOKENS,
    maxChars: TERM_MAX_CHARS, refusalMarker: TERM_REFUSAL_MARKER, messages: buildTermMessages(input), source: input.sentence,
    neighbors: Number(input.context.previous !== null) + Number(input.context.next !== null), hasStructure: input.structure !== null,
    retryFirstTimeout: false,
  });
}
