/** G-56：用产品分句器，从定稿标注和全书 TXT 生成只供本地评测的上下文。 */
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";

// Node 内置 TypeScript 类型剥离保留原有模块解析规则；只补项目 TS 文件的扩展名。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { segmentParagraphs } = await import("../lib/segment.ts");

function option(name) {
  const at = process.argv.indexOf(name);
  if (at < 0 || !process.argv[at + 1] || process.argv[at + 1].startsWith("--")) {
    throw new Error(`缺少 ${name} 路径`);
  }
  return process.argv[at + 1];
}

const source = await readFile(option("--source"), "utf8");
const labels = JSON.parse(await readFile(option("--labels"), "utf8"));
if (!Array.isArray(labels.items) || labels.items.length !== 31) throw new Error("定稿标注必须有 31 项");

// 与 plainTextToDocument 一致：空行丢弃，非空行内容原样保留。
const paragraphs = source.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
const { sentences } = segmentParagraphs(paragraphs);
const text = (index) => sentences[index].text.trim();
const range = (start, end) =>
  Array.from({ length: Math.max(0, end - start) }, (_, offset) => text(start + offset)).filter(Boolean);
const heading = (sentence) => {
  const paragraph = paragraphs[sentence.paraIndex].trim();
  return paragraph.length <= 30 && !/[。！？；?!;]/.test(paragraph) &&
    /^(?:[一二三四五六七八九十]+(?:[、\s]|$)|绪言(?:\s|$))/.test(paragraph);
};

const headingContext = [];
const items = labels.items.map((item) => {
  if (!Array.isArray(item["换"]) || !Array.isArray(item["保留"])) {
    throw new Error(`${item.id}：说法标注不是数组`);
  }
  const matches = sentences.filter((sentence) => sentence.text.trim() === item["原句"]);
  if (matches.length !== 1) throw new Error(`${item.id}：原句完全匹配 ${matches.length} 次，必须恰好 1 次`);
  for (const phrase of [...item["换"], ...item["保留"]]) {
    if (typeof phrase !== "string" || !item["原句"].includes(phrase)) {
      throw new Error(`${item.id}：标注说法不在原句中`);
    }
  }
  const index = matches[0].index;
  const neighbors = [
    ...sentences.slice(Math.max(0, index - 2), index),
    ...sentences.slice(index + 1, index + 3),
  ];
  if (neighbors.some(heading)) headingContext.push(item.id);
  return {
    ...item,
    "前文": range(Math.max(0, index - 2), index),
    "后文": range(index + 1, Math.min(sentences.length, index + 3)),
  };
});

const swapCount = items.reduce((sum, item) => sum + item["换"].length, 0);
const keepCount = items.reduce((sum, item) => sum + item["保留"].length, 0);
if (swapCount !== 30 || keepCount !== 5) {
  throw new Error(`标注计数不符：换 ${swapCount}、保留 ${keepCount}`);
}
await writeFile(option("--out"), `${JSON.stringify(items, null, 2)}\n`, "utf8");
console.log(`评测项 ${items.length}；换 ${swapCount}；保留 ${keepCount}；全文句数 ${sentences.length}`);
console.log(`前后文含章标题的项：${headingContext.length ? headingContext.join("、") : "无"}`);
