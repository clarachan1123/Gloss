import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { RANGE_SYSTEM_PROMPT } from "./range";
it("range-v0 运行时正文逐字匹配已批准哈希", () => {
  expect(createHash("sha256").update(RANGE_SYSTEM_PROMPT, "utf8").digest("hex")).toBe("8ff55140ad762208e486951f44f859d05df67b842dfb0e11ec47b96341b88947");
});
