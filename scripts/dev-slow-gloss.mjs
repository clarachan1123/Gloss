import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const APP_PORT = 3430;
const MOCK_PORT = 3431;
const FIRST_TOKEN_DELAY_MS = 12_000;

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
  setTimeout(() => {
    if (closed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    response.write('data: {"choices":[{"delta":{"content":"本地慢上游在十二秒后给出首字。"},"finish_reason":null}]}\n\n');
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  }, FIRST_TOKEN_DELAY_MS);
});

mock.listen(MOCK_PORT, "127.0.0.1", () => {
  console.info(`本地慢上游已启动：首字延迟 ${FIRST_TOKEN_DELAY_MS / 1000} 秒；Next 将在 http://127.0.0.1:${APP_PORT} 启动。`);
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
