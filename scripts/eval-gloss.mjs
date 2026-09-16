/**
 * 功能一评测：把评测集逐句发给本地 /api/gloss，生成 HTML 报告给 Clara 读；多轮结果可做盲测对照。
 *
 * 用法：先 `npm run dev`，再
 *   跑一轮：node scripts/eval-gloss.mjs [base-url] [--items 文件] [--before-field 字段] [--label 名称]
 *                                        [--model deepseek-v4-pro] [--prompt gloss-v3] [--temperature 0.5]
 *   盲测：  node scripts/eval-gloss.mjs --compare a.json b.json ... [--items 文件] [--before-field 字段]
 *                                        [--judge rank|clear] [--note "写进报告说明的话"]
 * 默认评测集是 test-fixtures/eval20.json。报告写到 test-fixtures/（已被 git 忽略：评测集和模型输出
 * 都含受著作权保护的译文，不进仓库、不发布）。
 *
 * 纪律：
 * - 每句都带原文里真实的前后文，与生产环境的上下文窗口同一条件。只喂目标句，测的是更弱的条件，结果不算数。
 * - 请求体只由「原句」、指定的前文字段、「后文」和下面的手写结构摘要组成。
 *   「Clara原批注_仅供语气参考_非标准答案」绝不发给接口；它只出现在报告里，而且默认折叠——
 *   先读完模型的输出，再决定要不要看批注，否则就不是独立判断。
 * - 评测一律用多版盲测对照，不退回单版（KANBAN G-06）。
 * - 本脚本不读 API key，只调本地接口。
 */

import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set([
  "--model",
  "--prompt",
  "--temperature",
  "--label",
  "--note",
  "--items",
  "--before-field",
  "--judge",
]);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const compareMode = args.includes("--compare");
const positional = args.filter((arg, i) => !arg.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const fromCwd = (file) => new URL(file, `file://${process.cwd()}/`);

/**
 * 实验参数只在本地开发服务器上生效（见 app/api/gloss/route.ts 的 pickVariant），
 * 跑完逐条核对响应头，服务端实际用的和要求的不一致就不写报告。
 */
const OVERRIDES = {
  model: { flag: flag("--model"), header: "X-Gloss-Model" },
  prompt: { flag: flag("--prompt"), header: "X-Gloss-Prompt" },
  temperature: { flag: flag("--temperature"), header: "X-Gloss-Temperature" },
};
/** 同一组参数跑多遍、或同一评测集换不同窗口时，用它区分各轮 */
const LABEL = flag("--label");
const NOTE = flag("--note");
/** 评测集文件；各条至少要有 id、原句、后文，以及 BEFORE_FIELD 指定的前文数组 */
const ITEMS_FILE = flag("--items") ? fromCwd(flag("--items")) : new URL("../test-fixtures/eval20.json", import.meta.url);
/** 发给接口、也显示在报告里的前文字段（窗口实验里同一份数据有「前文2」「前文5」「前文1000字」几种） */
const BEFORE_FIELD = flag("--before-field") ?? "前文";
/** 盲测的判法：rank = 选最好的和不及格的；clear = 逐列判「说清了 / 没说清」 */
const JUDGE = flag("--judge") ?? "rank";
/** 早期结果文件没有记录温度，当时的默认值是 0.7；新结果文件都会记录实际温度 */
const LEGACY_TEMPERATURE = 0.7;
const BASE_URL = ((compareMode ? undefined : positional[0]) ?? "http://localhost:3000").replace(/\/$/, "");
const CLARA_FIELD = "Clara原批注_仅供语气参考_非标准答案";

/**
 * 手写的结构摘要（Clara 提供），不是 /api/structure 的产出：整本书的 docx 不在仓库里。
 * 评测句全部出自同一本书，整轮评测共用这一段——对应生产环境「每份文档只算一次」。
 */
const STRUCTURE =
  "雅各比《论斯宾诺莎的学说》，18 世纪末德国哲学书信体论辩。核心争论是斯宾诺莎主义是否等于宿命论与无神论，涉及实体、样式、充足理由律等概念。";

const countChars = (text) => Array.from(text.replace(/\s/g, "")).length;

/**
 * 硬禁令的机械检查（gloss-v2 起）。只是字面匹配，会误报（例如「其实」「应该」），
 * 所以列出命中的词让人判断，不据此判定通过与否。
 */
const HARD_BANS = [
  { name: "破折号", pattern: /[—–]+/g },
  { name: "分号", pattern: /[；;]/g },
  { name: "双重否定", pattern: /不是不|并非不|并非没有|不能不|不得不|不可不|未必不|未尝不|不无|无不|莫不|没有不|不会不/g },
  { name: "指代词", pattern: /前者|后者|[这那其此该它][们]?.?/g },
];

function checkBans(text) {
  return HARD_BANS.map(({ name, pattern }) => ({ name, hits: [...new Set(text.match(pattern) ?? [])] }));
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/* ---------------- 报告里共用的片段 ---------------- */

function itemHeader(item, index) {
  const parts = [`<b>${escapeHtml(item["编号"] ?? index + 1)}</b>`, `id ${escapeHtml(item.id)}`];
  if (item["出处"]) parts.push(escapeHtml(item["出处"]));
  if (item["难点类型"]) parts.push(`难点：${escapeHtml(item["难点类型"])}`);
  return parts.join(" · ");
}

const contextBlock = (sentences) => `<div class="context">${(sentences ?? []).map(escapeHtml).join("<br>")}</div>`;
const flagLine = (item) => (item["备注"] ? `<p class="flag">⚠ ${escapeHtml(item["备注"])}</p>` : "");
const claraDetails = (item, hint = "") =>
  item[CLARA_FIELD]
    ? `<details><summary>Clara 原批注（仅供语气参考，非标准答案）${hint}</summary><p>${escapeHtml(item[CLARA_FIELD])}</p></details>`
    : "";

const SHARED_CSS = `
  .summary { padding: .6em 1em; border: 1px solid #d9d1bf; background: #fffdf8; font-size: 14px; }
  .summary p { margin: .2em 0; }
  .note { font-size: 13px; color: #7a7466; }
  article { margin: 2.2em 0; padding-top: 1.2em; border-top: 1px solid #d9d1bf; }
  header { font-size: 13px; color: #7a7466; }
  .flag { margin: .3em 0; font-size: 13px; color: #9a3b2e; }
  .context { font-size: 14px; color: #8f897b; }
  .source { margin: .4em 0; }
  details { margin-top: .8em; font-size: 14px; color: #6b6557; }
  summary { cursor: pointer; }`;

/* ---------------- 模式一：跑一轮评测 ---------------- */

async function glossOne(item) {
  // 显式只取这四项，别的字段（尤其是批注、备注）不可能被带进请求
  const body = { sentence: item["原句"], before: item[BEFORE_FIELD], after: item["后文"], structure: STRUCTURE };
  const startedAt = performance.now();
  const result = {
    status: null,
    error: null,
    text: "",
    firstChunkMs: null,
    totalMs: null,
    model: null,
    prompt: null,
    temperature: null,
  };
  const headers = { "Content-Type": "application/json" };
  for (const { flag: value, header } of Object.values(OVERRIDES)) if (value !== null) headers[header] = value;
  try {
    const response = await fetch(`${BASE_URL}/api/gloss`, { method: "POST", headers, body: JSON.stringify(body) });
    result.status = response.status;
    result.model = response.headers.get("x-gloss-model");
    result.prompt = response.headers.get("x-gloss-prompt");
    const temperature = response.headers.get("x-gloss-temperature");
    result.temperature = temperature === null ? null : Number(temperature);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      result.error = [payload.error ?? `HTTP ${response.status}`, payload.message].filter(Boolean).join("：");
    } else {
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (result.firstChunkMs === null) result.firstChunkMs = Math.round(performance.now() - startedAt);
        result.text += value;
      }
    }
  } catch (error) {
    result.error = `连接异常：${error.message}`;
  }
  result.totalMs = Math.round(performance.now() - startedAt);
  return result;
}

function renderReport(rows, meta) {
  const ok = rows.filter((row) => !row.result.error);
  const firsts = ok.map((row) => row.result.firstChunkMs);
  const lengths = ok.map((row) => countChars(row.result.text));
  const summary = [
    `模型 ${escapeHtml(meta.model ?? "未知")} · 提示词 ${escapeHtml(meta.prompt ?? "未知")} · 温度 ${escapeHtml(meta.temperature ?? "未知")} · 前文字段 ${escapeHtml(meta.beforeField)}${meta.label ? ` · ${escapeHtml(meta.label)}` : ""} · ${escapeHtml(meta.date)}`,
    `成功 ${ok.length} / ${rows.length}` + (ok.length < rows.length ? `（失败 ${rows.length - ok.length}）` : ""),
    firsts.length ? `首字延迟 P50 ${percentile(firsts, 50)}ms · P90 ${percentile(firsts, 90)}ms（本地串行实测）` : "",
    lengths.length ? `白话字数 最短 ${Math.min(...lengths)} · 中位 ${percentile(lengths, 50)} · 最长 ${Math.max(...lengths)}` : "",
    ok.length
      ? "硬禁令机械检查（命中的句数，可能误报）：" +
        HARD_BANS.map(({ name }, i) => `${name} ${ok.filter((row) => checkBans(row.result.text)[i].hits.length > 0).length}`).join(" · ")
      : "",
  ]
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join("");

  const items = rows
    .map(({ item, result }, i) => {
      const terms = (item["术语"] ?? []).map((t) => `<span class="term">${escapeHtml(t)}</span>`).join("");
      const bans = result.error ? [] : checkBans(result.text);
      const banLine = bans
        .map(({ name, hits }) => (hits.length ? `<span class="hit">${name}：${hits.map(escapeHtml).join("、")}</span>` : `${name} 0`))
        .join(" · ");
      const gloss = result.error
        ? `<p class="gloss error">未生成：${escapeHtml(result.error)}</p>`
        : `<p class="gloss">${escapeHtml(result.text)}</p><p class="checks">机械检查：${banLine}</p>`;
      const stats = result.error
        ? `HTTP ${result.status ?? "—"} · ${result.totalMs}ms`
        : `${countChars(result.text)} 字 · 首字 ${result.firstChunkMs}ms · 总 ${result.totalMs}ms`;
      return `<article>
  <header>${itemHeader(item, i)}${terms ? ` · 术语：${terms}` : ""}</header>
  ${flagLine(item)}
  ${contextBlock(item[BEFORE_FIELD])}
  <p class="source">${escapeHtml(item["原句"])}<span class="count">原句 ${countChars(item["原句"])} 字</span></p>
  ${contextBlock(item["后文"])}
  <h3>模型白话 <span class="count">${stats}</span></h3>
  ${gloss}
  ${claraDetails(item, "——读完上面再决定要不要展开")}
</article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>功能一评测 ${escapeHtml(meta.prompt ?? "")}</title>
<style>
  body { max-width: 46em; margin: 2em auto; padding: 0 1em; font: 16px/1.9 "Noto Serif SC", "Songti SC", serif; color: #2b2a26; background: #f7f3ea; }
  ${SHARED_CSS}
  .term { display: inline-block; margin: 0 .25em; padding: 0 .4em; border-radius: 3px; background: #e4e8ee; color: #4a5a70; }
  h3 { margin: 1em 0 .2em; font-size: 14px; color: #5a5548; }
  .gloss { margin: 0; padding-left: 1em; border-left: 2px solid #b9ae95; }
  .gloss.error { color: #9a3b2e; }
  .count { margin-left: .8em; font-size: 12px; font-weight: normal; color: #9a9484; }
  .checks { margin: .3em 0 0; font-size: 12px; color: #9a9484; }
  .checks .hit { color: #9a3b2e; }
</style></head><body>
<h1>功能一评测</h1>
<div class="summary">${summary}</div>
<p class="note">结构摘要为手写，不是 /api/structure 的产出：${escapeHtml(STRUCTURE)}</p>
${items}
</body></html>`;
}

const showPath = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // 本地时间：文件名要和你看表时的日期对得上
  return {
    stamp: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`,
    date: now.toLocaleString("zh-CN", { hour12: false }),
  };
}

async function runEval() {
  const items = JSON.parse(await readFile(ITEMS_FILE, "utf8"));
  const missing = items.filter((item) => !Array.isArray(item[BEFORE_FIELD]));
  if (missing.length) throw new Error(`评测集里有 ${missing.length} 条缺少前文字段「${BEFORE_FIELD}」`);

  const rows = [];
  for (const [i, item] of items.entries()) {
    const result = await glossOne(item);
    rows.push({ item, result });
    const status = result.error ? `失败 ${result.error}` : `${countChars(result.text)} 字 · 首字 ${result.firstChunkMs}ms`;
    console.log(`[${i + 1}/${items.length}] id ${item.id} · ${status}`);
  }

  const first = rows.find((row) => row.result.prompt)?.result ?? {};
  for (const [key, { flag: value }] of Object.entries(OVERRIDES)) {
    if (value === null) continue;
    const actual = new Set(rows.map((row) => row.result[key]).filter((v) => v !== null));
    const expected = key === "temperature" ? Number(value) : value;
    if (actual.size !== 1 || !actual.has(expected)) {
      throw new Error(`要求 ${key}=${value}，服务端实际是 ${[...actual].join("、") || "未知"}：结果不作数，未写报告`);
    }
  }
  const { stamp, date } = timestamp();
  const meta = {
    model: first.model,
    prompt: first.prompt,
    temperature: first.temperature,
    label: LABEL,
    beforeField: BEFORE_FIELD,
    items: showPath(ITEMS_FILE),
    date,
  };
  // 早先报告的默认参数不写进文件名；改了哪个才标哪个
  const modelTag = first.model && first.model !== "deepseek-flash" ? `-${first.model}` : "";
  const temperatureTag = first.temperature !== null && first.temperature !== LEGACY_TEMPERATURE ? `-t${first.temperature}` : "";
  const labelTag = LABEL ? `-${LABEL}` : "";
  const base = `../test-fixtures/eval-gloss-${first.prompt ?? "unknown"}${modelTag}${temperatureTag}${labelTag}-${stamp}`;
  const htmlFile = new URL(`${base}.html`, import.meta.url);
  await writeFile(htmlFile, renderReport(rows, meta), "utf8");
  // 另存一份结构化结果，供多版本盲测对照（--compare）
  await writeFile(
    new URL(`${base}.json`, import.meta.url),
    JSON.stringify(
      { ...meta, items: rows.map(({ item, result }) => ({ id: item.id, text: result.text, error: result.error })) },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`报告：${showPath(htmlFile)}`);
  if (rows.some((row) => row.result.error)) process.exitCode = 1;
}

/* ---------------- 模式二：多版本盲测对照 ---------------- */

/**
 * 把同一句的多个版本并排放，每句独立随机打乱，只标甲乙丙，不标版本，也不显示字数和机械检查——
 * 任何能反推版本的线索都不放进页面。对照关系单独写进 key 文件。
 * 目的：有版本标签在手，人会不自觉地做「哪个更好」的比较，而不是「说清楚了没有」的判断。
 */
const COLUMN_LABELS = ["甲", "乙", "丙", "丁", "戊"];

const JUDGE_TEXT = {
  rank: [
    "读法：每句先读原句，再读各列，选出「最好的一个」和「不及格的若干个」。判据是读者不回头看原句能不能看懂这一句，不是哪个读起来更顺。",
    "记下来的格式：<code>3: 乙最好，丙不及格</code>。全部选完之后我再解码是哪个版本。",
  ],
  clear: [
    "读法：每句先读原句，再逐列判「说清了 / 没说清」。判据是读者不回头看原句，能不能知道这一句在说什么、里面的指代指的是什么。",
    "记下来的格式：<code>6: 甲说清了，乙丙没说清</code>。全部判完之后我再解码是哪个配置。",
  ],
};

const versionOf = (run) =>
  `${run.prompt}@${run.model}@t${run.temperature ?? LEGACY_TEMPERATURE}${run.label ? `#${run.label}` : ""}`;

async function buildBlindReport(files) {
  if (files.length < 2) throw new Error("--compare 至少要两个结果文件");
  if (!JUDGE_TEXT[JUDGE]) throw new Error(`--judge 只能是 ${Object.keys(JUDGE_TEXT).join(" / ")}`);
  const runs = [];
  for (const file of files) runs.push(JSON.parse(await readFile(fromCwd(file), "utf8")));
  const items = JSON.parse(await readFile(ITEMS_FILE, "utf8"));
  const { stamp, date } = timestamp();

  const key = {};
  const blocks = items
    .map((item, index) => {
      const columns = runs
        .map((run) => ({ version: versionOf(run), entry: run.items.find((row) => row.id === item.id) }))
        .filter((column) => column.entry);
      if (columns.length !== runs.length) return "";
      for (let i = columns.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [columns[i], columns[j]] = [columns[j], columns[i]];
      }
      key[item.id] = columns.map((column, i) => `${COLUMN_LABELS[i]}=${column.version}`);
      const cells = columns
        .map(
          (column, i) =>
            `<div class="cell"><h4>${COLUMN_LABELS[i]}</h4><p>${escapeHtml(column.entry.error ? `未生成：${column.entry.error}` : column.entry.text)}</p></div>`,
        )
        .join("");
      return `<article>
  <header>${itemHeader(item, index)}</header>
  ${flagLine(item)}
  ${contextBlock(item[BEFORE_FIELD])}
  <p class="source">${escapeHtml(item["原句"])}</p>
  ${contextBlock(item["后文"])}
  <div class="grid">${cells}</div>
  ${claraDetails(item)}
</article>`;
    })
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>功能一盲测对照 ${escapeHtml(stamp)}</title>
<style>
  body { max-width: 60em; margin: 2em auto; padding: 0 1em; font: 16px/1.9 "Noto Serif SC", "Songti SC", serif; color: #2b2a26; background: #f7f3ea; }
  ${SHARED_CSS}
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15em, 1fr)); gap: 1em; margin-top: 1em; }
  .cell { padding-left: .8em; border-left: 2px solid #b9ae95; }
  .cell h4 { margin: 0 0 .2em; font-size: 13px; color: #7a7466; }
  .cell p { margin: 0; font-size: 15px; }
</style></head><body>
<h1>功能一盲测对照</h1>
<div class="summary">
  <p>${escapeHtml(date)} · 每句 ${runs.length} 个版本，顺序每句独立打乱，页面上没有任何版本信息。</p>
  <p>${JUDGE_TEXT[JUDGE][0]}</p>
  <p>${JUDGE_TEXT[JUDGE][1]}</p>
  ${NOTE ? `<p>说明：${escapeHtml(NOTE)}</p>` : ""}
</div>
${blocks}
</body></html>`;

  const htmlFile = new URL(`../test-fixtures/eval-blind-${stamp}.html`, import.meta.url);
  const keyFile = new URL(`../test-fixtures/eval-blind-${stamp}-key.json`, import.meta.url);
  await writeFile(htmlFile, html, "utf8");
  await writeFile(keyFile, JSON.stringify({ date, files, key }, null, 2), "utf8");
  console.log(`盲测报告：${showPath(htmlFile)}`);
  console.log(`对照关系（先别看）：${showPath(keyFile)}`);
}

if (compareMode) await buildBlindReport(positional);
else await runEval();
