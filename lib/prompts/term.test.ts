import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { TERM_SYSTEM_PROMPT } from "./term";
it("term-v0 运行时正文逐字匹配已批准哈希", () => {
  expect(createHash("sha256").update(TERM_SYSTEM_PROMPT, "utf8").digest("hex")).toBe("7ef17af684fd67d1f30473f786a79a369389e2911e6390c9400a5e04bb59dbbd");
});
