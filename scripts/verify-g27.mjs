import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, Module } from "node:module";
import { Window } from "happy-dom";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const modules = new Map();
const mammoth = require("mammoth");
const nodeMammoth = {
  ...mammoth,
  convertToHtml(input, options) {
    return mammoth.convertToHtml("arrayBuffer" in input ? { buffer: Buffer.from(input.arrayBuffer) } : input, options);
  },
};
// 仅本进程内转译，沿用导入解析器及其 detectHeadings，不产生中间文件。
function loadTs(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  modules.set(filename, module);
  module.require = (specifier) => {
    if (specifier === "mammoth") return nodeMammoth;
    if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(filename), specifier);
      return loadTs(target.endsWith(".ts") ? target : target + ".ts");
    }
    return require(specifier);
  };
  const source = readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
  return module.exports;
}

const window = new Window();
globalThis.DOMParser = window.DOMParser;
const { parseDocx } = loadTs(path.join(root, "lib/parse/docx.ts"));
const compact = (text) => text.replace(/\s/g, "");
function answerTitles(markdown) {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = /^#{2,4}[ \t]+(.+)$/.exec(line);
    if (!match) return [];
    const title = match[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
    return ["目录", "注释"].includes(compact(title)) ? [] : [title];
  });
}
function compare(expected, detected) {
  const remaining = new Map();
  for (const title of expected) {
    const key = compact(title);
    const queue = remaining.get(key) ?? [];
    queue.push(title);
    remaining.set(key, queue);
  }
  const wrong = [];
  let correct = 0;
  for (const heading of detected) {
    const queue = remaining.get(compact(heading.text));
    if (queue?.length) { queue.shift(); correct++; }
    else wrong.push(heading.text);
  }
  const missed = [...remaining.values()].flat();
  return { correct, wrong, missed };
}

const BASELINES = {
  "社会哲学概论": [30, 35, 30, 5, 0],
  "社会科学概论": [60, 58, 57, 1, 3],
  "社会进化史": [42, 42, 42, 0, 0],
};

try {
  const directory = process.env.G27_BOOKS_DIR || "D:\\onedrive\\桌面\\素材书";
  const files = readdirSync(directory);
  let passed = true;
  for (const title of ["社会哲学概论", "社会科学概论", "社会进化史"]) {
    const matches = files.filter((name) => name.startsWith(title) && name.endsWith(".docx"));
    if (matches.length !== 1) throw new Error(`${title}: 需要唯一 docx，实际 ${matches.length} 个`);
    const docxName = matches[0];
    const mdName = docxName.replace(/\.docx$/, ".md");
    if (!files.includes(mdName)) throw new Error(`${title}: 缺少同名 md`);
    const buffer = readFileSync(path.join(directory, docxName));
    const { doc } = await parseDocx(new window.File([buffer], docxName));
    const expected = answerTitles(readFileSync(path.join(directory, mdName), "utf8"));
    const { correct, wrong, missed } = compare(expected, doc.headings);
    const deepest = doc.headings.reduce((level, heading) => Math.max(level, heading.level), 0);
    console.log(`${title} 真 ${expected.length} / 识别 ${doc.headings.length} / 对 ${correct} / 误 ${wrong.length} / 漏 ${missed.length} / 最深层级 ${deepest}`);
    for (const text of wrong) console.log("误：" + text);
    for (const text of missed) console.log("漏：" + text);
    if (doc.headings.length !== correct + wrong.length || expected.length !== correct + missed.length) {
      throw new Error(`${title}: 计数恒等式不成立`);
    }
    const actual = [expected.length, doc.headings.length, correct, wrong.length, missed.length];
    const baseline = BASELINES[title];
    if (actual.some((value, index) => value !== baseline[index])) {
      console.error(`${title}: 期望 [真,识别,对,误,漏] ${JSON.stringify(baseline)} / 实际 ${JSON.stringify(actual)}`);
      passed = false;
    }
  }
  if (!passed) throw new Error("计数与 G-27 验收基线不一致");
  console.log("G-27 checks passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : "G-27 verification failed");
  process.exitCode = 1;
} finally {
  await window.happyDOM.close();
}
