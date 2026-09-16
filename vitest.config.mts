import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 与 tsconfig 的 paths 保持一致：跨目录一律用 @/ 导入，测试里也要能解析（route 测试依赖它）
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
