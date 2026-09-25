import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const APP_PORT = 3430;
const MOCK_PORT = 3431;
const DEFAULT_FIRST_TOKEN_DELAY_MS = 12_000;
const configuredDelay = Number(process.env.SLOW_GLOSS_FIRST_TOKEN_DELAY_MS ?? DEFAULT_FIRST_TOKEN_DELAY_MS);
const FIRST_TOKEN_DELAY_MS = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : DEFAULT_FIRST_TOKEN_DELAY_MS;
const configuredStructureDelay = Number(process.env.SLOW_GLOSS_STRUCTURE_DELAY_MS ?? FIRST_TOKEN_DELAY_MS);
const STRUCTURE_DELAY_MS = Number.isFinite(configuredStructureDelay) && configuredStructureDelay >= 0 ? configuredStructureDelay : FIRST_TOKEN_DELAY_MS;
const CHUNK_DELAY_MS = 180;
const SLOW_TEXT = "这一段白话会一点一点写出来，读者可以在它增长时滚动页面，观察正在阅读的那一行是否留在原处。".repeat(4).slice(0, 148);
let callNumber = 0;

const copied = spawnSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "inherit" });
if (copied.status !== 0) process.exit(copied.status ?? 1);

const mock = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  let closed = false;
  response.on("close", () => {
    closed = true;
  });
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const payload = JSON.parse(raw);
    if (payload.messages?.some((message) => message.content?.endsWith("G40 认证预检。"))) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const structure = payload.max_tokens === 800;
    const delay = structure ? STRUCTURE_DELAY_MS : FIRST_TOKEN_DELAY_MS;
    const responseText = structure
      ? `【模拟结构#${++callNumber}】本地结构摘要。`
      : SLOW_TEXT;
    setTimeout(() => {
      if (closed) return;
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      const chunks = structure ? [responseText] : Array.from({ length: Math.ceil(Array.from(responseText).length / 8) }, (_, index) => Array.from(responseText).slice(index * 8, index * 8 + 8).join(""));
      let index = 0;
      const sendNext = () => {
        if (closed) return;
        if (index < chunks.length) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index++] }, finish_reason: null }] })}\n\n`);
          setTimeout(sendNext, CHUNK_DELAY_MS);
        } else {
          response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
          response.end("data: [DONE]\n\n");
        }
      };
      sendNext();
    }, delay);
  });
});

mock.listen(MOCK_PORT, "127.0.0.1", () => {
  console.info(`本地慢上游已启动：白话首字延迟 ${FIRST_TOKEN_DELAY_MS / 1000} 秒，结构摘要延迟 ${STRUCTURE_DELAY_MS / 1000} 秒；Next 将在 http://127.0.0.1:${APP_PORT} 启动。`);
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", String(APP_PORT)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEEPSEEK_API_KEY: "local-test-invalid",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    },
  });
  const shutdown = () => {
    next.kill();
    mock.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  next.once("exit", (code) => {
    mock.close(() => process.exit(code ?? 0));
  });
});
