/** G-56：只读取定稿标注、评测材料和已生成结果，严格统计说法的原样留存。 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function withoutSpacingAndTerms(value) {
  return value.replace(/[\s⟦⟧]/gu, "");
}

/** 说法自身带标点时，双方都去标点；否则仍要求连续原样出现。 */
export function containsPhrase(output, phrase) {
  const needle = withoutSpacingAndTerms(phrase);
  if (!needle) throw new Error("标注说法不能为空");
  const withPunctuationRemoved = /\p{P}/u.test(needle);
  const normalize = (text) => withPunctuationRemoved
    ? withoutSpacingAndTerms(text).replace(/\p{P}/gu, "")
    : withoutSpacingAndTerms(text);
  return normalize(output).includes(normalize(phrase));
}

function uniqueById(rows, name) {
  if (!Array.isArray(rows)) throw new Error(`${name}必须是数组`);
  const index = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || index.has(row.id)) {
      throw new Error(`${name}含缺失或重复的 id`);
    }
    index.set(row.id, row);
  }
  return index;
}

export function scorePhrases(labels, materials, report, expectedPrompt = null) {
  const labeled = uniqueById(labels?.items, "定稿标注 items");
  const materialById = uniqueById(materials, "评测材料");
  const resultById = uniqueById(report?.items, "结果 items");
  if (expectedPrompt !== null && report.prompt !== expectedPrompt) {
    throw new Error(`提示词版本不符：要求 ${expectedPrompt}，结果为 ${report.prompt}`);
  }
  if (labeled.size !== materialById.size || labeled.size !== resultById.size) {
    throw new Error("定稿标注、评测材料和结果条数不一致");
  }

  const details = [];
  for (const item of labeled.values()) {
    const material = materialById.get(item.id);
    const result = resultById.get(item.id);
    if (!material || !result || material["原句"] !== item["原句"]) {
      throw new Error(`${item.id}：材料或结果缺失，或原句与定稿不一致`);
    }
    if (result.error || typeof result.text !== "string" || !result.text.trim()) {
      throw new Error(`${item.id}：生成失败或白话为空`);
    }
    if (!Array.isArray(item["换"]) || !Array.isArray(item["保留"])) {
      throw new Error(`${item.id}：说法标注不是数组`);
    }
    for (const phrase of item["换"]) {
      details.push({ id: item.id, type: "换", phrase, present: containsPhrase(result.text, phrase) });
    }
    for (const phrase of item["保留"]) {
      details.push({ id: item.id, type: "保留", phrase, present: containsPhrase(result.text, phrase) });
    }
  }

  const swapped = details.filter((detail) => detail.type === "换");
  const kept = details.filter((detail) => detail.type === "保留");
  return {
    prompt: report.prompt,
    items: labeled.size,
    swapTotal: swapped.length,
    swapUnchanged: swapped.filter((detail) => detail.present).length,
    keepTotal: kept.length,
    keepPresent: kept.filter((detail) => detail.present).length,
    details,
  };
}

function option(name) {
  const at = process.argv.indexOf(name);
  if (at < 0 || !process.argv[at + 1] || process.argv[at + 1].startsWith("--")) {
    throw new Error(`缺少 ${name} 路径或参数`);
  }
  return process.argv[at + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [labels, materials, report] = await Promise.all([
    readFile(option("--labels"), "utf8").then(JSON.parse),
    readFile(option("--items"), "utf8").then(JSON.parse),
    readFile(option("--result"), "utf8").then(JSON.parse),
  ]);
  console.log(JSON.stringify(scorePhrases(labels, materials, report, option("--expect-prompt")), null, 2));
}
