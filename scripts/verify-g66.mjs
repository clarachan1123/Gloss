/**
 * G-66 production checks. Both services must run with local-test-invalid.
 * Run: node scripts/verify-g66.mjs
 * Branch/base origins may be overridden with G66_ORIGIN / G66_BASE_ORIGIN.
 * Fresh Edge profiles, analytics opt-out, no API requests. No rounding of glyph deltas.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = process.env.G66_ORIGIN ?? "http://127.0.0.1:3469";
const BASE_ORIGIN = process.env.G66_BASE_ORIGIN ?? "http://127.0.0.1:3470";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WIDTHS = [375, 506, 768, 1024, 1280];
const STYLE_PROPERTIES = ["fontFamily", "fontSize", "lineHeight", "letterSpacing", "textAlign", "textIndent", "color", "wordBreak", "lineBreak"];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const assert = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? "" : ": " + JSON.stringify(detail))); };
async function waitFor(read, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await read()) return; await sleep(100); }
  throw Error("Timed out: " + label);
}
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((done, fail) => { this.socket.onopen = done; this.socket.onerror = fail; });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.fail(Error(message.error.message)); else pending.done(message.result);
    };
    this.socket.onclose = () => { for (const p of this.pending.values()) p.fail(Error("Edge CDP closed")); this.pending.clear(); };
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(Error("CDP timeout: " + method)); }, 40000);
      this.pending.set(id, { done: v => { clearTimeout(timer); done(v); }, fail: e => { clearTimeout(timer); fail(e); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}
const evaluate = (cdp, fn, ...args) => cdp.evaluate("(" + fn.toString() + ")(" + args.map(a => JSON.stringify(a)).join(",") + ")", true);
async function singlePage(browser, id) {
  const { targetInfos } = await browser.call("Target.getTargets");
  const pages = targetInfos.filter(t => t.type === "page");
  assert(pages.length === 1 && pages[0].targetId === id, "Only one page", pages.map(p => p.url));
}
function setup() {
  localStorage.setItem("gloss:analytics:optout", "1");
  localStorage.setItem("gloss:sample:breathed", "1");
  window.__g66 = { hidden: document.hidden };
  addEventListener("visibilitychange", () => { if (document.hidden) window.__g66.hidden = true; });
  window.__g66.snapshot = () => {
    if (document.hidden || window.__g66.hidden) throw Error("Hidden during measurement");
    const chars = [];
    for (const span of document.querySelectorAll(".reader-body .sentence")) {
      if (getComputedStyle(span).visibility !== "visible" || span.closest("[inert]")) continue;
      const node = span.firstChild, para = span.closest("[data-para]");
      if (!(node instanceof Text) || !para) throw Error("Invalid real sentence");
      let offset = 0;
      for (const char of node.data) {
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + char.length);
        const r = range.getBoundingClientRect();
        chars.push({ key: para.dataset.para + ":" + (Number(span.dataset.offset) + offset),
          para: Number(para.dataset.para), offset: Number(span.dataset.offset) + offset, index: Number(span.dataset.index),
          char, x: r.left, y: r.top, bottom: r.bottom, width: r.width, height: r.height });
        offset += char.length;
      }
    }
    return chars;
  };
}
async function ready(cdp) {
  await waitFor(() => cdp.evaluate("document.readyState==='complete'&&document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"11\"]')"), "sample reader");
  await cdp.evaluate("document.fonts.ready", true);
  await settle(cdp);
}
async function settle(cdp) { await cdp.evaluate("new Promise(r=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(r)),300))", true); }
async function reload(cdp) { await cdp.call("Page.reload"); await ready(cdp); }
async function close(cdp) { await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await settle(cdp); }
async function choose(cdp, selector, label) {
  await evaluate(cdp, (selector, label) => {
    const button = [...document.querySelectorAll(selector)].find(b => b.textContent.trim() === label);
    if (!button || button.disabled) throw Error("Missing enabled button " + label);
    button.click();
  }, selector, label);
  await settle(cdp);
}
async function open(cdp, index) {
  await evaluate(cdp, index => {
    const span = document.querySelector('.sentence[data-index="' + index + '"]');
    if (!span) throw Error("Missing source");
    span.scrollIntoView({ block: "center", behavior: "instant" }); span.click();
  }, index);
  await waitFor(() => cdp.evaluate('!!document.querySelector(\'.gloss-panel[data-sentence-index="' + index + '"][data-state="done"]\')'), "sample gloss");
  await settle(cdp);
}
async function operation(cdp, label, kind, index, which = "first") {
  // Move first, then wait 300ms, then obtain the baseline. The selected key is stable across splitting.
  const key = await evaluate(cdp, (index, which) => {
    const chars = window.__g66.snapshot().filter(c => c.index === index && c.char.trim());
    const c = which === "middle" ? chars[Math.floor(chars.length / 2)] : which === "end" ? chars.at(-2) ?? chars.at(-1) : chars[0];
    if (!c) throw Error("Missing selected glyph " + index);
    window.scrollTo({ top: scrollY + c.y - innerHeight * .35, behavior: "instant" });
    return c.key;
  }, index, which);
  await settle(cdp);
  const result = await evaluate(cdp, async (key, kind) => {
    const before = window.__g66.snapshot();
    const selected = before.find(c => c.key === key);
    if (!selected) throw Error("Missing operation reference");
    const read = () => {
      const after = window.__g66.snapshot(), c = after.find(c => c.key === selected.key);
      if (!c || c.char !== selected.char) throw Error("Lost operation glyph " + selected.key);
      return { dx: c.x - selected.x, dy: c.y - selected.y };
    };
    if (kind === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else if (kind === "blank") document.querySelector(".reader-body").click();
    else {
      const span = [...document.querySelectorAll('.sentence[data-index="' + selected.index + '"]')]
        .find(s => Number(s.dataset.offset) <= selected.offset && Number(s.dataset.offset) + s.textContent.length > selected.offset);
      if (!span) throw Error("Missing selected span");
      const range = document.createRange(), offset = selected.offset - Number(span.dataset.offset);
      range.setStart(span.firstChild, offset); range.setEnd(span.firstChild, offset + selected.char.length);
      const r = range.getBoundingClientRect();
      span.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    }
    const first = await new Promise(resolve => requestAnimationFrame(() => resolve(read())));
    await new Promise(resolve => setTimeout(resolve, 1200));
    return { key: selected.key, char: selected.char, first, stable: read() };
  }, key, kind);
  console.log(JSON.stringify({ scenario: label, ...result }));
  return { scenario: label, ...result };
}
async function bodyStyles(cdp, width, branch) {
  return evaluate(cdp, (width, branch) => {
    const body = document.querySelector(".reader-body"), s = getComputedStyle(body), rect = body.getBoundingClientRect();
    const props = ["fontFamily", "fontSize", "lineHeight", "letterSpacing", "textAlign", "textIndent", "color", "wordBreak", "lineBreak", "maxWidth", "overflowAnchor"];
    const values = Object.fromEntries(props.map(p => [p, s[p]]));
    if (branch) {
      const expected = { fontSize: "17.5px", lineHeight: "30.625px", textAlign: "start", maxWidth: "560px",
        lineBreak: "strict", wordBreak: "normal", color: "rgb(60, 60, 60)", overflowAnchor: "none" };
      for (const [p, value] of Object.entries(expected)) if (s[p] !== value) throw Error("Body style " + p + ": " + s[p]);
      if (!["normal", "0px"].includes(s.letterSpacing)) throw Error("Body tracking");
      if (!s.fontFamily.includes('"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif')) throw Error("Body local font stack");
      const main = body.parentElement, parentStyle = getComputedStyle(main);
      const available = main.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight);
      if (Math.abs(rect.width - Math.min(560, available)) >= .5) throw Error("Body used width");
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) throw Error("Horizontal overflow at " + width);
    return { ...values, usedWidth: rect.width };
  }, width, branch);
}
async function typographySamples(cdp, properties) {
  return evaluate(cdp, properties => {
    const samples = [];
    const add = (scope, prefix) => {
      [scope, ...scope.querySelectorAll("*")].forEach((el, i) => {
        const s = getComputedStyle(el);
        samples.push({ key: prefix + ":" + i + ":" + el.tagName + ":" + el.className,
          values: Object.fromEntries(properties.map(p => [p, s[p]])) });
      });
    };
    document.querySelectorAll(".gloss-panel").forEach(p => add(p, "panel:" + p.dataset.sentenceIndex));
    // Sample has no footnotes, headings or failed/streaming panels. Detached fixtures exercise their inherited CSS in the real body.
    const fixture = document.createElement("div"); fixture.dataset.g66Fixture = "";
    fixture.innerHTML = '<section class="reader-notes"><ol><li>验证脚注。</li></ol></section>'
      + '<div class="gloss-panel gloss-panel-inline" data-state="busy"><p class="gloss-panel-pending">……</p>'
      + '<p class="gloss-panel-note">说明<button class="gloss-panel-retry">重试</button></p>'
      + '<div class="action-row"><button class="action-row-save">留下</button><button class="action-row-explain">听不懂</button><span class="action-row-notice">提示</span></div>'
      + '<div class="explain-result"><p class="explain-result-text">解释<span class="gloss-term">术语</span></p><p class="explain-result-pending">……</p><p class="explain-result-note">说明</p></div></div>';
    document.querySelector(".reader-body").append(fixture);
    add(fixture.querySelector(".reader-notes"), "notes");
    add(fixture.querySelector(".gloss-panel"), "states");
    fixture.remove();
    return samples;
  }, properties);
}
async function spacing(cdp, branch) {
  const normal = await evaluate(cdp, branch => {
    const blocks = [...document.querySelectorAll(".reader-body > .reader-paragraph")];
    if (!branch) return [];
    if (blocks.length !== 3) throw Error("Logical paragraph count");
    const gaps = blocks.slice(1).map((block, i) => block.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom);
    if (gaps.some(g => Math.abs(g - 21) > .5)) throw Error("Normal paragraph gap: " + JSON.stringify(gaps));
    return gaps;
  }, branch);
  // CSS heading probe: actual sample has no heading; uses the same tags and classes as Paragraph.
  const heading = await evaluate(cdp, branch => {
    const host = document.createElement("div"); host.dataset.g66Fixture = "";
    const text = '<p class="reader-para">甲。</p>', title = '<h1 class="reader-heading">验证标题</h1>';
    host.innerHTML = branch ? '<div class="reader-paragraph">' + text + '</div><div class="reader-paragraph reader-heading-block">' + title + '</div><div class="reader-paragraph">' + text + '</div>' : text + title + text;
    document.querySelector(".reader-body").append(host);
    const p = host.querySelectorAll("p"), h = host.querySelector("h1"), r = h.getBoundingClientRect();
    const gaps = { top: r.top - p[0].getBoundingClientRect().bottom, bottom: p[1].getBoundingClientRect().top - r.bottom };
    host.remove();
    if (branch && (Math.abs(gaps.top - 24.15) > .5 || Math.abs(gaps.bottom - 12.075) > .5)) throw Error("Heading gap: " + JSON.stringify(gaps));
    return gaps;
  }, branch);
  await open(cdp, 5);
  const inside = await evaluate(cdp, branch => {
    const panel = document.querySelector('.gloss-panel[data-sentence-index="5"]'), before = panel.previousElementSibling, after = panel.nextElementSibling;
    const style = getComputedStyle(panel), r = panel.getBoundingClientRect();
    const gaps = { top: r.top - before.getBoundingClientRect().bottom, bottom: after.getBoundingClientRect().top - r.bottom,
      marginTop: parseFloat(style.marginTop), marginBottom: parseFloat(style.marginBottom) };
    if (branch && (Math.abs(gaps.top - gaps.marginTop) > .5 || Math.abs(gaps.bottom - gaps.marginBottom) > .5)) throw Error("Split gap: " + JSON.stringify(gaps));
    return gaps;
  }, branch);
  await close(cdp); await open(cdp, 2);
  const end = await evaluate(cdp, branch => {
    const panel = document.querySelector('.gloss-panel[data-sentence-index="2"]'), margin = parseFloat(getComputedStyle(panel).marginBottom);
    const next = document.querySelector('[data-para="1"]'), gap = next.getBoundingClientRect().top - panel.getBoundingClientRect().bottom;
    if (branch && Math.abs(gap - margin - 21) > .5) throw Error("End-sentence paragraph gap: " + JSON.stringify({ gap, margin }));
    return { gap, margin };
  }, branch);
  await close(cdp);
  return { normal, heading, inside, end };
}
async function copyCheck(cdp) {
  return evaluate(cdp, () => {
    const spans = [...document.querySelectorAll('[data-para="2"] .sentence')], first = spans[0], last = spans.at(-1);
    const range = document.createRange(); range.setStart(first.firstChild, 0); range.setEnd(last.firstChild, last.firstChild.length);
    const selection = getSelection(), normalize = text => text.replace(/\r?\n/g, "");
    selection.removeAllRanges(); selection.addRange(range); const selected = normalize(selection.toString());
    let pieces = "", original = "", placeholder = "";
    const keys = new Set();
    for (const el of document.querySelectorAll(".reader-body .sentence,.reader-body .reader-tail-placeholder,.reader-body .gloss-panel")) {
      if (!range.intersectsNode(el)) continue;
      const part = document.createRange(); part.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(part);
      const text = normalize(selection.toString()); pieces += text;
      if (el.matches(".reader-tail-placeholder")) placeholder += text;
      if (el.matches(".sentence")) {
        if (text !== el.textContent) throw Error("Original not selectable");
        original += text;
        let offset = 0;
        for (const char of text) {
          const key = el.closest("[data-para]").dataset.para + ":" + (Number(el.dataset.offset) + offset);
          if (keys.has(key)) throw Error("Duplicate copied original glyph " + key);
          keys.add(key); offset += char.length;
        }
      }
    }
    selection.removeAllRanges();
    if (placeholder !== "" || selected !== pieces || original !== spans.map(s => s.textContent).join("")) throw Error("Copy integrity");
    return { originalCodePoints: Array.from(original).length, placeholderCodePoints: Array.from(placeholder).length, passed: true };
  });
}
async function checks(cdp, width, branch) {
  const report = { width, body: await bodyStyles(cdp, width, branch), spacing: await spacing(cdp, branch), styles: {}, operations: [], copies: [] };
  for (const mode of ["收起", "显示"]) for (const shape of ["inline", "bubble"]) {
    await evaluate(cdp, () => { localStorage.removeItem("gloss:saved:sample"); localStorage.removeItem("gloss:explain:sample"); });
    await reload(cdp);
    await choose(cdp, ".mode-option", mode);
    await choose(cdp, '[aria-label="白话显示形态"] button', shape === "inline" ? "inline 小字" : "气泡");
    const prefix = mode + "/" + shape + "/";
    report.operations.push(await operation(cdp, prefix + "首次首字", "click", 5, "first"));
    report.operations.push(await operation(cdp, prefix + "续排中部字", "click", 6, "middle"));
    report.operations.push(await operation(cdp, prefix + "多开句末附近字", "click", 8, "end"));
    assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===3"), "Same paragraph multi-open");
    report.styles[prefix] = await typographySamples(cdp, STYLE_PROPERTIES);
    report.copies.push(await copyCheck(cdp));
    report.operations.push(await operation(cdp, prefix + "只收一句", "click", 6, "middle"));
    assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===2"), "Close only one");
    report.operations.push(await operation(cdp, prefix + "跨段切换", "click", 3, "first"));
    assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===1"), "Cross paragraph close");
    report.operations.push(await operation(cdp, prefix + "Esc", "escape", 3));
    assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===0"), "Escape close");
    report.operations.push(await operation(cdp, prefix + "首次中部字", "click", 5, "middle"));
    report.operations.push(await operation(cdp, prefix + "点空白", "blank", 5));
    assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===0"), "Blank close");
    report.operations.push(await operation(cdp, prefix + "首次句末附近字", "click", 5, "end"));
    await choose(cdp, '.gloss-panel[data-sentence-index="5"] .action-row-save', "留下");
    const saved = await cdp.evaluate("localStorage.getItem('gloss:saved:sample')");
    assert(saved, "Saved sample storage");
    await reload(cdp);
    assert(await cdp.evaluate("localStorage.getItem('gloss:saved:sample')") === saved, "Refresh kept saved storage");
    // In display mode it is already permanent; clicking only changes its action row. In collapsed mode it opens it.
    report.operations.push(await operation(cdp, prefix + "保存刷新后点击", "click", 5, "middle"));
    assert(await cdp.evaluate("!!document.querySelector('.gloss-panel-saved[data-sentence-index=\"5\"]')"), "Saved refresh panel");
    await bodyStyles(cdp, width, branch);
  }
  return report;
}
async function run(origin, width, branch) {
  const profile = await mkdtemp(join(tmpdir(), "gloss-g66-edge-")), port = await freePort();
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=" + port,
    "--remote-allow-origins=*", "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-sync", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let cdp, browser; const api = [];
  try {
    let target;
    await waitFor(async () => {
      const response = await fetch("http://127.0.0.1:" + port + "/json").catch(() => null);
      if (!response) return false;
      target = (await response.json()).find(t => t.type === "page"); return !!target;
    }, "Edge CDP");
    const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
    cdp = new Cdp(target.webSocketDebuggerUrl); browser = new Cdp(version.webSocketDebuggerUrl);
    cdp.socket.on("message", data => { const m = JSON.parse(data); if (m.method === "Network.requestWillBeSent" && new URL(m.params.request.url).pathname.startsWith("/api/")) api.push(m.params.request.url); });
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }); await cdp.call("Runtime.enable"); await cdp.call("Network.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: "(" + setup.toString() + ")();" });
    await singlePage(browser, target.id);
    await cdp.call("Page.navigate", { url: origin + "/read/sample" }); await ready(cdp);
    const report = await checks(cdp, width, branch);
    assert(api.length === 0, "Zero API requests", api);
    assert(!await cdp.evaluate("document.hidden||window.__g66.hidden"), "Visible page");
    assert(await cdp.evaluate("localStorage.getItem('gloss:analytics:optout')") === "1", "Analytics opt-out");
    await singlePage(browser, target.id);
    return { ...report, apiRequests: api.length };
  } finally {
    cdp?.close(); browser?.close(); edge.kill();
    if (edge.exitCode === null) await Promise.race([new Promise(done => edge.once("exit", done)), sleep(5000)]);
    const absolute = resolve(profile);
    assert(absolute.startsWith(resolve(tmpdir(), "gloss-g66-edge-")), "Safe profile cleanup");
    await rm(absolute, { recursive: true, force: true });
  }
}
let exactZero = 0, total = 0;
const exceptions = [];
for (const width of WIDTHS) {
  console.log(JSON.stringify({ run: "branch", width }));
  const branch = await run(ORIGIN, width, true);
  console.log(JSON.stringify({ run: "base", width }));
  const base = await run(BASE_ORIGIN, width, false);
  assert(JSON.stringify(branch.styles) === JSON.stringify(base.styles), "Unchanged gloss/action/notes computed styles", { width, branch: branch.styles, base: base.styles });
  assert(branch.operations.length === base.operations.length, "Same scenarios");
  for (let i = 0; i < branch.operations.length; i++) {
    const current = branch.operations[i], prior = base.operations[i];
    assert(current.scenario === prior.scenario && current.key === prior.key, "Same scenario glyph identity", { current, prior });
    total++;
    if ([current.first.dx, current.first.dy, current.stable.dx, current.stable.dy].every(v => v === 0)) { exactZero++; continue; }
    const detail = { width, scenario: current.scenario, branch: { first: current.first, stable: current.stable }, main: { first: prior.first, stable: prior.stable } };
    console.log(JSON.stringify({ nonZero: detail }));
    for (const frame of ["first", "stable"]) {
      const a = current[frame], b = prior[frame];
      assert(Math.abs(a.dx) < .5 && Math.abs(a.dy) < .5 && Math.abs(b.dx) < .5 && Math.abs(b.dy) < .5, "Glyph drift >= 0.5", detail);
      if (a.dx !== 0 || a.dy !== 0) assert(b.dx !== 0 || b.dy !== 0, "Branch regression from main zero", detail);
    }
    exceptions.push(detail);
  }
  console.log(JSON.stringify({ width, spacing: branch.spacing, computedStyles: true, copy: branch.copies, zeroApi: true, noHorizontalOverflow: true }));
}
console.log(JSON.stringify({ exactZeroScenarios: exactZero, totalScenarios: total, existingSubpixel: exceptions }));
console.log("G-66 checks passed");
