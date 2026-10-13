// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { parseTxt, plainTextToDocument } from "./txt";
import { assembleDocument } from "./validate";

it.each(["txt", "paste"] as const)("G-27 %s 识别且 headings 外的字段与旧拆段完全相同", (format) => {
  const raw = "  第一 哲学  \r\n\r\n　正文中 性 状。\r第二 科学\n正文结束。\n ";
  const name = format === "txt" ? "构造.txt" : null;
  const paragraphs = raw.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
  const old = assembleDocument({ paragraphs, headings: [], footnotes: [] }, format, name);
  const doc = plainTextToDocument(raw, format, name);
  expect({ ...doc, headings: [] }).toEqual(old);
  expect(doc.headings).toEqual([
    { paraIndex: 0, level: 1, text: "  第一哲学  " },
    { paraIndex: 2, level: 1, text: "第二科学" },
  ]);
});
it("G-27 parseTxt 文件入口也识别", async () => {
  const doc = await parseTxt(new File(["序言\n正文。"], "构造.txt"));
  expect(doc.headings).toEqual([{ paraIndex: 0, level: 1, text: "序言" }]);
});
