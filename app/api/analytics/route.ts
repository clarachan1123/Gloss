import { ANALYTICS_MAX_BODY_BYTES, validateAnalyticsBatch } from "@/lib/analytics-events";
import { analyticsEnabled, analyticsStore, writeAnalyticsBatch, type AnalyticsStore } from "@/lib/analytics-server";

export function createAnalyticsPost(deps: { enabled?: () => boolean; store?: () => AnalyticsStore } = {}) {
  return async (request: Request): Promise<Response> => {
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ANALYTICS_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return new Response(null, { status: 413 });
      }
      parts.push(chunk.value);
    }
  } catch {
    return new Response(null, { status: 400 });
  }
  let body: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!validateAnalyticsBatch(body)) return new Response(null, { status: 400 });
  if (!(deps.enabled ?? analyticsEnabled)()) return new Response(null, { status: 204 });
  try {
    await writeAnalyticsBatch(body.events, (deps.store ?? analyticsStore)());
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 503 });
  }
  };
}

export const POST = createAnalyticsPost();
