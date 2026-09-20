// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamExplain } from "@/lib/explain-client";
import { segmentParagraphs } from "@/lib/segment";
import { loadExplanations, saveExplanation } from "@/lib/storage";
import { EXPLAIN_REFUSAL_MARKER, EXPLAIN_SYSTEM_PROMPT } from "@/lib/prompts/explain";
import { POST, type ExplainStreamEvent } from "./route";

const input = {
  sentence: "目标句。",
  context: { previous: "上一段。", current: "当前段里有目标句。", next: "下一段。" },
  gloss: "读者已经明白的字面意思。",
  structure: "结构摘要。",
};

function upstreamResponse(contentChunks: string[], splitTransport = false): Response {
  const raw = contentChunks
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
    .join("") + "data: [DONE]\n\n";
  const transportChunks = splitTransport ? Array.from(raw) : [raw];
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of transportChunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

function request(): Request {
  return new Request("http://localhost/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function events(response: Response): Promise<ExplainStreamEvent[]> {
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExplainStreamEvent);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("DEEPSEEK_API_KEY", "local-test-invalid");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("G-11 /api/explain 逐句安全流", () => {
  it("固定 prompt 最前、结构摘要其次、三段上下文、白话、目标句最后，并使用强模型关闭 thinking", async () => {
    let upstreamBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return upstreamResponse(["整体意思已经说清。"]);
    }));

    await (await POST(request())).text();
    expect(upstreamBody).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 400,
      stream: true,
    });
    const messages = (upstreamBody as unknown as { messages: { role: string; content: string }[] }).messages;
    expect(messages).toEqual([
      { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
      { role: "user", content: "【全书结构摘要】\n结构摘要。" },
      { role: "user", content: "【上一段】\n上一段。\n\n【当前段】\n当前段里有目标句。\n\n【下一段】\n下一段。" },
      { role: "user", content: "【读者已读白话】\n读者已经明白的字面意思。" },
      { role: "user", content: "【目标句】\n目标句。" },
    ]);
  });

  it("虚构文本的完整 messages 数组可作为真实请求结构样例，未提供白话仍保留固定消息位置", async () => {
    const fictional = {
      sentence: "于是港口暂缓开放。",
      context: { previous: "晨雾遮住了航道。", current: "值班员看见信号旗没有升起。于是港口暂缓开放。", next: "午后风向改变，船只重新排队。" },
      gloss: null,
      structure: "虚构海港故事：天气变化让港口的秩序不断调整。",
    };
    let upstreamBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return upstreamResponse(["这句把决定落到具体措施上。"]);
    }));

    await (await POST(new Request("http://localhost/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fictional) }))).text();
    expect((upstreamBody as unknown as { messages: unknown[] }).messages).toEqual([
      { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
      { role: "user", content: "【全书结构摘要】\n虚构海港故事：天气变化让港口的秩序不断调整。" },
      { role: "user", content: "【上一段】\n晨雾遮住了航道。\n\n【当前段】\n值班员看见信号旗没有升起。于是港口暂缓开放。\n\n【下一段】\n午后风向改变，船只重新排队。" },
      { role: "user", content: "【读者已读白话】\n未提供白话" },
      { role: "user", content: "【目标句】\n于是港口暂缓开放。" },
    ]);
  });

  it.each([
    ["逐字", Array.from("甲句。“乙句！”丙句？"), false],
    ["跨句末标点", ["甲句", "。乙", "句！丙句", "？"], false],
    ["跨闭引号", ["“甲句。", "”乙句！", "」丙句？"], false],
    ["句末与闭引号分属两个 chunk", ["“甲句。", "”", "乙句！"], false],
    ["ASCII 闭引号单独成 chunk", ["\"甲句。", "\"", "乙句！"], false],
    ["SSE 传输本身逐字切分", ["甲句。“乙句！”丙句？"], true],
  ] as const)("%s时不丢字、不重复，闭引号不落到下一句", async (_name, chunks, splitTransport) => {
    const full = chunks.join("");
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse([...chunks], splitTransport)));

    const output = await events(await POST(request()));
    const sentences = output.filter((event): event is Extract<ExplainStreamEvent, { type: "sentence" }> => event.type === "sentence");
    expect(sentences.map((event) => event.text).join("")).toBe(full);
    expect(sentences.slice(1).every((event) => !/^[”’」』】）》）］]/u.test(event.text))).toBe(true);
    expect(output.at(-1)).toEqual({ type: "done" });
  });

  it("先清洗标题、列表和行内 Markdown，再逐句发送；清洗后仍不丢字、不重复", async () => {
    const chunks = ["# **甲句。", "**\n- 乙句！\n> `丙句？`"];
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(chunks)));

    const output = await events(await POST(request()));
    const sentences = output.filter((event): event is Extract<ExplainStreamEvent, { type: "sentence" }> => event.type === "sentence");
    const displayed = sentences.map((event) => event.text).join("");
    expect(displayed).toBe("甲句。乙句！丙句？");
    expect(displayed).not.toMatch(/[#*`>-]/u);
    expect(output.at(-1)).toEqual({ type: "done" });
  });

  it.each([
    ["首个 chunk", [EXPLAIN_REFUSAL_MARKER]],
    ["标记切在两个 chunk", [EXPLAIN_REFUSAL_MARKER.slice(0, 3), EXPLAIN_REFUSAL_MARKER.slice(3)]],
  ] as const)("拒答标记在%s时不发正文并返回 refused", async (_name, chunks) => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return upstreamResponse([...chunks]);
    }));

    expect(await events(await POST(request()))).toEqual([{ type: "error", error: "refused" }]);
    expect(signal?.aborted).toBe(true);
  });

  it("延伸句式从命中句起丢弃，中止上游，已发完整前缀成功结束", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return upstreamResponse(["核心意思完整。", "值得一提的是，这里开始延伸。", "不会继续发送。"]);
    }));

    const output = await events(await POST(request()));
    expect(output).toEqual([{ type: "sentence", text: "核心意思完整。" }, { type: "done" }]);
    expect(signal?.aborted).toBe(true);
    const log = vi.mocked(console.info).mock.calls
      .flat()
      .map(String)
      .find((line) => line.includes('"event":"explain_extension_cut"'));
    expect(JSON.parse(log ?? "{}")).toMatchObject({
      event: "explain_extension_cut",
      outputChars: 7,
      sentenceCount: 1,
    });
  });

  it("加入下一完整句会超过 250 字时丢弃整句并中止；第一句超过上限则失败", async () => {
    const prefix = `${"甲".repeat(120)}。`;
    const overflow = `${"乙".repeat(130)}。`;
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse([prefix, overflow])));
    expect(await events(await POST(request()))).toEqual([
      { type: "sentence", text: prefix },
      { type: "done" },
    ]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"event":"explain_truncated"'));

    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse([`${"丙".repeat(251)}。`])));
    expect(await events(await POST(request()))).toEqual([{ type: "error", error: "incomplete" }]);
  });

  it("[DONE] 留有半句时保留已发完整句但以 incomplete 结束", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(["已经完整的一句。后面没有写完"])));
    const output = await events(await POST(request()));
    expect(output).toEqual([
      { type: "sentence", text: "已经完整的一句。" },
      { type: "error", error: "incomplete" },
    ]);
  });

  it("前端逐句拼接文本与写入 localStorage 的文本逐字相同", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(["第一句。", "“第二句！”", "第三句？"])));
    const routeResponse = await POST(request());
    vi.stubGlobal("fetch", vi.fn(async () => routeResponse));

    let displayed = "";
    const result = await streamExplain(input, (_sentence, fullText) => {
      displayed = fullText;
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    const sentence = segmentParagraphs([input.sentence]).sentences[0];
    await saveExplanation("book-1", sentence, result.text);
    const stored = (await loadExplanations("book-1", [sentence])).get(0)?.text;
    expect(stored).toBe(displayed);
    expect(stored).toBe("第一句。“第二句！”第三句？");
  });
});
