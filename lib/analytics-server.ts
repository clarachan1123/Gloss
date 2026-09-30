import { Redis } from "@upstash/redis";
import {
  ANALYTICS_PREFIX,
  ANALYTICS_TTL_SECONDS,
  type AnalyticsDetail,
  type AnalyticsEvent,
  validateAnalyticsEvent,
} from "./analytics-events";
import type { Usage } from "./deepseek";

export interface AnalyticsStore {
  set(key: string, value: Record<string, unknown>, options: { ex: number; nx: true }): Promise<unknown>;
}

export const analyticsEnabled = () => process.env.ANALYTICS_ENABLED === "1";
export const minuteTimestamp = (date = new Date()) => date.toISOString().slice(0, 16) + "Z";

export function analyticsStore(): AnalyticsStore {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Analytics Redis is not configured");
  return new Redis({ url, token, enableTelemetry: false });
}

export async function writeAnalyticsBatch(events: readonly AnalyticsEvent[], store: AnalyticsStore = analyticsStore()): Promise<void> {
  for (const event of events) {
    const record = { ...event, createdAt: minuteTimestamp() };
    await store.set(`${ANALYTICS_PREFIX}${event.eventId}`, record, { ex: ANALYTICS_TTL_SECONDS, nx: true });
  }
}

export async function recordServerAnalytics(detail: AnalyticsDetail, store?: AnalyticsStore): Promise<void> {
  if (!analyticsEnabled()) return;
  const event = { ...detail, eventId: crypto.randomUUID() };
  if (!validateAnalyticsEvent(event)) return;
  try {
    await writeAnalyticsBatch([event], store ?? analyticsStore());
  } catch {
    // Analytics cannot change a generation response; errors contain no document or credentials.
    console.warn("[Gloss] Analytics write failed");
  }
}

export function aiUsageFields(usage: Usage | null) {
  return {
    cacheHitTokens: usage?.promptCacheHitTokens ?? null,
    cacheMissTokens: usage?.promptCacheMissTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    usageKnown: usage !== null,
  };
}

export function aiFailureCode(type: string): "C1" | "C2" | "C3" | "C4" | "C6" | "OTHER" {
  if (type === "timeout") return "C1";
  if (type === "rate_limited") return "C3";
  if (type === "empty") return "C4";
  if (type === "refused") return "C6";
  if (type === "api_error") return "C2";
  return "OTHER";
}
