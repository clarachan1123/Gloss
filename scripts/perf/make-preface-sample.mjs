import fs from "node:fs/promises";
import mammoth from "mammoth";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node scripts/perf/make-preface-sample.mjs <preface.docx> <output.txt>");
const { value: html } = await mammoth.convertToHtml({ path: input });
const withoutTables = html.replace(/<table[\s\S]*?<\/table>/gi, "");
const decode = (text) => text
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const paragraphs = [...withoutTables.matchAll(/<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  .flatMap((match) => decode(match[2]).split("\n"))
  .map((line) => line.trim())
  .filter(Boolean);
if (paragraphs.length !== 15) throw new Error(`expected 15 preface paragraphs, got ${paragraphs.length}`);
await fs.writeFile(output, Array.from({ length: 30 }, () => paragraphs).flat().join("\n\n"), "utf8");
console.log(JSON.stringify({ paragraphs: 450, sourceParagraphs: paragraphs.length, output }));
