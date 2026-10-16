/** G-68: document-coordinate compensation; production layout checks and local slow-stream checks. */
import { spawn } from "node:child_process";
import ts from "typescript";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
process.env.G19_IMPORT_ONLY = "1";
const { Cdp, freePort } = await import("./verify-g19.mjs");
const ROOT = resolve(import.meta.dirname, "..");
const LAYOUT_ORIGIN = process.env.G68_ORIGIN ?? "http://127.0.0.1:3468";
const ORIGIN = process.env.G68_STREAM_ORIGIN ?? "http://localhost:3430";
const LEGACY = process.env.G68_LEGACY_DRIFT === "1";
const REFERENCE = process.env.G68_REFERENCE === "1";
const STREAM_ONLY = process.env.G68_GROUP === "c";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, label, detail) => { if (!value) throw Error(label + (detail === undefined ? "" : ": " + JSON.stringify(detail))); };
const results = [];
const cleanupProfiles = [];
let allAssertionsPassed = false;
async function closeBrowser(edge, exited, c, browser, profile, prefix) {
  try {
    if (edge.exitCode === null && edge.signalCode === null) {
      try { await (browser ?? c).call("Browser.close"); }
      catch (error) {
        if (edge.exitCode === null && edge.signalCode === null) { edge.kill(); await exited; throw error; }
      }
    }
    await exited;
  } finally {
    c?.close(); browser?.close();
    assert(resolve(profile).startsWith(resolve(tmpdir(), prefix)), "Safe profile cleanup");
    cleanupProfiles.push(profile);
  }
}
async function removeProfiles() {
  for (const profile of cleanupProfiles) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) {
      if (allAssertionsPassed) console.warn("Temporary profile cleanup warning: " + profile + " (" + error.code + ")");
      else { console.error("Temporary profile cleanup failed before assertions completed: " + profile + " (" + error.code + ")"); process.exitCode = 1; }
    }
  }
}
const reportPath = join(ROOT, REFERENCE ? "tmp-g68-base-c.json" : LEGACY ? "tmp-g68-negative.json" : "tmp-g68-verify.json");
async function saveReport() { await writeFile(reportPath, JSON.stringify({ legacy: LEGACY, results }, null, 2)); }
async function wait(fn, label) { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await sleep(50); } throw Error("Timeout: " + label); }
async function installROLogpoint(c, scripts) {
  const code = REFERENCE ? "main old code" : "G-68 new code";
  for (const script of scripts.filter(s => s.url && /Reader|_next\/static\/chunks/.test(s.url))) {
    const marker = await c.call("Debugger.searchInContent", { scriptId: script.scriptId, query: "positionRestored", caseSensitive: true });
    if (!marker.result.length) continue;
    const hits = await c.call("Debugger.searchInContent", { scriptId: script.scriptId, query: "ResizeObserver|scrollBy", isRegex: true, caseSensitive: true });
    if (!hits.result.length) continue;
    const source = (await c.call("Debugger.getScriptSource", { scriptId: script.scriptId })).scriptSource;
    const ast = ts.createSourceFile(script.url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), candidates = [];
    const visit = node => {
      if (ts.isNewExpression(node) && /(?:^|\.)ResizeObserver$/.test(node.expression.getText(ast))) {
        const callback = node.arguments?.[0];
        if (callback) {
          const findCall = child => {
            if (ts.isCallExpression(child) && child.expression.getText(ast) === "window.scrollBy") {
              const object = child.arguments[0];
              const top = object && ts.isObjectLiteralExpression(object) && object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === "top");
              if (top) candidates.push({ call: child, variable: top.initializer.getText(ast) });
            }
            ts.forEachChild(child, findCall);
          };
          findCall(callback);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (candidates.length !== 1) continue;
    const { call, variable } = candidates[0], location = ast.getLineAndCharacterOfPosition(call.getStart(ast));
    assert(hits.result.some(hit => hit.lineNumber === location.line && hit.lineContent.includes("scrollBy")), code + ": searchInContent did not confirm RO scrollBy");
    const breakpoint = await c.call("Debugger.setBreakpoint", {
      location: { scriptId: script.scriptId, lineNumber: location.line, columnNumber: location.character },
      condition: 'console.debug("__G68_RO_WRITE",JSON.stringify({top:(' + variable + '),time:performance.now()})),false',
    });
    const found = { code, url: script.url, ...breakpoint.actualLocation };
    console.log(JSON.stringify({ roLogpoint: found }));
    return found;
  }
  throw Error(code + ": reading-position ResizeObserver scrollBy could not be located with Debugger.searchInContent");
}
async function legacyChunk() {
  const directory = join(ROOT, ".next/static/chunks");
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(join(directory, file), "utf8"), start = source.indexOf("new ResizeObserver");
    if (start < 0 || !source.includes("positionRestored")) continue;
    const segment = source.slice(start, start + 5000);
    const formula = /([A-Za-z_$][\w$]*)\(([^()]*)\)\s*\+\s*window\.scrollY\s*-\s*([A-Za-z_$][\w$]*)\.docTop/g;
    const matches = [...segment.matchAll(formula)];
    if (matches.length !== 1) continue;
    const changed = segment.replace(formula, "$1($2)-$3.offset");
    return { file, body: Buffer.from(source.slice(0, start) + changed + source.slice(start + segment.length)).toString("base64") };
  }
  throw Error("Legacy negative control did not find exactly one RO formula");
}
async function layoutBrowser(width, injected, work) {
  const profile = await mkdtemp(join(tmpdir(), "gloss-g68-verify-")), port = await freePort();
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=" + port, "--remote-allow-origins=*", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => edge.once("exit", resolve));
  let c, browser; const scripts = [], capture = { active: false, writes: [] }, interceptionErrors = [];
  try {
    let target; await wait(async () => { try { const pages = (await (await fetch("http://127.0.0.1:" + port + "/json")).json()).filter(t => t.type === "page"); if (pages.length !== 1) return false; target = pages[0]; return true; } catch { return false; } }, "single browser page");
    c = new Cdp(target.webSocketDebuggerUrl);
    browser = new Cdp((await (await fetch("http://127.0.0.1:" + port + "/json/version")).json()).webSocketDebuggerUrl);
    const single = async () => { const pages = (await browser.call("Target.getTargets")).targetInfos.filter(t => t.type === "page"); assert(pages.length === 1 && pages[0].targetId === target.id, "Only 1 page", pages); };
    const negative = LEGACY ? await legacyChunk() : null;
    c.socket.on("message", async raw => {
      const m = JSON.parse(raw);
      if (m.method === "Runtime.executionContextsCleared") scripts.length = 0;
      if (m.method === "Debugger.scriptParsed") scripts.push(m.params);
      if (m.method === "Runtime.consoleAPICalled" && m.params.args?.[0]?.value === "__G68_RO_WRITE" && capture.active)
        capture.writes.push({ ...JSON.parse(m.params.args[1].value), stack: m.params.stackTrace?.callFrames.slice(0, 8) });
      if (m.method === "Fetch.requestPaused") {
        try { await c.call("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: negative.body }); }
        catch (e) { interceptionErrors.push(e.message); await c.call("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" }).catch(() => {}); }
      }
    });
    await c.call("Page.enable"); await c.call("Runtime.enable"); await c.call("Debugger.enable");
    await c.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.call("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (negative) await c.call("Fetch.enable", { patterns: [{ urlPattern: "*" + negative.file + "*", requestStage: "Response" }] });
    const paragraphs = Array.from({ length: 80 }, (_, i) => "第" + i + "段用于验证阅读位置。这里保留足够的原文，滚动不会到达书末。");
    const seed = function(paragraphs) {
      localStorage.setItem("gloss:analytics:optout", "1");
      const docId = location.pathname.split("/").at(-1);
      localStorage.setItem("gloss:doc:" + docId, JSON.stringify({ version: 1, docId, paragraphs, headings: [], footnotes: [], meta: { format: "txt", fileName: "G68.txt", charCount: paragraphs.join("").length }, savedAt: Date.now() }));
      localStorage.setItem("gloss:structure:" + docId, JSON.stringify({ version: 1, prompt: "structure-v1", structure: "本地验证文档。", savedAt: Date.now() }));
    };
    await c.call("Page.addScriptToEvaluateOnNewDocument", { source: "(" + seed.toString() + ")(" + JSON.stringify(paragraphs) + ");" + (injected ? "(" + diagBoot.toString() + ")();" : "") });
    const load = async label => {
      capture.active = false; capture.writes.length = 0; scripts.length = 0; await single();
      await c.call("Page.navigate", { url: LAYOUT_ORIGIN + "/read/g68-" + label + "-" + Date.now() });
      await wait(() => c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"11\"]')"), "reader");
      await c.evaluate("document.fonts.ready.then(()=>true)"); await sleep(350);
      await installROLogpoint(c, scripts); assert(interceptionErrors.length === 0, "Legacy interception", interceptionErrors); await single();
    };
    await work(c, load, capture);
  } finally { await closeBrowser(edge, exited, c, browser, profile, "gloss-g68-verify-"); }
}
async function belowAndScroll(c, capture) {
  capture.writes.length = 0; capture.active = true;
  const requested = await c.evaluate("(()=>{const start=scrollY,body=document.querySelector('.reader-body');for(let n=0;n<30;n++){const p=document.createElement('p');p.className='reader-para';p.textContent='下方参照文字。';body.append(p)}window.__g67G63Trace?.mark();const s=body.querySelector('.sentence');window.__g67G63Trace?.setAnchor({para:Number(s.closest('[data-para]').dataset.para),offset:Number(s.dataset.offset),char:s.firstChild.data[0]});window.scrollBy({top:856,behavior:'instant'});return start+856})()");
  await sleep(500); const finalY = await c.evaluate("scrollY"); capture.active = false;
  return { requested, finalY, delta: finalY - requested, roWrites: [...capture.writes] };
}
async function above(c, capture) {
  const glyphTop = "()=>{const s=document.querySelector('.sentence'),r=document.createRange();r.setStart(s.firstChild,0);r.setEnd(s.firstChild,1);return r.getBoundingClientRect().top}";
  const before = await c.evaluate("(" + glyphTop + ")()"); capture.writes.length = 0; capture.active = true;
  await c.evaluate("(()=>{const body=document.querySelector('.reader-body'),p=document.createElement('p');p.textContent='上方布局验证。';p.style.cssText='height:64px;line-height:32px;margin:0;padding:0;border:0';body.prepend(p)})()");
  await sleep(500); const after = await c.evaluate("(" + glyphTop + ")()"); capture.active = false;
  return { before, after, delta: after - before, roWrites: [...capture.writes] };
}

function diagBoot() {
  const d=window.__g67G63Trace={events:[],frames:[],anchor:null,autoAt:null},rawNow=()=>performance.now();
  const target=e=>e instanceof Element?{tag:e.tagName,className:typeof e.className==="string"?e.className:"",para:e.getAttribute("data-para"),index:e.getAttribute("data-index")}:null;
  const clean=v=>v instanceof Element?target(v):v===undefined?"undefined":v;
  const stack=()=>new Error().stack.split("\n").slice(0,8);
  const add=(type,extra={})=>d.events.push({time:rawNow(),type,phase:d.autoAt===null?"preparation":"auto",scrollY,...extra});
  d.mark=()=>{d.autoAt=rawNow();add("auto-before-scroll")};
  d.setAnchor=a=>{d.anchor=a;add("anchor-selected",{anchor:a})};
  for(const name of ["scrollTo","scrollBy"]){const native=window[name];window[name]=function(...args){add(name,{args:args.map(clean),stack:stack()});return Reflect.apply(native,this,args)}}
  for(const [proto,name] of [[Element.prototype,"scrollIntoView"],[HTMLElement.prototype,"focus"]]){
    const native=proto[name];if(typeof native!=="function")continue;
    proto[name]=function(...args){add(name,{target:target(this),args:args.map(clean),stack:stack()});return Reflect.apply(native,this,args)};
  }
  const desc=Object.getOwnPropertyDescriptor(Element.prototype,"scrollTop");
  if(desc?.set)Object.defineProperty(Element.prototype,"scrollTop",{...desc,set(value){add("scrollTop-set",{target:target(this),args:[value],stack:stack()});return Reflect.apply(desc.set,this,[value])}});
  const NativeIO=window.IntersectionObserver;
  if(NativeIO)window.IntersectionObserver=class extends NativeIO{constructor(callback,options){const createdStack=stack();super((entries,observer)=>{add("IntersectionObserver-callback",{createdStack,entries:entries.map(e=>({target:target(e.target),isIntersecting:e.isIntersecting,ratio:e.intersectionRatio,top:e.boundingClientRect.top,bottom:e.boundingClientRect.bottom}))});callback(entries,observer)},options)}};
  addEventListener("scroll",e=>add("scroll-event",{target:target(e.target),eventTimeStamp:e.timeStamp}),true);
  for(const type of ["focusin","focusout"])addEventListener(type,e=>add(type,{target:target(e.target)}),true);
  new MutationObserver(records=>{for(const r of records)if(r.target instanceof Element&&r.target.matches(".reader-typography-floating-aa"))add("floating-dom-change",{attribute:r.attributeName,oldValue:r.oldValue,value:r.target.getAttribute(r.attributeName),dataVisible:r.target.getAttribute("data-visible"),disabled:r.target.disabled,inert:r.target.inert})}).observe(document,{subtree:true,attributes:true,attributeOldValue:true,attributeFilter:["data-visible","disabled","inert","aria-hidden","tabindex","style"]});
  const anchorRect=()=>{
    const a=d.anchor;if(!a)return null;
    for(const span of document.querySelectorAll('.reader-body [data-para="'+a.para+'"] .sentence')){
      const node=span.firstChild,start=Number(span.dataset.offset),offset=a.offset-start;
      if(!(node instanceof Text)||offset<0||offset+a.char.length>node.length)continue;
      const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+a.char.length);const r=range.getBoundingClientRect();return{top:r.top,left:r.left,bottom:r.bottom};
    }return null;
  };
  const tick=time=>{
    const body=document.querySelector(".reader-body"),floating=document.querySelector(".reader-typography-floating-aa");
    if(d.autoAt!==null)d.frames.push({time,scrollY,reference:anchorRect(),translate:body?getComputedStyle(body).translate:null,referenceCount:document.querySelectorAll('.reader-body [data-para]').length,floating:floating?{visible:floating.getAttribute("data-visible"),disabled:floating.disabled,inert:floating.inert}:null});
    requestAnimationFrame(tick);
  };requestAnimationFrame(tick);
}

async function streamingAbove(width, iteration, skipGrowthSnapshot = false) {
  const profile = await mkdtemp(join(tmpdir(), "gloss-g68-growth-")), port = await freePort();
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=" + port, "--remote-allow-origins=*", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => edge.once("exit", resolve));
  let c, browser, recording = false, removedCalls = 0;
  const scripts = [], writes = [], errors = [];
  try {
    let target;
    await wait(async () => { try { const pages = (await (await fetch("http://127.0.0.1:" + port + "/json")).json()).filter(t => t.type === "page"); if (pages.length !== 1) return false; target = pages[0]; return true; } catch { return false; } }, "single growth page");
    c = new Cdp(target.webSocketDebuggerUrl);
    browser = new Cdp((await (await fetch("http://127.0.0.1:" + port + "/json/version")).json()).webSocketDebuggerUrl);
    const single = async () => { const pages = (await browser.call("Target.getTargets")).targetInfos.filter(t => t.type === "page"); assert(pages.length === 1 && pages[0].targetId === target.id, "Only 1 growth page", pages); };
    c.socket.on("message", async raw => {
      const m = JSON.parse(raw);
      if (m.method === "Runtime.executionContextsCleared") scripts.length = 0;
      if (m.method === "Debugger.scriptParsed") scripts.push(m.params);
      if (m.method === "Runtime.consoleAPICalled" && m.params.args?.[0]?.value === "__G68_RO_WRITE" && recording) writes.push({ ...JSON.parse(m.params.args[1].value), stack: m.params.stackTrace?.callFrames.slice(0, 8) });
      if (m.method === "Fetch.requestPaused") {
        try {
          if (!m.params.responseStatusCode || m.params.responseStatusCode !== 200) { await c.call("Fetch.continueResponse", { requestId: m.params.requestId }); return; }
          const response = await c.call("Fetch.getResponseBody", { requestId: m.params.requestId });
          let source = response.base64Encoded ? Buffer.from(response.body, "base64").toString() : response.body;
          const call = "if (!owner) rememberPositionAnchor(body, positionRef.current);";
          if (source.includes(call)) { assert(source.split(call).length === 2, "Exactly one growth snapshot call"); source = source.replace(call, "if (!owner) void 0;"); removedCalls++; }
          await c.call("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: Buffer.from(source).toString("base64") });
        } catch (error) { errors.push(error.message); await c.call("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" }).catch(() => {}); }
      }
    });
    await c.call("Page.enable"); await c.call("Runtime.enable"); await c.call("Debugger.enable");
    await c.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.call("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (skipGrowthSnapshot) await c.call("Fetch.enable", { patterns: [{ urlPattern: "*_next/static/chunks/*.js*", requestStage: "Response" }] });
    const seed = function() {
      localStorage.setItem("gloss:analytics:optout", "1");
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      const docId = location.pathname.split("/").at(-1);
      const paragraphs = Array.from({ length: 80 }, (_, n) => "第" + (n + 1) + "段用于验证阅读视口。这里还有第二句，确保下面始终有可见正文。");
      localStorage.setItem("gloss:doc:" + docId, JSON.stringify({ version: 1, docId, paragraphs, headings: [], footnotes: [], meta: { format: "txt", fileName: "G68 上方增长.txt", charCount: paragraphs.join("").length }, savedAt: Date.now() }));
      localStorage.setItem("gloss:structure:" + docId, JSON.stringify({ version: 1, prompt: "structure-v1", structure: "本地验证文档。", savedAt: Date.now() }));
    };
    await c.call("Page.addScriptToEvaluateOnNewDocument", { source: "(" + seed.toString() + ")();" });
    await single(); await c.call("Page.navigate", { url: ORIGIN + "/read/g68-growth-" + width + "-" + iteration + "-" + Date.now() });
    await wait(() => c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"), "growth reader");
    await c.evaluate("document.fonts.ready.then(()=>true)");
    await installROLogpoint(c, scripts); await single();
    await c.evaluate("document.querySelector('.sentence[data-index=\"0\"]').scrollIntoView({block:'center',behavior:'instant'})");
    const point = await c.evaluate("(()=>{const r=document.querySelector('.sentence[data-index=\"0\"]').getBoundingClientRect();return{x:r.left+Math.min(r.width/2,30),y:r.top+r.height/2}})()");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await c.call("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await wait(() => c.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\"0\"]')"), "growth panel");
    await c.evaluate("document.querySelector('.gloss-panel[data-sentence-index=\"0\"]').style.width='58px'");
    await wait(() => c.evaluate("!!document.querySelector('.gloss-panel-text')?.textContent.includes('这一段')"), "growth first text");
    await c.evaluate("(()=>{const p=document.querySelector('.gloss-panel[data-sentence-index=\"0\"]');window.scrollBy({top:p.getBoundingClientRect().bottom+220,behavior:'instant'})})()");
    // Start after the first text replaces the slow hint; this group isolates the panel's own reveal compensation.
    recording = true;
    const measured = await c.evaluate("(" + function() {
      const panel = document.querySelector('.gloss-panel[data-sentence-index="0"]');
      if (panel.getBoundingClientRect().bottom > 0) throw Error("Panel must be entirely above viewport");
      let anchor;
      for (const el of document.querySelectorAll(".reader-body .sentence")) {
        const node = el.firstChild; if (!(node instanceof Text)) continue;
        for (let i = 0; i < node.length; i++) { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); const b = r.getBoundingClientRect(); if (b.top >= 0 && b.top < innerHeight - 20) { anchor = r; break; } }
        if (anchor) break;
      }
      if (!anchor) throw Error("Missing growth reference");
      const first = anchor.getBoundingClientRect().top, frames = [], started = performance.now();
      let previous = first, maxStep = 0, maxCumulative = 0, signedSum = 0, stable = 0;
      return new Promise((resolve, reject) => {
        const tick = time => {
          if (document.visibilityState !== "visible") return reject(Error("Hidden growth page"));
          const top = anchor.getBoundingClientRect().top, step = top - previous;
          signedSum += step; maxStep = Math.max(maxStep, Math.abs(step)); maxCumulative = Math.max(maxCumulative, Math.abs(top - first)); previous = top;
          frames.push({ time, scrollY, top, step, panelHeight: panel.getBoundingClientRect().height });
          stable = panel.dataset.state === "done" ? stable + 1 : 0;
          if (stable >= 60) return resolve({ maxStep, maxCumulative, signedSum, frames });
          if (performance.now() - started > 25000) return reject(Error("Growth stream did not finish"));
          requestAnimationFrame(tick);
        }; requestAnimationFrame(tick);
      });
    }.toString() + ")()", true);
    recording = false;
    assert(errors.length === 0, "Growth injection errors", errors);
    if (skipGrowthSnapshot) assert(removedCalls === 1, "Growth negative control must remove exactly one call", removedCalls);
    await single();
    return { ...measured, roWrites: writes, roTotal: writes.reduce((sum, write) => sum + write.top, 0), removedCalls };
  } finally {
    await closeBrowser(edge, exited, c, browser, profile, "gloss-g68-growth-");
  }
}
async function sample(width,iteration,clicked,matched){
 const profile=await mkdtemp(join(tmpdir(),'gloss-g68-real-')),port=await freePort(),edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});let c,recording=false;
 const exited=new Promise(resolve=>edge.once('exit',resolve));
 const record={width,iteration,clicked,requests:[],roWrites:[],frames:[],api:[],breakpoint:null};
 try{
 let target;await wait(async()=>{try{const pages=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page');if(pages.length!==1)return false;target=pages[0];return true}catch{return false}},'single browser page');
 c=new Cdp(target.webSocketDebuggerUrl);const scripts=[];
 c.socket.on('message',raw=>{const m=JSON.parse(raw);if(m.method==='Runtime.executionContextsCleared')scripts.length=0;if(m.method==='Debugger.scriptParsed')scripts.push(m.params);
 if(m.method==='Runtime.consoleAPICalled'&&m.params.args?.[0]?.value==='__G68_RO_WRITE'&&recording){record.roWrites.push({...JSON.parse(m.params.args[1].value),stack:m.params.stackTrace?.callFrames.slice(0,8)});}
 if(m.method==='Page.screencastFrame'){if(recording)record.frames.push(m.params.metadata);c.call('Page.screencastFrameAck',{sessionId:m.params.sessionId}).catch(()=>{});}
 if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))record.api.push(m.params.request.url);
 });
 await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Network.setBlockedURLs',{urls:['*/api/analytics']});await c.call('DOMStorage.enable');await c.call('Debugger.enable');
 await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:'localStorage.setItem("gloss:analytics:optout","1")'});await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(()=>c.evaluate('location.origin==='+JSON.stringify(ORIGIN)),'origin');
 const id='g68-real-'+width+'-'+iteration+'-'+(clicked?'click':'control'),paragraphs=[Array.from({length:70},(_,i)=>'这段原文用于观察真实阅读滚动，白话增长期间继续阅读后面的内容。').join(''),...Array.from({length:60},(_,i)=>'第'+i+'段后续阅读内容。这里保留足够的正文，滚动不会到达页面底部。')];
 const storageId={securityOrigin:ORIGIN,isLocalStorage:true};
 for(const[key,value]of [['gloss:analytics:optout','1'],['gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs,headings:[],footnotes:[],meta:{format:'txt',fileName:'G68 阅读滚动.txt',charCount:paragraphs.join('').length},savedAt:Date.now()})],['gloss:structure:'+id,JSON.stringify({version:1,prompt:'structure-v1',structure:'本地滚动取证文档。',savedAt:Date.now()})]])await c.call('DOMStorage.setDOMStorageItem',{storageId,key,value});
 scripts.length=0;await c.call('Page.navigate',{url:ORIGIN+'/read/'+id});await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"11\"]')"),'reader');
 await c.evaluate('document.fonts.ready.then(()=>true)');await sleep(350);
 record.breakpoint=await installROLogpoint(c,scripts);
 if(clicked){
 const point=await c.evaluate("(()=>{const r=document.querySelector('.sentence[data-index=\"0\"]').getClientRects()[0];return{x:r.left+5,y:r.top+r.height/2}})()");
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.call('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
 await wait(()=>c.evaluate("document.querySelector('.gloss-panel-text')?.textContent.includes('这一段')"),'first streamed text');
 }else{await c.evaluate('window.scrollTo({top:'+matched.startY+',behavior:"instant"})');await sleep(350)}
 record.startY=await c.evaluate('scrollY');record.startText=await c.evaluate("document.querySelector('.gloss-panel-text')?.textContent??''");
 await c.call('Page.startScreencast',{format:'jpeg',quality:1,maxWidth:400,maxHeight:300,everyNthFrame:1});
 recording=true;const started=performance.now(),point=await c.evaluate("(()=>{const r=document.querySelector('.reader-body').getBoundingClientRect();return{x:r.left+r.width/2,y:450}})()");
 for(let i=0;i<20;i++){await sleep(Math.max(0,started+i*50-performance.now()));record.requests.push({number:i+1,requestedAt:performance.now(),deltaY:60});await c.call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:60});}
 if(clicked)await wait(()=>c.evaluate("document.querySelector('.gloss-panel')?.dataset.state==='done'"),'complete streamed text');else await sleep(Math.max(0,matched.duration-(performance.now()-started)));
 await sleep(350);record.duration=performance.now()-started;record.finalY=await c.evaluate('scrollY');record.endText=await c.evaluate("document.querySelector('.gloss-panel-text')?.textContent??''");recording=false;await c.call('Page.stopScreencast');
 record.reverseCount=record.roWrites.filter(r=>r.top<0).length;record.reverseTotal=record.roWrites.filter(r=>r.top<0).reduce((s,r)=>s+r.top,0);
 const pages=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page');assert(pages.length===1,'Only 1 page',pages);return record;
 }finally{await closeBrowser(edge,exited,c,null,profile,'gloss-g68-real-')}
}

try {
  let negativeFailures = 0;
  for (const width of (STREAM_ONLY ? [] : LEGACY ? [375] : [375, 1280])) {
    for (const injected of (LEGACY ? [false] : [false, true])) {
      await layoutBrowser(width, injected, async (c, load, capture) => {
        for (let iteration = 1; iteration <= 20; iteration++) {
          await load("below-" + width + "-" + injected + "-" + iteration);
          const result = { group: "a", width, injected, iteration, ...await belowAndScroll(c, capture) };
          results.push(result); await saveReport();
          const passed = Math.abs(result.delta) <= 1 && result.roWrites.length === 0;
          if (LEGACY) { if (!passed) negativeFailures++; }
          else assert(passed, "G-68 a: reader scroll was compensated", result);
        }
      });
      console.log(JSON.stringify({ group: "a", width, injected, trials: 20, maxDelta: Math.max(...results.filter(r => r.group === "a" && r.width === width && r.injected === injected).map(r => Math.abs(r.delta))), roWrites: results.filter(r => r.group === "a" && r.width === width && r.injected === injected).reduce((n, r) => n + r.roWrites.length, 0) }));
    }
    if (!LEGACY) await layoutBrowser(width, false, async (c, load, capture) => {
      await load("above-" + width);
      const result = { group: "b", width, ...await above(c, capture) }; results.push(result); await saveReport();
      assert(result.delta === 0, "G-68 b: above-anchor layout displacement", result); console.log(JSON.stringify(result));
    });
  }
  if (LEGACY) { assert(negativeFailures >= 1, "Legacy drift negative control was not detected"); console.log(JSON.stringify({ negativeFailures, maxDelta: Math.max(...results.map(r => Math.abs(r.delta))) })); console.log("G-68 legacy negative control detected"); }
  else {
    for (const width of [375, 1280]) for (let iteration = 1; iteration <= 5; iteration++) {
      const clicked = await sample(width, iteration, true), control = await sample(width, iteration, false, clicked);
      const result = { group: "c", width, iteration, clicked, control, difference: clicked.finalY - control.finalY }; results.push(result); await saveReport();
      console.log(JSON.stringify({ group: "c", width, iteration, reverseCount: clicked.reverseCount, reverseTotal: clicked.reverseTotal, difference: result.difference }));
      if (!REFERENCE) assert(clicked.reverseCount === 0 && clicked.reverseTotal === 0, "G-68 c: reverse RO scroll", result);

    }
    if (!REFERENCE && !STREAM_ONLY) {
      for (const width of [375, 1280]) for (let iteration = 1; iteration <= 5; iteration++) {
        const result = { group: "d", width, iteration, ...await streamingAbove(width, iteration) };
        results.push(result); await saveReport();
        console.log(JSON.stringify({ group: "d", width, iteration, maxStep: result.maxStep, maxCumulative: result.maxCumulative, signedSum: result.signedSum, roTotal: result.roTotal }));
        assert(result.maxStep <= 0.5 && result.maxCumulative <= 1 && result.roTotal === 0, "G-68 d: duplicate panel-growth compensation", result);
      }
      const negative = { group: "d-negative", width: 375, ...await streamingAbove(375, 1, true) };
      results.push(negative); await saveReport();
      assert(negative.roTotal > 0 && negative.maxCumulative > 1, "Growth snapshot negative control did not expose double compensation", negative);
      console.log(JSON.stringify({ group: "d-negative", maxStep: negative.maxStep, maxCumulative: negative.maxCumulative, roTotal: negative.roTotal, removedCalls: negative.removedCalls }));
    }
    console.log("G-68 document-coordinate checks passed");
  }
  allAssertionsPassed = true;
} catch (error) { await saveReport(); console.error(error.message); process.exitCode = 1; }
finally { await removeProfiles(); }
