/**
 * Replays G-46 against `npm run dev:slow-gloss` after the invalid-key / HTTP 401 preflight.
 * Uses the real IntersectionObserver. The local mock supplies the 148-character slow gloss.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = "http://localhost:3430";
const CHROME = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function waitFor(read, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((done, fail) => { this.socket.onopen = done; this.socket.onerror = fail; });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.fail(new Error(message.error.message)) : pending.done(message.result);
    };
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 40000);
      this.pending.set(id, { done: value => { clearTimeout(timer); done(value); }, fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  close() { this.socket.close(); }
}

function fixture(id) {
  const paragraphs = Array.from({ length: 80 }, (_, n) => `第${n + 1}段用于验证阅读视口。这里还有第二句，确保下面始终有可见正文。`);
  return { version: 1, docId: id, paragraphs, headings: [], footnotes: [], meta: { format: "txt", fileName: `${id}.txt`, charCount: paragraphs.join("\n").length }, savedAt: Date.now() };
}

async function navigate(cdp, url) {
  await cdp.call("Page.navigate", { url });
  await waitFor(() => cdp.evaluate(`location.href.replace(/\\/$/,'') === ${JSON.stringify(url.replace(/\/$/, ""))} && document.readyState === 'complete'`), `navigation ${url}`);
}

const instrumentation = `(() => {
  window.__g46 = {observed:0,disconnected:0,glossAborts:0};
  const NativeObserver = window.IntersectionObserver;
  window.IntersectionObserver = class extends NativeObserver {
    observe(target) { if (target.matches?.('[data-index], .gloss-panel')) window.__g46.observed++; return super.observe(target); }
    disconnect() { window.__g46.disconnected++; return super.disconnect(); }
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('/api/gloss')) {
      const signal = init?.signal ?? input?.signal;
      signal?.addEventListener('abort', () => { window.__g46.glossAborts++; });
    }
    return originalFetch.apply(this, arguments);
  };
})();`;

async function openSentence(cdp, id, index) {
  await navigate(cdp, `${ORIGIN}/read/${id}`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.sentence[data-index="${index}"]')`), "sentence");
  await cdp.evaluate(`document.querySelector('.sentence[data-index="${index}"]').scrollIntoView({block:'center',behavior:'instant'})`);
  await cdp.evaluate(`document.querySelector('.sentence[data-index="${index}"]').click()`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.gloss-panel[data-sentence-index="${index}"]')`), "panel");
}

async function ready(cdp, index, stage) {
  const panel = `.gloss-panel[data-sentence-index="${index}"]`;
  if (stage === "busy") await waitFor(() => cdp.evaluate(`(() => {const p=document.querySelector('${panel}');return p?.dataset.state==='busy' && (p.querySelector('.gloss-panel-text')?.textContent?.length ?? 0)>=40;})()`), "40 streaming characters", 25000);
  else await waitFor(() => cdp.evaluate(`document.querySelector('${panel}')?.dataset.state==='done'`), "completed gloss", 25000);
}

async function scroll(cdp, index, direction) {
  return cdp.evaluate(`(() => {
    const source=document.querySelector('.sentence[data-index="${index}"]');
    const panel=document.querySelector('.gloss-panel[data-sentence-index="${index}"]');
    if (${JSON.stringify(direction)}==='source-out') window.scrollBy({top:source.getBoundingClientRect().bottom+15,behavior:'instant'});
    else if (${JSON.stringify(direction)}==='edge') window.scrollBy({top:panel.getBoundingClientRect().bottom-1,behavior:'instant'});
    else if (${JSON.stringify(direction)}==='down') window.scrollBy({top:panel.getBoundingClientRect().bottom+20,behavior:'instant'});
    else window.scrollTo({top:0,behavior:'instant'});
    const s=source.getBoundingClientRect(), p=panel.getBoundingClientRect();
    return {sourceTop:s.top,sourceBottom:s.bottom,panelTop:p.top,panelBottom:p.bottom,shown:panel.querySelector('.gloss-panel-text')?.textContent?.length ?? 0,state:panel.dataset.state};
  })()`);
}

async function runCase(cdp, id, name, index = 0) {
  await openSentence(cdp, id, index);
  await ready(cdp, index, name.startsWith("done") || name === "explain-visible" ? "done" : "busy");
  if (name === "explain-visible") {
    await cdp.evaluate(`(() => {const p=document.querySelector('.gloss-panel[data-sentence-index="${index}"]'); [...p.querySelectorAll('button')].find(b=>b.textContent?.includes('听不懂'))?.click();})()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('.gloss-panel[data-sentence-index="${index}"] .explain-result')?.getAttribute('aria-busy')==='true'`), "explanation request");
  }
  const before = await cdp.evaluate("({...window.__g46})");
  const direction = name === "busy-edge" ? "edge" : name.endsWith("visible") ? "source-out" : name.endsWith("up") ? "up" : "down";
  const geometry = await scroll(cdp, index, direction);
  if (direction === "edge") {
    if (!(geometry.panelBottom > 0 && geometry.panelBottom <= 1.5 && geometry.sourceBottom < 0)) throw new Error(`${name}: expected one visible pixel: ${JSON.stringify(geometry)}`);
    await sleep(100);
    const visible = await cdp.evaluate(`({panel:!!document.querySelector('.gloss-panel[data-sentence-index="${index}"]'),...window.__g46})`);
    if (!visible.panel || visible.glossAborts !== before.glossAborts) throw new Error(`${name}: one visible pixel did not keep panel open`);
    const gone = await scroll(cdp, index, "down");
    await waitFor(() => cdp.evaluate(`!document.querySelector('.gloss-panel[data-sentence-index="${index}"]')`), "collapse after last pixel leaves");
    const after = await cdp.evaluate("({...window.__g46})");
    if (after.glossAborts !== before.glossAborts + 1 || after.observed !== 2 || after.disconnected !== 1) throw new Error(`${name}: incorrect abort or observer lifecycle`);
    console.log(JSON.stringify({scenario:name,geometry,gone,after}));
    return;
  }
  if (direction === "source-out") {
    if (!(geometry.sourceBottom < 0 && geometry.panelBottom > 0 && geometry.panelTop < 720)) throw new Error(`${name}: expected source out and panel visible: ${JSON.stringify(geometry)}`);
    if (name === "busy-visible") {
      await waitFor(() => cdp.evaluate(`document.querySelector('.gloss-panel[data-sentence-index="${index}"]')?.dataset.state==='done'`), "finish while panel visible", 25000);
      await waitFor(() => cdp.evaluate(`(document.querySelector('.gloss-panel[data-sentence-index="${index}"] .gloss-panel-text')?.textContent?.length ?? 0)>=148`), "show all 148 characters");
    } else if (name === "explain-visible") {
      await waitFor(() => cdp.evaluate(`(() => {const e=document.querySelector('.gloss-panel[data-sentence-index="${index}"] .explain-result');return e?.getAttribute('aria-busy')==='false' && (e.textContent?.length ?? 0)>0;})()`), "explanation finish while panel visible", 25000);
    } else await sleep(300);
    const after = await cdp.evaluate(`({panel:!!document.querySelector('.gloss-panel[data-sentence-index="${index}"]'),...window.__g46})`);
    if (!after.panel || after.glossAborts !== before.glossAborts || after.observed !== 2 || after.disconnected !== 0) throw new Error(`${name}: panel closed, gloss aborted, or observer rebuilt while visible`);
    console.log(JSON.stringify({scenario:name,geometry,after}));
    return;
  }
  if (direction === "down" && geometry.panelBottom > 0) throw new Error(`${name}: panel remains visible`);
  if (direction === "up" && geometry.sourceTop < 720) throw new Error(`${name}: source remains visible: ${JSON.stringify(geometry)}`);
  const anchor = direction === "down" ? await cdp.evaluate(`(() => {const el=[...document.querySelectorAll('.sentence')].find(e=>{const r=e.getBoundingClientRect();return r.top>=0 && r.top<innerHeight});return el?{index:el.dataset.index,top:el.getBoundingClientRect().top}:null;})()`) : null;
  await waitFor(() => cdp.evaluate(`!document.querySelector('.gloss-panel[data-sentence-index="${index}"]')`), `${name} auto-collapse`);
  const after = await cdp.evaluate("({...window.__g46})");
  if (name.startsWith("busy") && after.glossAborts !== before.glossAborts + 1) throw new Error(`${name}: streaming gloss was not aborted exactly once`);
  if (after.observed !== 2 || after.disconnected !== 1) throw new Error(`${name}: observer registration/disconnection mismatch`);
  let anchorDelta = null;
  if (anchor) {
    const top = await cdp.evaluate(`document.querySelector('.sentence[data-index="${anchor.index}"]')?.getBoundingClientRect().top ?? null`);
    anchorDelta = top === null ? null : top - anchor.top;
    if (anchorDelta === null || Math.abs(anchorDelta) > 0.5) throw new Error(`${name}: visible sentence moved ${anchorDelta}px`);
  }
  console.log(JSON.stringify({scenario:name,geometry,after,anchorDelta}));
}

const profile = await mkdtemp(join(tmpdir(), "gloss-g46-"));
const server = createServer();
await new Promise(done => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise(done => server.close(done));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore", windowsHide: true });
let cdp;
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === "page"), "CDP target");
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width:1280, height:720, deviceScaleFactor:1, mobile:false });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source:instrumentation });
  await navigate(cdp, ORIGIN);
  const cases = ["busy-visible", "done-visible", "busy-edge", "busy-down", "done-down", "busy-up", "explain-visible"];
  for (const name of cases) {
    const id = `g46-${name}`;
    await cdp.evaluate(`localStorage.setItem('gloss:doc:${id}',${JSON.stringify(JSON.stringify(fixture(id)))})`);
  }
  for (const name of cases.filter(name => !process.env.G46_SCENARIO || process.env.G46_SCENARIO === name)) await runCase(cdp, `g46-${name}`, name, name === "busy-up" ? 100 : 0);
  console.log("G-46 observer checks passed");
} finally {
  cdp?.close();
  chrome.kill();
  if (chrome.exitCode === null) await Promise.race([new Promise(done => chrome.once("exit", done)), sleep(5000)]);
  const resolved = resolve(profile);
  if (!resolved.startsWith(resolve(tmpdir(), "gloss-g46-"))) throw new Error("Unexpected Chrome profile path");
  await rm(resolved, { recursive:true, force:true, maxRetries:10, retryDelay:200 });
}
