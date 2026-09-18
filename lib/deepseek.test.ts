import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/gloss/route";
import { AiError, MODEL_FAST, streamChat, type StreamChatOptions } from "./deepseek";
import { MAX_GLOSS_CHARS } from "./output";
import { countChars } from "./parse/validate";
import {
  GLOSS_PROMPT_ARCHIVE,
  GLOSS_PROMPT_VERSION,
  GLOSS_REFUSAL_MARKER,
  GLOSS_SYSTEM_PROMPT,
  GLOSS_TEMPERATURE,
} from "./prompts/gloss";

/**
 * 错误路径（PRD 3.9 C1–C6）在正常使用中永远跑不到——也就意味着它们第一次被真正需要的那天，很可能是坏的。
 * 这里用模拟的 fetch 把每条路径都跑一遍：先测调用层 streamChat，再测 /api/gloss 对外的状态码与错误类型。
 */

const KEY = "test-key-must-never-appear-in-output";
const SENTENCE = "这是一句用来检查日志里不会出现原文的测试句子。";

type FetchInit = RequestInit & { signal: AbortSignal };
let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];

beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", KEY);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(String(line)));
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => void logs.push(String(line)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------------- 模拟上游 ---------------- */

const delta = (content: string, finishReason: string | null = null) => ({
  choices: [{ delta: { content }, finish_reason: finishReason }],
});
const finish = (finishReason: string) => ({ choices: [{ delta: {}, finish_reason: finishReason }] });
const usage = { choices: [], usage: { prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 7, completion_tokens: 3 } };
const DONE = "data: [DONE]";

/** 按 SSE 格式返回；byteByByte 时逐字节送出，检验跨块拼接（含被拆开的 UTF-8 多字节字符） */
function sse(events: (object | string)[], { byteByByte = false } = {}): Response {
  const text = events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}`) + "\n\n").join("");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (byteByByte) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      else controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 上游一直不响应，直到请求被中止 */
function hangUntilAborted(_url: string, init: FetchInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

/** 上游立即返回 200 响应头，但正文一个字也不发，直到请求被中止 */
function headersThenSilence(_url: string, init: FetchInit): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
}

/** 先给一段正文，随后保持沉默；用于锁住首字后断流的既有 D2 路径。 */
function firstThenSilence(_url: string, init: FetchInit): Promise<Response> {
  const first = new TextEncoder().encode("data: " + JSON.stringify(delta("先到的字")) + "\n\n");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
}

const options = (overrides: Partial<StreamChatOptions> = {}): StreamChatOptions => ({
  model: MODEL_FAST,
  messages: [{ role: "user", content: SENTENCE }],
  temperature: 0.7,
  maxTokens: 100,
  signal: new AbortController().signal,
  firstTokenTimeoutMs: 1000,
  idleTimeoutMs: 1000,
  ...overrides,
});

async function collect(pieces: AsyncGenerator<string, void>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of pieces) out.push(piece);
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("预期抛错，实际正常结束");
}

/* ---------------- 调用层：streamChat ---------------- */

describe("streamChat 正常路径", () => {
  it("按顺序产出正文，回调 usage，[DONE] 结束；请求关闭思考模式", async () => {
    fetchMock.mockResolvedValue(sse([": keep-alive", delta("讲白"), delta(""), delta("的话。", "stop"), usage, DONE]));
    const onUsage = vi.fn();
    expect(await collect(streamChat(options({ onUsage })))).toEqual(["讲白", "的话。"]);
    expect(onUsage).toHaveBeenCalledWith({ promptCacheHitTokens: 5, promptCacheMissTokens: 7, completionTokens: 3 });

    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "disabled" },
    });
  });

  it("逐字节到达（UTF-8 被拆开、事件被拆开）也能正确拼接", async () => {
    fetchMock.mockResolvedValue(sse([delta("斯宾诺莎"), delta("的实体。"), DONE], { byteByByte: true }));
    expect((await collect(streamChat(options()))).join("")).toBe("斯宾诺莎的实体。");
  });
});

describe("本地慢上游地址只在开发环境生效", () => {
  it("development 使用 DEEPSEEK_BASE_URL，便于无真实调用地复现首字慢", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEEPSEEK_BASE_URL", "http://127.0.0.1:3431/");
    fetchMock.mockResolvedValue(sse([delta("本地首字。"), DONE]));
    await collect(streamChat(options()));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:3431/chat/completions");
  });

  it("production 忽略 DEEPSEEK_BASE_URL，始终使用官方地址", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEEPSEEK_BASE_URL", "http://127.0.0.1:3431/");
    fetchMock.mockResolvedValue(sse([delta("线上首字。"), DONE]));
    await collect(streamChat(options()));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.deepseek.com/chat/completions");
  });
});

describe("C1 超时", () => {
  it("上游迟迟不响应：到点抛 timeout", async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const error = await rejection(collect(streamChat(options({ firstTokenTimeoutMs: 20 }))));
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).type).toBe("timeout");
  });

  it("响应头到了但一直没有正文：同样算首字超时", async () => {
    fetchMock.mockImplementation(headersThenSilence);
    const error = await rejection(collect(streamChat(options({ firstTokenTimeoutMs: 20 }))));
    expect((error as AiError).type).toBe("timeout");
  });
});

describe("C2 上游错误", () => {
  it.each([400, 401, 402, 422, 500, 503])("HTTP %i → api_error，详情只有状态码", async (status) => {
    fetchMock.mockResolvedValue(new Response("上游回显的请求内容", { status }));
    const error = (await rejection(collect(streamChat(options())))) as AiError;
    expect(error.type).toBe("api_error");
    expect(error.detail).toBe(`HTTP ${status}`);
  });

  it("网络层失败 → api_error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(((await rejection(collect(streamChat(options())))) as AiError).type).toBe("api_error");
  });

  it("流式数据不是合法 JSON → api_error", async () => {
    fetchMock.mockResolvedValue(sse(["data: {坏数据", DONE]));
    expect(((await rejection(collect(streamChat(options())))) as AiError).type).toBe("api_error");
  });

  it("finish_reason 为 insufficient_system_resource → api_error", async () => {
    fetchMock.mockResolvedValue(sse([finish("insufficient_system_resource"), DONE]));
    expect(((await rejection(collect(streamChat(options())))) as AiError).type).toBe("api_error");
  });

  it("没有配置 key → api_error，且不发请求", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(((await rejection(collect(streamChat(options())))) as AiError).type).toBe("api_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("C3 限流 / C6 内容过滤 / 调用方中止", () => {
  it("HTTP 429 → rate_limited", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    expect(((await rejection(collect(streamChat(options())))) as AiError).type).toBe("rate_limited");
  });

  it("finish_reason 为 content_filter → refused", async () => {
    fetchMock.mockResolvedValue(sse([finish("content_filter"), DONE]));
    expect(((await rejection(collect(streamChat(options())))) as AiError).type).toBe("refused");
  });

  it("调用方主动中止：抛原始 AbortError，不伪装成上游错误", async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();
    const pending = rejection(collect(streamChat(options({ signal: controller.signal, firstTokenTimeoutMs: 10_000 }))));
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(AiError);
    expect((error as Error).name).toBe("AbortError");
  });
});

/* ---------------- 接口层：/api/gloss 对外的状态码与错误类型 ---------------- */

const glossRequest = (body: unknown = { sentence: SENTENCE, before: ["前一句。"], structure: "结构摘要。" }) =>
  new Request("http://localhost/api/gloss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(JSON.parse(text).error).toBe(error);
  expect(text).not.toContain(KEY);
  return text;
}

describe("/api/gloss 成功路径", () => {
  it("200 text/plain，流式正文是清洗后的白话", async () => {
    fetchMock.mockResolvedValue(sse([delta("**讲白**"), delta("之后的话，"), delta("说完就停。", "stop"), usage, DONE]));
    const response = await POST(glossRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("讲白之后的话，说完就停。");
  });
});

describe("/api/gloss 实验参数（模型、提示词版本、温度）只在开发环境生效", () => {
  const sentBody = () =>
    JSON.parse(String((fetchMock.mock.calls[0] as [string, FetchInit])[1].body)) as {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
    };
  const withHeaders = (headers: Record<string, string>) => {
    const request = glossRequest();
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
    return request;
  };
  const experiment = {
    "X-Gloss-Model": "deepseek-v4-pro",
    "X-Gloss-Prompt": "gloss-v3",
    "X-Gloss-Temperature": "0.5",
  };

  beforeEach(() => {
    // 每次调用都给一个新的响应：响应体只能读一遍
    fetchMock.mockImplementation(() => Promise.resolve(sse([delta("讲白的话。"), DONE])));
  });

  it("开发环境：合规的值全部生效，响应头如实标出", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await POST(withHeaders(experiment));
    const body = sentBody();
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.temperature).toBe(0.5);
    expect(body.messages[0].content).toBe(GLOSS_PROMPT_ARCHIVE["gloss-v3"]);
    expect(response.headers.get("X-Gloss-Model")).toBe("deepseek-v4-pro");
    expect(response.headers.get("X-Gloss-Prompt")).toBe("gloss-v3");
    expect(response.headers.get("X-Gloss-Temperature")).toBe("0.5");
  });

  it("开发环境：不合规的值一律忽略，回到默认", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const invalid: Record<string, string>[] = [
      { "X-Gloss-Model": "some-expensive-model" },
      { "X-Gloss-Prompt": "gloss-v9" },
      { "X-Gloss-Prompt": "constructor" },
      { "X-Gloss-Temperature": "abc" },
      { "X-Gloss-Temperature": "5" },
      { "X-Gloss-Temperature": "-1" },
    ];
    for (const headers of invalid) {
      fetchMock.mockClear();
      const response = await POST(withHeaders(headers));
      const body = sentBody();
      expect(body.model).toBe(MODEL_FAST);
      expect(body.temperature).toBe(GLOSS_TEMPERATURE);
      expect(body.messages[0].content).toBe(GLOSS_SYSTEM_PROMPT);
      expect(response.headers.get("X-Gloss-Prompt")).toBe(GLOSS_PROMPT_VERSION);
    }
  });

  it("生产环境：实验请求头一律忽略", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(withHeaders(experiment));
    const body = sentBody();
    expect(body.model).toBe(MODEL_FAST);
    expect(body.temperature).toBe(GLOSS_TEMPERATURE);
    expect(body.messages[0].content).toBe(GLOSS_SYSTEM_PROMPT);
    expect(response.headers.get("X-Gloss-Model")).toBe(MODEL_FAST);
    expect(response.headers.get("X-Gloss-Prompt")).toBe(GLOSS_PROMPT_VERSION);
  });
});

describe("/api/gloss 错误路径：每条都有明确的状态码和错误类型", () => {
  it("400 bad_request：请求体不合法", async () => {
    await expectError(await POST(glossRequest("不是 JSON")), 400, "bad_request");
    await expectError(await POST(glossRequest({ sentence: "甲。", after: ["一", "二", "三"] })), 400, "bad_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("C1 两次首字超时：每次 15 秒，中间等 1 秒后才返回 504", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(hangUntilAborted);
    const pending = POST(glossRequest());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await expectError(await pending, 504, "timeout");
    expect(logs.some((line) => line.includes('"event":"gloss_retry"') && line.includes('"retryOutcome":"failure"'))).toBe(true);
  });

  it("C1 不会提前触发：第一次 14.9 秒时还在等", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(hangUntilAborted);
    let settled = false;
    const pending = POST(glossRequest()).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expectError(await pending, 504, "timeout");
  });

  it("第一次首字超时会中止第一次请求，再重试成功", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let firstAborted = false;
    fetchMock
      .mockImplementationOnce((_url: string, init: FetchInit) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => {
            firstAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      )
      .mockResolvedValueOnce(sse([delta("第二次成功。"), DONE]));
    const pending = POST(glossRequest());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(firstAborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.text()).toBe("第二次成功。");
    expect(logs.some((line) => line.includes('"event":"gloss_retry"') && line.includes('"retryOutcome":"success"'))).toBe(true);
  });

  it("重试等待期间读者中止：不发第二次请求", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();
    const request = new Request("http://localhost/api/gloss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence: SENTENCE, before: ["前一句。"], structure: "结构摘要。" }),
      signal: controller.signal,
    });
    const pending = POST(request);
    await vi.advanceTimersByTimeAsync(15_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await pending).status).toBe(499);
    expect(logs.some((line) => line.includes('"event":"gloss_retry"') && line.includes('"retryOutcome":"aborted"'))).toBe(true);
  });

  it("首字后流中超时不自动重试，保留既有断流路径", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(firstThenSilence);
    const response = await POST(glossRequest());
    expect(response.status).toBe(200);
    const text = response.text();
    const rejected = expect(text).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes('"event":"gloss_retry"'))).toBe(false);
    expect(logs.some((line) => line.includes('"event":"gloss_error"') && line.includes('"phase":"streaming"'))).toBe(true);
  });

  it("C2 502 api_error：上游详情不透传给前端", async () => {
    fetchMock.mockResolvedValue(new Response("上游回显的请求内容", { status: 500 }));
    const text = await expectError(await POST(glossRequest()), 502, "api_error");
    expect(text).not.toContain("上游");
    expect(text).not.toContain("500");
  });

  it("C3 429 rate_limited：带 Retry-After: 5", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const response = await POST(glossRequest());
    expect(response.headers.get("Retry-After")).toBe("5");
    await expectError(response, 429, "rate_limited");
  });

  it("C4 502 empty：上游一个字都没给", async () => {
    fetchMock.mockResolvedValue(sse([finish("stop"), DONE]));
    await expectError(await POST(glossRequest()), 502, "empty");
  });

  it("C4 502 empty：只给了 markdown 符号和空白，清洗后为空", async () => {
    fetchMock.mockResolvedValue(sse([delta("  \n**"), delta("\n---\n"), DONE]));
    await expectError(await POST(glossRequest()), 502, "empty");
  });

  it("C6 422 refused：模型输出拒答标记", async () => {
    fetchMock.mockResolvedValue(sse([delta(GLOSS_REFUSAL_MARKER.slice(0, 3)), delta(GLOSS_REFUSAL_MARKER.slice(3)), DONE]));
    await expectError(await POST(glossRequest()), 422, "refused");
  });

  it("C6 422 refused：上游内容过滤", async () => {
    fetchMock.mockResolvedValue(sse([finish("content_filter"), DONE]));
    await expectError(await POST(glossRequest()), 422, "refused");
  });

  it("C5 超长：写满 150 字即截断，并中止上游", async () => {
    fetchMock.mockResolvedValue(sse([...Array.from({ length: 40 }, () => delta("一二三四五六七")), DONE]));
    const response = await POST(glossRequest());
    expect(response.status).toBe(200);
    expect(countChars(await response.text())).toBe(MAX_GLOSS_CHARS);
    const [, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(init.signal.aborted).toBe(true);
    expect(logs.some((line) => line.includes('"event":"gloss_overlength"'))).toBe(true);
  });

  it("所有日志都不含原句、白话正文和 key", async () => {
    fetchMock.mockResolvedValueOnce(sse([delta("独一无二的白话正文标记"), DONE]));
    await (await POST(glossRequest())).text();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await POST(glossRequest());
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const all = logs.join("\n");
    expect(all).not.toContain(SENTENCE);
    expect(all).not.toContain("独一无二的白话正文标记");
    expect(all).not.toContain(KEY);
  });
});
