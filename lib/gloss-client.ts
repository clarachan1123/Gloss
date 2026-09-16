/**
 * 前端调用功能一与结构摘要（G-07）。只在浏览器里用。
 *
 * streamGloss 流式读取 /api/gloss，把接口的错误类型（PRD 3.9 C1–C6）和网络问题（D1、D2）
 * 统一成 GlossFailure，由撑开区翻译成读者看得懂的话。
 * 调用方用 AbortSignal 中止（D3 生成中收起 / D4 离开页面）：中止不算失败，结果里单独标出。
 */

export type GlossFailure =
  /** C1 超过 15 秒没有首字 */
  | "timeout"
  /** C2 上游错误、C4 返回为空，以及请求本身不合法：对读者都是「暂时无法生成」 */
  | "unavailable"
  /** C3 上游限流：接口返回的 429（DeepSeek 那边忙），几秒后就能重试 */
  | "rate_limited"
  /**
   * 被 Vercel WAF 限流规则拦下（`/api/` 路径、按 IP、600 秒 30 次）。WAF 在边缘拦截，返回 403，请求到不了我们的路由；
   * 我们自己的路由从不返回 403，所以 403 只表示这一种情况。只按状态码判断——WAF 响应的头和正文没见过，不据此判别
   */
  | "throttled"
  /** C6 模型拒答 */
  | "refused"
  /** D1 请求发出前就已断网，或请求没能到达服务器且浏览器报告离线 */
  | "offline"
  /** D2 已经开始输出之后断流 */
  | "interrupted";

export interface GlossInput {
  sentence: string;
  before: string[];
  after: string[];
  /** 全书结构摘要；还没算好时为 null，照常发 */
  structure: string | null;
}

export type GlossResult =
  | { status: "done"; text: string }
  /** text 是断流前已经收到的部分，可能为空 */
  | { status: "failed"; failure: GlossFailure; text: string }
  | { status: "aborted" };

/** 接口返回的错误类型 → 读者看到的失败原因（见 app/api/gloss/route.ts） */
const FAILURE_BY_ERROR: Record<string, GlossFailure> = {
  timeout: "timeout",
  api_error: "unavailable",
  empty: "unavailable",
  bad_request: "unavailable",
  rate_limited: "rate_limited",
  refused: "refused",
};

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export async function streamGloss(
  input: GlossInput,
  { signal, onText }: { signal: AbortSignal; onText: (text: string) => void },
): Promise<GlossResult> {
  if (isOffline()) return { status: "failed", failure: "offline", text: "" };

  let response: Response;
  try {
    response = await fetch("/api/gloss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
  } catch {
    if (signal.aborted) return { status: "aborted" };
    return { status: "failed", failure: isOffline() ? "offline" : "unavailable", text: "" };
  }

  // 403 发生在流开始之前，与读流中途断开（interrupted）是两条路径
  if (response.status === 403) {
    await response.body?.cancel().catch(() => {});
    return signal.aborted ? { status: "aborted" } : { status: "failed", failure: "throttled", text: "" };
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (signal.aborted) return { status: "aborted" };
    const failure =
      response.status === 429 ? "rate_limited" : (FAILURE_BY_ERROR[String(payload?.error)] ?? "unavailable");
    return { status: "failed", failure, text: "" };
  }
  if (!response.body) return { status: "failed", failure: "unavailable", text: "" };

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
      onText(text);
    }
  } catch {
    if (signal.aborted) return { status: "aborted" };
    // 服务端在首块之后出错会直接中断响应流，读到这里和网络断开是同一个样子
    return { status: "failed", failure: text ? "interrupted" : isOffline() ? "offline" : "unavailable", text };
  }

  if (signal.aborted) return { status: "aborted" };
  return text ? { status: "done", text } : { status: "failed", failure: "unavailable", text: "" };
}

export interface StructureInput {
  title: string | null;
  headings: string[];
  paragraphs: string[];
}

/**
 * 请求全书结构摘要。拿不到返回 null：摘要只是给功能一的背景，拿不到就不带，点句照常。
 * 包括被 WAF 限流（403）：不给读者任何提示，也不在本次会话里重试，下次开书再请求。
 * 调用方负责按 docId 缓存（lib/storage.ts），每份文档只算一次。
 */
export async function fetchStructure(
  input: StructureInput,
  signal: AbortSignal,
): Promise<{ structure: string; prompt: string } | null> {
  try {
    const response = await fetch("/api/structure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      console.warn("[Gloss] 结构摘要暂时拿不到，点句时不带摘要", { status: response.status });
      return null;
    }
    const payload = (await response.json()) as { structure?: unknown; prompt?: unknown };
    if (typeof payload.structure !== "string" || typeof payload.prompt !== "string") return null;
    return { structure: payload.structure, prompt: payload.prompt };
  } catch (err) {
    if (!signal.aborted) console.warn("[Gloss] 结构摘要请求失败，点句时不带摘要", { err });
    return null;
  }
}
