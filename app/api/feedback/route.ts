import { Redis } from "@upstash/redis";
import { FEEDBACK_BODY_MAX, FEEDBACK_CONTACT_MAX, feedbackLength } from "@/lib/feedback";

export const FEEDBACK_KEY_PREFIX = "gloss:feedback:v1:";
export const FEEDBACK_TTL_SECONDS = 15_552_000;
const MAX_BODY_BYTES = 16_384;

export interface FeedbackRecord {
  id: string;
  body: string;
  contact: string;
  source: "landing" | "shelf" | "reader";
  createdAt: string;
}
interface FeedbackRedis {
  set(key: string, value: FeedbackRecord, options: { nx: true; ex: number }): Promise<unknown>;
}
function configuredRedis(): FeedbackRedis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token, enableTelemetry: false }) : null;
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("bad_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("bad_request");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("bad_request");
      }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function parseBody(value: unknown): Omit<FeedbackRecord, "createdAt"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || keys.some(k => !["id", "body", "contact", "source"].includes(k))) return null;
  const { id, body, contact, source } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  if (typeof body !== "string" || feedbackLength(body) === 0 || feedbackLength(body) > FEEDBACK_BODY_MAX) return null;
  if (typeof contact !== "string" || feedbackLength(contact) > FEEDBACK_CONTACT_MAX) return null;
  if (source !== "landing" && source !== "shelf" && source !== "reader") return null;
  return { id, body: body.trim(), contact: contact.trim(), source };
}
export function createFeedbackPost(deps: {
  enabled?: () => boolean;
  getRedis?: () => FeedbackRedis | null;
  now?: () => Date;
} = {}) {
  return async function POST(request: Request): Promise<Response> {
    if (!(deps.enabled ?? (() => process.env.FEEDBACK_ENABLED === "1"))()) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    let parsed: ReturnType<typeof parseBody>;
    try { parsed = parseBody(await readJson(request)); }
    catch { return Response.json({ error: "bad_request" }, { status: 400 }); }
    if (!parsed) return Response.json({ error: "bad_request" }, { status: 400 });
    try {
      const redis = (deps.getRedis ?? configuredRedis)();
      if (!redis) return Response.json({ error: "unavailable" }, { status: 503 });
      const date = new Date((deps.now ?? (() => new Date()))());
      date.setUTCSeconds(0, 0);
      await redis.set(FEEDBACK_KEY_PREFIX + parsed.id, { ...parsed, createdAt: date.toISOString() }, { nx: true, ex: FEEDBACK_TTL_SECONDS });
      return Response.json({ ok: true }, { status: 200 });
    } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
  };
}
export const POST = createFeedbackPost();
