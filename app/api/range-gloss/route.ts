import { errorResponse } from "@/lib/deepseek";
import { buildRangeGlossMessages, parseRangeGlossRequest, rangeParameters } from "@/lib/selection-context";
import { streamSelectionResult } from "@/lib/selection-stream";
import { RANGE_PROMPT_VERSION, RANGE_REFUSAL_MARKER, RANGE_TEMPERATURE } from "@/lib/prompts/range";

/** 整句复用由客户端纯逻辑决定；此接口只生成新的范围白话。 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return errorResponse("bad_request", "请求体不是合法的 JSON"); }
  const parsed = parseRangeGlossRequest(body);
  if (!parsed.ok) return errorResponse("bad_request", parsed.reason);
  const input = parsed.value;
  return streamSelectionResult(request, {
    kind: "range", promptVersion: RANGE_PROMPT_VERSION, temperature: RANGE_TEMPERATURE, ...rangeParameters(input.sentenceCount),
    refusalMarker: RANGE_REFUSAL_MARKER, messages: buildRangeGlossMessages(input), source: input.text,
    neighbors: input.before.length + input.after.length, hasStructure: input.structure !== null, retryFirstTimeout: true,
  });
}
