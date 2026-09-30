"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { nextAnalyticsBatch, type AnalyticsDetail } from "@/lib/analytics-events";
import {
  acknowledgeAnalytics,
  enqueueAnalytics,
  isAnalyticsOptedOut,
  pendingAnalytics,
  visitAnalytics,
} from "@/lib/analytics-local";

export default function AnalyticsCollector() {
  const pathname = usePathname();
  const previousPath = useRef<string | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    visitAnalytics();
    const flush = async () => {
      if (sending.current || isAnalyticsOptedOut()) return;
      sending.current = true;
      try {
        for (;;) {
          const batch = nextAnalyticsBatch(pendingAnalytics());
          if (batch.length === 0) break;
          const response = await fetch("/api/analytics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch }),
            keepalive: true,
          });
          if (!response.ok) break;
          if (!acknowledgeAnalytics(batch.map((event) => event.eventId))) break;
        }
      } catch {
        // Pending records remain for the next flush.
      } finally {
        sending.current = false;
      }
    };
    const beacon = () => {
      if (isAnalyticsOptedOut()) return;
      const events = pendingAnalytics();
      for (let offset = 0; offset < events.length;) {
        const batch = nextAnalyticsBatch(events.slice(offset));
        if (batch.length === 0) break;
        const payload = new Blob([JSON.stringify({ events: batch })], { type: "application/json" });
        try { navigator.sendBeacon?.("/api/analytics", payload); } catch { /* Retain the outbox. */ }
        // Keep records until a fetch receives 204; eventId makes retries idempotent.
        offset += batch.length;
      }
    };
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<AnalyticsDetail>).detail;
      if (!detail || !enqueueAnalytics(detail)) return;
      if (pendingAnalytics().length >= 10) void flush();
    };
    const onVisibility = () => { if (document.hidden) beacon(); };
    window.addEventListener("gloss:analytics", onEvent);
    window.addEventListener("pagehide", beacon);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => { void flush(); }, 30_000);
    if (pendingAnalytics().length >= 10) void flush();
    return () => {
      window.removeEventListener("gloss:analytics", onEvent);
      window.removeEventListener("pagehide", beacon);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (previousPath.current !== null && previousPath.current !== pathname && !isAnalyticsOptedOut()) {
      const events = pendingAnalytics();
      for (let offset = 0; offset < events.length;) {
        const batch = nextAnalyticsBatch(events.slice(offset));
        if (batch.length === 0) break;
        try { navigator.sendBeacon?.("/api/analytics", new Blob([JSON.stringify({ events: batch })], { type: "application/json" })); }
        catch { /* Retain the outbox. */ }
        offset += batch.length;
      }
    }
    previousPath.current = pathname;
  }, [pathname]);

  return null;
}
