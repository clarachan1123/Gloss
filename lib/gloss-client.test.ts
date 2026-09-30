import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGloss } from "./gloss-client";

const input = { sentence: "测试。", before: [], after: [], structure: null };
const options = () => ({ signal: new AbortController().signal, onText: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

describe("streamGloss raw error codes", () => {
  it.each([
    [403, null, "throttled", "waf_403"],
    [429, { error: "rate_limited" }, "rate_limited", "upstream_429"],
    [502, { error: "api_error" }, "unavailable", "api_error"],
    [502, { error: "empty" }, "unavailable", "empty"],
  ])("keeps reader failure wording for HTTP %i", async (status, body, failure, rawErrorCode) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status })));
    expect(await streamGloss(input, options())).toEqual({ status: "failed", failure, text: "", rawErrorCode });
  });
});
