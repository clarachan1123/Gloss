import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const APP_PORT = 3430;
const MOCK_PORT = 3431;
const DEFAULT_FIRST_TOKEN_DELAY_MS = 12_000;
const configuredDelay = Number(process.env.SLOW_GLOSS_FIRST_TOKEN_DELAY_MS ?? DEFAULT_FIRST_TOKEN_DELAY_MS);
const FIRST_TOKEN_DELAY_MS = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : DEFAULT_FIRST_TOKEN_DELAY_MS;
const configuredStructureDelay = Number(process.env.SLOW_GLOSS_STRUCTURE_DELAY_MS ?? FIRST_TOKEN_DELAY_MS);
const STRUCTURE_DELAY_MS = Number.isFinite(configuredStructureDelay) && configuredStructureDelay >= 0 ? configuredStructureDelay : FIRST_TOKEN_DELAY_MS;
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
    const structure = JSON.parse(raw).max_tokens === 800;
    const delay = structure ? STRUCTURE_DELAY_MS : FIRST_TOKEN_DELAY_MS;
    const responseText = structure
      ? `【模拟结构#${++callNumber}】本地结构摘要。`
      : `【模拟#${++callNumber}】本地慢上游在${delay}毫秒后给出首字。`;
    setTimeout(() => {
      if (closed) return;
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: responseText }, finish_reason: null }] })}\n\n`);
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
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
