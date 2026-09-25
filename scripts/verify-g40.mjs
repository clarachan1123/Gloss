/**
 * Reproduce G-40 in an isolated Chrome profile against `npm run dev:slow-gloss`.
 * Run the required invalid-key / HTTP 401 preflight before this script.
 * The test disables only the Reader's auto-collapse IntersectionObserver so an
 * already offscreen panel remains mounted long enough to isolate growth anchoring.
 * G40_PROBE_ABOVE=1 runs one above-viewport sample. Add G40_DISABLE_COMPENSATION=1
 * to block scroll/translate corrections in that sample as a negative control:
 * it must drift, proving that the visible-character measurement detects a failure.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const PROBE_ABOVE = process.env.G40_PROBE_ABOVE === "1";
const DISABLE_COMPENSATION = process.env.G40_DISABLE_COMPENSATION === "1";
if (DISABLE_COMPENSATION && !PROBE_ABOVE) throw new Error("G40_DISABLE_COMPENSATION requires G40_PROBE_ABOVE=1");
const ORIGIN = "http://localhost:3430";
const CHROME = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitForValue(read, label, timeoutMs = 15_000) {
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
    this.sequence = 0;
    this.pending = new Map();
    this.ready = new Promise((done, fail) => {
      this.socket.onopen = done;
      this.socket.onerror = fail;
    });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.fail(new Error(message.error.message));
      else pending.done(message.result);
    };
    this.socket.onclose = (event) => {
      for (const pending of this.pending.values()) pending.fail(new Error(`Chrome CDP closed: ${event.code} ${event.reason}`));
      this.pending.clear();
    };
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`Chrome CDP timed out: ${method}`));
      }, 40_000);
      this.pending.set(id, {
        done: (value) => { clearTimeout(timer); done(value); },
        fail: (error) => { clearTimeout(timer); fail(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

function fixture(index) {
  const docId = `g40-viewport-${index}`;
  const paragraphs = Array.from({ length: 80 }, (_, n) => `第${n + 1}段用于验证阅读视口。这里还有第二句，确保下面始终有可见正文。`);
  return {
    version: 1, docId, paragraphs, headings: [], footnotes: [],
    meta: { format: "txt", fileName: `G40 视口验证 ${index}.txt`, charCount: paragraphs.join("\n").length },
    savedAt: Date.now(),
  };
}

async function navigate(cdp, url) {
  await cdp.call("Page.navigate", { url });
  await waitForValue(() => cdp.evaluate(`location.href.replace(/\\/$/, '') === ${JSON.stringify(url.replace(/\/$/, ""))} && document.readyState === 'complete'`), "page load");
}

async function runScenario(cdp, index, name) {
  const docId = `g40-viewport-${index}`;
  await navigate(cdp, `${ORIGIN}/read/${docId}`);
  await waitForValue(() => cdp.evaluate("!!document.querySelector('.reader-body .sentence[data-index=\"0\"]')"), "reader sentence");
  await cdp.evaluate("document.querySelector('.sentence[data-index=\"0\"]').scrollIntoView({block:'center',behavior:'instant'})");
  const point = await cdp.evaluate("(() => { const r=document.querySelector('.sentence[data-index=\"0\"]').getBoundingClientRect(); return {x:r.left+Math.min(r.width/2,30),y:r.top+r.height/2}; })()");
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.call("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
  await waitForValue(() => cdp.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\"0\"]')"), "gloss panel");
  await cdp.evaluate("document.querySelector('.gloss-panel[data-sentence-index=\"0\"]').style.width = '58px'"); // Test-only narrow column: near-150-character text must cause at least 30 real height changes.
  await sleep(1000); // Let the one-time G-07 visibility adjustment finish before measuring growth.
  const target = name === "above" ? -220 : name === "crossing" ? -40 : 180;
  await cdp.evaluate(`(() => {const p=document.querySelector('.gloss-panel[data-sentence-index="0"]'); const r=p.getBoundingClientRect(); const current=${name === "above" ? "r.bottom" : "r.top"}; window.scrollBy({top:current-(${target}),behavior:'instant'});})()`);
  if (DISABLE_COMPENSATION) await cdp.evaluate("(() => {window.scrollBy = () => {}; document.head.insertAdjacentHTML('beforeend', '<style>.reader-body { translate: none !important }</style>');})()");
  const result = await cdp.evaluate(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.gloss-panel[data-sentence-index="0"]');
    const sentences = [...document.querySelectorAll('.reader-body .sentence')];
    const below = sentences.find(el => Number(el.dataset.index) > 0 && el.getBoundingClientRect().top > panel.getBoundingClientRect().bottom);
    let visible = null;
    for (const el of sentences) {
      const node = el.firstChild;
      if (!(node instanceof Text)) continue;
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.top >= 0 && rect.top < innerHeight - 20) { visible = range; break; }
      }
      if (visible) break;
    }
    const anchor = ${JSON.stringify(name)} === 'above' ? visible : panel;
    if (!anchor || (${JSON.stringify(name)} === 'inside' && !below)) return reject(new Error('Missing visible reference'));
    const top = el => el.getBoundingClientRect().top;
    let first = null, previous = null, signedSum = 0, maxStep = 0, maxCumulative = 0, changes = 0, lastHeight = panel.getBoundingClientRect().height, stable = 0;
    const timeline = [];
    const started = performance.now();
    const tick = () => {
      if (!panel.isConnected) return reject(new Error('Panel unmounted'));
      const rect = panel.getBoundingClientRect();
      const current = top(anchor);
      if (first === null) first = current;
      if (previous === null) previous = current;
      if (Math.abs(rect.height - lastHeight) > 0.01) {
        const step = current - previous;
        signedSum += step;
        maxStep = Math.max(maxStep, Math.abs(step));
        maxCumulative = Math.max(maxCumulative, Math.abs(current - first));
        changes++;
        timeline.push({height:rect.height,top:current,panelTop:rect.top,scrollY,step});
        lastHeight = rect.height;
        previous = current;
      }
      stable = panel.dataset.state === 'done' ? stable + 1 : 0;
      if (stable >= 3) return resolve({scenario:${JSON.stringify(name)},changes,maxStep,maxCumulative,signedSum,initialTop:first,finalTop:current,initialPanelHeight:initialHeight,finalPanelHeight:rect.height,initialPanelTop,initialPanelBottom,belowDelta:below ? top(below)-initialBelow : null,panelTop:rect.top,panelBottom:rect.bottom,timeline});
      if (performance.now() - started > 25_000) return reject(new Error('Stream did not finish'));
      requestAnimationFrame(tick);
    };
    const initialRect = panel.getBoundingClientRect();
    const initialHeight = initialRect.height;
    const initialPanelTop = initialRect.top;
    const initialPanelBottom = initialRect.bottom;
    const initialBelow = below ? top(below) : null;
    requestAnimationFrame(tick);
  })`, true);
  console.log(JSON.stringify({ mode: DISABLE_COMPENSATION ? "compensation-off" : "compensation-on", run: index + 1, scenario: name, changes: result.changes, maxStep: result.maxStep, maxCumulative: result.maxCumulative, signedSum: result.signedSum, initialPanelHeight: result.initialPanelHeight, finalPanelHeight: result.finalPanelHeight, belowDelta: result.belowDelta }));
  if (name === "above" && result.initialPanelBottom > 0) throw new Error("above: panel was not fully above viewport");
  if (name === "crossing" && !(result.initialPanelTop < 0 && result.initialPanelBottom > 0)) throw new Error("crossing: viewport did not cut through panel");
  if (name === "inside" && result.initialPanelTop < 0) throw new Error("inside: panel was not in viewport");
  if (result.changes < 30) throw new Error(`${name}: only ${result.changes} panel height changes; require at least 30`);
  if (DISABLE_COMPENSATION) {
    if (result.maxCumulative <= 1 || Math.abs(result.signedSum) <= 1) throw new Error("Negative control failed to expose drift");
    return;
  }
  if (Math.abs(result.signedSum) > 1) throw new Error(`${name}: signed drift sum exceeded 1px`);
  if (result.maxStep > 0.5 || result.maxCumulative > 1) throw new Error(`${name}: anchor drift exceeded 0.5px per step or 1px cumulative`);
  if (name === "inside" && Math.abs(result.belowDelta - (result.finalPanelHeight - result.initialPanelHeight)) > 1) {
    throw new Error("inside: below-panel text was not pushed by panel growth");
  }
}

const profile = await mkdtemp(join(tmpdir(), "gloss-g40-"));
const port = await freePort();
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let chromeErrors = "";
chrome.stderr.on("data", (chunk) => { chromeErrors = `${chromeErrors}${chunk}`.slice(-2000); });
let cdp;
try {
  const target = await waitForValue(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    return (await response.json()).find((item) => item.type === "page");
  }, "Chrome CDP");
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await sleep(500);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };" });
  await navigate(cdp, ORIGIN);
  for (let index = 0; index < 9; index++) {
    await cdp.evaluate(`localStorage.setItem('gloss:doc:g40-viewport-${index}', ${JSON.stringify(JSON.stringify(fixture(index)))})`);
  }
  if (PROBE_ABOVE) await runScenario(cdp, 0, "above");
  else for (const [scenarioIndex, name] of ["above", "crossing", "inside"].entries()) {
    for (let repeat = 0; repeat < 3; repeat++) await runScenario(cdp, scenarioIndex * 3 + repeat, name);
  }
  console.log(DISABLE_COMPENSATION ? "G-40 negative control exposed drift" : "G-40 viewport checks passed");
} catch (error) {
  console.error(`Chrome exit code: ${chrome.exitCode}`);
  console.error(chromeErrors);
  throw error;
} finally {
  cdp?.close();
  chrome.kill();
  if (chrome.exitCode === null) await Promise.race([new Promise((done) => chrome.once("exit", done)), sleep(5000)]);
  const resolved = resolve(profile);
  if (!resolved.startsWith(resolve(tmpdir(), "gloss-g40-") )) throw new Error("Unexpected Chrome profile path");
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => {
    console.warn(`Chrome profile cleanup failed: ${error.code}`);
  });
}
