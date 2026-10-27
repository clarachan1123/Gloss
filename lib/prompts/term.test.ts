import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { TERM_PROMPT_ARCHIVE, TERM_PROMPT_VERSION, TERM_SYSTEM_PROMPT } from "./term";
it("term-v1 生效版本与运行时正文逐字匹配已批准哈希", () => {
  expect(TERM_PROMPT_VERSION).toBe("term-v1");
  expect(createHash("sha256").update(TERM_SYSTEM_PROMPT, "utf8").digest("hex")).toBe("f051806ff6ebe58d1fad15abfd1c21448995e421dd5ec9b443f5caa0134334f3");
});
it("term-v0 存档运行时正文逐字匹配原批准哈希", () => {
  expect(createHash("sha256").update(TERM_PROMPT_ARCHIVE["term-v0"], "utf8").digest("hex")).toBe("7ef17af684fd67d1f30473f786a79a369389e2911e6390c9400a5e04bb59dbbd");
});
