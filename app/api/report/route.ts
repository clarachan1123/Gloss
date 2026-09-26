import { createHash, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { countChars } from "@/lib/parse/validate";
import { MAX_EXPLAIN_GLOSS_CHARS, MAX_SENTENCE_CHARS } from "@/lib/context";

export const REPORT_TTL_SECONDS = 5_184_000;
export const REPORT_KEY_PREFIX = "gloss:report:v1:";

export interface ReportRecord {
  hash: string;
  sentence: string;
  gloss: string;
  result: "done" | "refused";
  promptVersion: string | null;
  createdAt: string;
}

interface ReportRedis {
  set(key: string, value: ReportRecord, options: { ex: number }): Promise<unknown>;
}

interface ReportRequest {
  hash: string;
  sentence: string;
  gloss: string;
  result: "done" | "refused";
  promptVersion: string | null;
}

type ParsedBody = { ok: true; value: ReportRequest } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): ParsedBody {
  if (!isRecord(body)) return { ok: false };
  const allowed = new Set(["hash", "sentence", "gloss", "result", "promptVersion"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { ok: false };

  const { hash, sentence, gloss, result, promptVersion } = body;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return { ok: false };
  if (typeof sentence !== "string" || countChars(sentence.trim()) === 0 || countChars(sentence) > MAX_SENTENCE_CHARS) {
    return { ok: false };
  }
  if (typeof gloss !== "string" || countChars(gloss) > MAX_EXPLAIN_GLOSS_CHARS) return { ok: false };
  if (result !== "done" && result !== "refused") return { ok: false };
  if (result === "done" && gloss.trim().length === 0) return { ok: false };
  if (result === "refused" && gloss !== "") return { ok: false };
  if (promptVersion !== null && (typeof promptVersion !== "string" || !/^gloss-v\d+$/.test(promptVersion))) {
    return { ok: false };
  }

  const expectedHash = createHash("sha256").update(sentence, "utf8").digest("hex");
  if (hash !== expectedHash) return { ok: false };
  return { ok: true, value: { hash, sentence, gloss, result, promptVersion } };
}

function configuredRedis(): ReportRedis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token, enableTelemetry: false });
}

export function createReportPost(
  dependencies: {
    getRedis: () => ReportRedis | null;
    now?: () => Date;
    uuid?: () => string;
  },
) {
  return async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }

    const parsed = parseBody(body);
    if (!parsed.ok) return Response.json({ error: "bad_request" }, { status: 400 });
    const redis = dependencies.getRedis();
    if (!redis) return Response.json({ error: "unavailable" }, { status: 503 });

    const record: ReportRecord = {
      ...parsed.value,
      createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    };
    try {
      const id = (dependencies.uuid ?? randomUUID)();
      await redis.set(`${REPORT_KEY_PREFIX}${id}`, record, { ex: REPORT_TTL_SECONDS });
    } catch {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    return Response.json({ ok: true }, { status: 200 });
  };
}

export const POST = createReportPost({ getRedis: configuredRedis });
