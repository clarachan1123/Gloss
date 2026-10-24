import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
process.env.G19_IMPORT_ONLY = "1";
const { Cdp, freePort } = await import("./verify-g19.mjs");
const ROOT = resolve(import.meta.dirname, "..");
const ORIGIN = process.env.G64A_ORIGIN ?? "http://127.0.0.1:3486";
const BASE = process.env.G64A_BASE_ORIGIN ?? "http://127.0.0.1:3487";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (v, label, detail) => { if (!v) throw Error(label + (detail === undefined ? "" : ": " + JSON.stringify(detail))); };
const evaluate = (c, fn, ...args) => c.evaluate("(" + fn.toString() + ")(" + args.map(v => JSON.stringify(v)).join(",") + ")");
async function wait(c, expression, label) { const end = Date.now() + 20000; while (Date.now() < end) { if (await c.evaluate(expression)) return; await sleep(100); } throw Error("等待失败：" + label); }
const modules = new Map();
async function sourceModule(file) {
  if (modules.has(file)) return modules.get(file);
  const source = await readFile(file, "utf8"), compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const names = [...compiled.matchAll(/require\("(\.[^"]+)"\)/g)].map(m => m[1]), deps = new Map();
  for (const name of names) deps.set(name, await sourceModule(resolve(dirname(file), name + ".ts")));
  const exports = {}; new Function("require", "exports", compiled)(name => deps.get(name), exports); modules.set(file, exports); return exports;
}
const selection = await sourceModule(join(ROOT, "lib/selection.ts"));
const { segmentParagraphs } = await sourceModule(join(ROOT, "lib/segment.ts"));
const sample = JSON.parse(await readFile(join(ROOT, "public/samples/shan-yu-e.json"), "utf8"));
const counts = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0 };
function setup() {
  localStorage.setItem("gloss:analytics:optout", "1");
  localStorage.setItem("gloss:sample:breathed", "1");
  window.__g64 = { callbacks: 0 };
  const nativeRAF = requestAnimationFrame;
  window.requestAnimationFrame = callback => nativeRAF(time => { window.__g64.callbacks++; callback(time); });
  window.__g64.glyphs = () => {
    const out = [];
    for (const span of document.querySelectorAll(".reader-body .sentence")) {
      const node = span.firstChild, block = span.closest("[data-para]");
      if (!(node instanceof Text) || !block) continue;
      for (let offset = 0; offset < node.length;) {
        const ch = String.fromCodePoint(node.data.codePointAt(offset)), range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + ch.length); const r = range.getBoundingClientRect();
        out.push({ key: block.dataset.para + ":" + (Number(span.dataset.offset) + offset), paraIndex: Number(block.dataset.para), offset: Number(span.dataset.offset) + offset, index: Number(span.dataset.index), char: ch, x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom });
        offset += ch.length;
      }
    }
    return out;
  };
}
async function navigate(c, url) {
  await c.call("Page.enable");
  const loaded = new Promise((resolveLoad, reject) => {
    const timer = setTimeout(() => { c.socket.off("message", listener); reject(Error("DOMContentLoaded等待失败")); }, 20000);
    const listener = raw => { if (JSON.parse(raw).method === "Page.domContentEventFired") { clearTimeout(timer); c.socket.off("message", listener); resolveLoad(); } };
    c.socket.on("message", listener);
  });
  await c.call("Page.navigate", { url }); await loaded;
  await wait(c, "document.querySelector('.reader-body')?.dataset.measuring==='false'", "正文就绪");
  await c.evaluate("document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,400)))");
}
async function click(c, selector) { await evaluate(c, selector => document.querySelector(selector).click(), selector); }
const toggle = width => width < 768 ? ".reader-selection-mobile" : ".reader-selection-desktop";
async function stable(c, action, label) {
  const before = await c.evaluate("__g64.glyphs().filter(g=>g.y<innerHeight&&g.bottom>0&&g.width>0&&g.height>0)");
  await action();
  const result = await evaluate(c, before => new Promise(resolveCheck => {
    const sample = () => {
      const now = new Map(__g64.glyphs().map(g => [g.key, g]));
      for (const g of before) { const next = now.get(g.key); if (!next || next.x !== g.x || next.y !== g.y) return { key: g.key, dx: next ? next.x - g.x : null, dy: next ? next.y - g.y : null }; }
      return null;
    };
    let failure = sample(), frames = 0;
    const frame = () => { failure ??= sample(); if (++frames < 60) requestAnimationFrame(frame); else resolveCheck({ failure, frames }); };
    requestAnimationFrame(frame);
  }), before);
  assert(!result.failure, label, result); counts.b++;
}
async function glyph(c, paraIndex, offset, align = false) {
  if (align) {
    await evaluate(c, (p,o) => { const g = __g64.glyphs().find(g => g.paraIndex === p && g.offset === o); if (!g) throw Error("字不存在"); scrollBy({ top: g.y - 180, behavior: "instant" }); }, paraIndex, offset);
    await sleep(100);
  }
  const g = await evaluate(c, (p,o) => __g64.glyphs().find(g => g.paraIndex === p && g.offset === o), paraIndex, offset);
  assert(g && g.width > 0, "真实原文字框", { paraIndex, offset });
  return { x: g.x + g.width / 2, y: g.y + g.height / 2 };
}
async function touch(c, p) {
  await c.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
  await c.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function drag(c, a, b, middle) {
  await c.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
  await c.call("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
  if (middle) await middle();
  const end = typeof b === "function" ? await b() : b;
  await c.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: end.x, y: end.y, button: "left", buttons: 1 });
  await c.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1 });
}
async function expected(c, paragraphs, a, b) {
  const exp = selection.normalizeSelection(paragraphs, segmentParagraphs(paragraphs).sentences, a, b);
  const got = await c.evaluate("(()=>{const bar=document.querySelector('.reader-selection-bar');return {kind:bar.dataset.selectionKind,chars:Number(bar.dataset.selectionChars),message:bar.querySelector('[role=status]').textContent,text:typeof CSS.highlights==='undefined'?null:[...(CSS.highlights.get('gloss-selection')??[])].map(r=>r.toString()).join('')}})()");
  assert(got.kind === exp.kind && got.chars === exp.chars, "选区分流与字数", { got, expected: { kind: exp.kind, chars: exp.chars } });
  if (got.text !== null) assert(got.text === exp.text.replace(/\n/g, ""), "选区原文与纯函数一致");
}
async function seed(c, paragraphs, fileName) {
  await evaluate(c, (paragraphs,fileName) => {
    localStorage.setItem("gloss:doc:g64a-fixture", JSON.stringify({ version: 1, docId: "g64a-fixture", paragraphs, headings: [], footnotes: [], meta: { format: "txt", fileName, charCount: paragraphs.join("\n").length }, savedAt: Date.now() }));
    localStorage.setItem("gloss:structure:g64a-fixture", JSON.stringify({ prompt: "structure-v1", structure: "本地验证结构。", savedAt: Date.now() }));
  }, paragraphs,fileName);
}
async function header(c) {
  return c.evaluate("(()=>{const bar=document.querySelector('.col-left');const q=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height,font:getComputedStyle(e).fontSize}};return {available:bar.clientWidth,back:q('.reader-shelf-back'),heading:q('.reader-mobile-heading'),title:q('.reader-mobile-title'),progress:q('.reader-mobile-progress'),aa:q('.col-left .reader-typography-aa'),selection:document.querySelector('.reader-selection-mobile')?q('.reader-selection-mobile'):null,overflow:bar.scrollWidth-bar.clientWidth}})()");
}
async function ordinary(c) {
  await c.evaluate("getSelection()?.removeAllRanges();document.dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await wait(c,"!document.querySelector('.gloss-panel')","普通行为准备：面板已关闭");
  await sleep(350);
  const g=await glyph(c,2,0,true);
  await c.call("Input.dispatchMouseEvent",{type:"mouseMoved",x:g.x,y:g.y});
  const hover=await c.evaluate("document.querySelector('.sentence[data-index=\"4\"]').classList.contains('sentence-hover')");
  await c.evaluate("document.querySelector('.sentence[data-index=\"4\"]').click()");
  await wait(c,"!!document.querySelector('.gloss-panel[data-sentence-index=\"4\"]')","普通点句白话");
  const menu=await c.evaluate("(()=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100});document.querySelector('.sentence[data-index=\"4\"]').dispatchEvent(e);return {prevented:e.defaultPrevented,visible:!!document.querySelector('.reader-context-menu')}})()");
  await sleep(100);
  menu.visible=await c.evaluate("!!document.querySelector('.reader-context-menu')");
  await c.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await c.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  const a=await glyph(c,2,0,true),b=await glyph(c,2,2);
  const before=await c.evaluate("document.querySelectorAll('.gloss-panel').length");
  await drag(c,a,b);
  const copy=await c.evaluate("getSelection().toString()");
  const after=await c.evaluate("document.querySelectorAll('.gloss-panel').length");
  await c.evaluate("getSelection().removeAllRanges();document.body.click()");
  return {hover,menu,copy,copyDidNotOpen:before===after};
}

async function realClick(c, selector, button = "left") {
  const p=typeof selector==="string"?await evaluate(c,s=>{const e=document.querySelector(s);if(!e)throw Error("真实点击目标不存在："+s);const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},selector):selector;
  await c.call("Input.dispatchMouseEvent",{type:"mouseMoved",x:p.x,y:p.y});
  await c.call("Input.dispatchMouseEvent",{type:"mousePressed",x:p.x,y:p.y,button,clickCount:1});
  await c.call("Input.dispatchMouseEvent",{type:"mouseReleased",x:p.x,y:p.y,button,clickCount:1});
}
async function menuReady(c, origin) {
  await navigate(c,origin+"/read/sample");
  await glyph(c,2,0,true);
  await click(c,'.sentence[data-index="4"]');
  await wait(c,'document.querySelector(".gloss-panel[data-sentence-index=\\"4\\"]")?.dataset.state==="done"',"菜单准备白话完成");
  await c.evaluate('document.querySelector(".gloss-panel[data-sentence-index=\\"4\\"]").scrollIntoView({block:"center",behavior:"instant"})');
  await sleep(400);
  const p=await c.evaluate('(()=>{const e=document.querySelector(".gloss-panel-text"),n=document.createTreeWalker(e,NodeFilter.SHOW_TEXT).nextNode(),r=document.createRange();r.setStart(n,0);r.setEnd(n,1);const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()');
  await realClick(c,p,"right");
  await wait(c,'!!document.querySelector(".reader-context-menu")',"真实右键菜单");
}
async function menuState(c) {
  return c.evaluate('({menuClosed:!document.querySelector(".reader-context-menu"),typographyOpened:!!document.querySelector(".reader-typography-popover,.reader-typography-sheet"),glossRemains:!!document.querySelector(".gloss-panel[data-sentence-index=\\"4\\"]")})');
}
async function menuChecks(c,width) {
  const results={};
  for(const [name,target] of [["g2",width<768?".col-left .reader-typography-aa":".settings-typography-toggle"],["g3Blank",null],["g3Sentence",5]]) {
    const sides={};
    for(const [side,origin]of [["base",BASE],["work",ORIGIN]]) {
      await menuReady(c,origin);
      let p=target;
      if(target===null)p=await c.evaluate('(()=>{const r=document.querySelector(".reader-body").getBoundingClientRect();for(let y=75;y<innerHeight-80;y+=5)for(const x of [r.left+2,r.right-2,(r.left+r.right)/2]){const e=document.elementFromPoint(x,y);if(x>0&&x<innerWidth&&e?.closest(".reader-body")&&!e.closest(".sentence,.gloss-panel,.reader-context-menu"))return {x,y}}throw Error("找不到可真实点击的正文空白")})()');
      if(typeof target==="number")p=await evaluate(c,i=>{const g=__g64.glyphs().find(g=>g.index!==4&&g.y>70&&g.bottom<innerHeight-80&&document.elementFromPoint(g.x+g.width/2,g.y+g.height/2)?.closest(".sentence")?.dataset.index===String(g.index));if(!g)throw Error("另一句坐标不在视口");return {x:g.x+g.width/2,y:g.y+g.height/2}},target);
      if(name.startsWith("g3"))assert(await evaluate(c,(p,blank)=>{const e=document.elementFromPoint(p.x,p.y);return blank?!!e?.closest(".reader-body")&&!e.closest(".sentence,.gloss-panel,.reader-context-menu"):!!e?.closest(".sentence")&&e.closest(".sentence").dataset.index!=="4"},p,target===null),"g3真实点击落在预期正文位置："+name);
      await realClick(c,p);await sleep(400);sides[side]=await menuState(c);
    }
    assert(JSON.stringify(sides.base)===JSON.stringify(sides.work),"菜单既有行为对照："+name,sides);
    results[name]=sides;counts.g++;
  }
  await menuReady(c,ORIGIN);
  await realClick(c,toggle(width));
  const g1={...await menuState(c),pressed:await evaluate(c,s=>document.querySelector(s).getAttribute("aria-pressed"),toggle(width)),hint:await c.evaluate('!!document.querySelector(".reader-selection-bar")')};
  assert(g1.menuClosed&&g1.glossRemains&&g1.pressed==="true"&&g1.hint,"g1一次真实点击进入",g1);
  counts.g++;results.g1=g1;
  console.log(JSON.stringify({width,menuChecks:results}));
  await navigate(c,ORIGIN+"/read/sample");
}
async function pixels(c) {
  const shot=await c.call("Page.captureScreenshot",{format:"png",fromSurface:true});
  return shot.data;
}
async function samplePixel(c,png,x,y) {
  return evaluate(c,(png,x,y)=>new Promise((resolvePixel,reject)=>{
    const image=new Image();image.onload=()=>{const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);resolvePixel([...ctx.getImageData(x,y,1,1).data].slice(0,3));};image.onerror=reject;image.src="data:image/png;base64,"+png;
  }),png,x,y);
}
function colorNear(actual,expected){return actual.every((v,i)=>Math.abs(v-expected[i])<=3);}
async function highlightChecks(c) {
  const themes={parchment:[232,220,181],"moon-white":[216,216,226],"eye-green":[203,216,195],dark:[74,66,56]};
  for(const [theme,rgb]of Object.entries(themes)) {
    await evaluate(c,theme=>{localStorage.setItem("gloss:settings:theme",theme==="dark"?"parchment":theme);localStorage.setItem("gloss:settings:appearance",theme==="dark"?"dark":"light")},theme);
    await navigate(c,ORIGIN+"/read/sample");
    const start=sample.paragraphs[2].indexOf("资本主义");
    const a=await glyph(c,2,start,true),b=await glyph(c,2,start+2);
    await c.call("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
    const before=await pixels(c);
    const info=await evaluate(c,(p,o)=>{const g=__g64.glyphs().find(g=>g.paraIndex===p&&g.offset===o);const s=getComputedStyle(document.documentElement),probe=document.createElement("span");probe.style.color="var(--paper-main)";document.body.append(probe);const paper=getComputedStyle(probe).color.match(/\d+/g).slice(0,3).map(Number);probe.remove();return {g,paper,token:s.getPropertyValue("--selection-bg").trim()}},2,start);
    // 只根据选前截图寻找字框右侧的纸色间隙，不依据选后颜色挑点。
    const point=await evaluate(c,(png,g,paper)=>new Promise((resolvePoint,reject)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);for(let x=Math.floor(g.x+g.width)-2;x>=Math.ceil(g.x+g.width/2);x--)for(let y=Math.floor(g.y+g.height/2);y<Math.floor(g.bottom)-2;y++){const v=[...ctx.getImageData(x,y,1,1).data].slice(0,3);if(v.every((n,i)=>Math.abs(n-paper[i])<=3)){resolvePoint({x,y});return}}reject(Error("找不到字形间隙纸色像素"))};image.onerror=reject;image.src="data:image/png;base64,"+png}),before,info.g,info.paper);
    await click(c,toggle(1024));await drag(c,a,b);await sleep(400);
    const selected=await samplePixel(c,await pixels(c),point.x,point.y);
    assert(colorNear(selected,rgb),"h选区间隙像素："+theme,{point,selected,expected:rgb});
    // 运行时注入异色，沿用同一像素及同一 RGB 判据，必须检出失败。
    await c.evaluate('(()=>{const s=document.createElement("style");s.id="g64-color-negative";s.textContent=":root{--selection-bg:#ff00ff!important}";document.head.append(s)})()');await sleep(400);
    const changed=await samplePixel(c,await pixels(c),point.x,point.y);
    let negative=false;try{assert(colorNear(changed,rgb),"h异色负对照",{changed,rgb});}catch{negative=true;}
    assert(negative,"h异色负对照必须失败");await c.evaluate('document.getElementById("g64-color-negative").remove()');await sleep(400);
    await click(c,".reader-selection-actions button");
    await sleep(400);
    const cleared=await samplePixel(c,await pixels(c),point.x,point.y);
    assert(colorNear(cleared,info.paper),"h清除后纸色："+theme,{point,cleared,expected:info.paper});
    await click(c,toggle(1024));counts.h++;
    console.log(JSON.stringify({theme,highlightPixel:{point,selected,expected:rgb,cleared,paper:info.paper,negativeDetected:negative}}));
  }
}


const menuNegative=process.env.G64A_MENU_NEGATIVE==="1";
let diagnostic=null;
async function prepareMenuNegative() {
  const sourcePath=join(ROOT,"components/reader/Reader.tsx"),source=await readFile(sourcePath,"utf8");
  const guard='suppressOutsideClickRef.current = !(event.target instanceof Element && event.target.closest("[data-selection-control]"));';
  assert(source.split(guard).length===2,"源码整文件恰好一处排除");
  const matches=[];
  for(const file of await readdir(join(ROOT,".next/static/chunks")))if(file.endsWith(".js")){
    const body=await readFile(join(ROOT,".next/static/chunks",file),"utf8");
    const found=[...body.matchAll(/\w+\.current=!\(\w+\.target instanceof Element&&\w+\.target.closest\("\[data-selection-control\]"\)\)/g)];
    for(const match of found)matches.push({file,body,guard:match[0]});
  }
  assert(matches.length===1,"构建整文件排除恰好一处",matches.length);
  const chunk=matches[0],assignment=chunk.guard.split("=")[0]+"=true/* 诊断副本：注释划选排除 */";
  const sourceCopy=join(ROOT,"tmp-g64a-menu-negative.tsx"),chunkCopy=join(ROOT,"tmp-g64a-menu-negative.js");
  const patched=chunk.body.replace(chunk.guard,assignment);
  await writeFile(sourceCopy,source.replace(guard,"/* "+guard+" */ suppressOutsideClickRef.current = true;"));
  await writeFile(chunkCopy,patched);
  diagnostic={sourcePath,sourceCopy,chunkCopy,file:chunk.file,body:patched,before:createHash("sha256").update(source).digest("hex"),hits:0};
}

async function run(width) {
  const profile = await mkdtemp(join(tmpdir(), "gloss-g64a-edge-")), port = await freePort();
  const edge = spawn(EDGE, ["--headless=new", "--disable-sync", "--no-default-browser-check", "--no-first-run", "--remote-debugging-port=" + port, "--remote-allow-origins=*", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let c; let exited = false; edge.on("exit", () => exited = true);
  try {
    let pages;
    const end = Date.now() + 20000;
    while (Date.now() < end) { try { pages = await (await fetch("http://127.0.0.1:" + port + "/json")).json(); break; } catch { await sleep(100); } }
    assert(pages, "Edge启动"); assert(pages.filter(p => p.type === "page").length === 1, "只有1个页面");
    c = new Cdp(pages.find(p => p.type === "page").webSocketDebuggerUrl);
    await c.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.call("Emulation.setFocusEmulationEnabled", { enabled: true });
    await c.call("Page.addScriptToEvaluateOnNewDocument", { source: "(" + setup.toString() + ")()" });
    // 所有模型请求均在浏览器内替换为确定的本地响应。
    await c.call("Fetch.enable", { patterns: [{ urlPattern: "*/api/*" },...(diagnostic?[{urlPattern:"*/"+diagnostic.file}]:[])] });
    c.socket.on("message", raw => {
      const m = JSON.parse(raw);
      if(m.method==="Fetch.requestPaused"&&diagnostic&&m.params.request.url.endsWith("/"+diagnostic.file)){diagnostic.hits++;void c.call("Fetch.fulfillRequest",{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:"application/javascript"}],body:Buffer.from(diagnostic.body).toString("base64")});return;}
      if (m.method === "Fetch.requestPaused") void c.call("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/plain" }], body: Buffer.from("本地验证白话，不连接模型服务。").toString("base64") });
    });
    if(menuNegative){await menuReady(c,ORIGIN);await realClick(c,toggle(width));const state={...await menuState(c),pressed:await evaluate(c,s=>document.querySelector(s).getAttribute("aria-pressed"),toggle(width)),hint:await c.evaluate('!!document.querySelector(".reader-selection-bar")')};let detected=false;try{assert(state.menuClosed&&state.glossRemains&&state.pressed==="true"&&state.hint,"g1一次真实点击进入",state);}catch(error){detected=true;console.log(JSON.stringify({menuNegativeFailure:error.message}));}assert(detected&&diagnostic.hits===1,"菜单负对照必须失败且诊断脚本加载一次",{state,hits:diagnostic.hits});return;}
    await navigate(c, BASE + "/read/sample");
    const baselineBehavior = await ordinary(c);
    const baselineFonts = await c.evaluate("['.reader-mobile-title','.reader-mobile-progress','.col-left .reader-typography-aa','.reader-tool-aa','.reader-body'].map(s=>{const e=document.querySelector(s);return e?getComputedStyle(e).fontSize:null})");
    await navigate(c, ORIGIN + "/read/sample");
    const fonts = await c.evaluate("['.reader-mobile-title','.reader-mobile-progress','.col-left .reader-typography-aa','.reader-tool-aa','.reader-body'].map(s=>{const e=document.querySelector(s);return e?getComputedStyle(e).fontSize:null})");
    assert(JSON.stringify(fonts) === JSON.stringify(baselineFonts), "既有字号与对照相同", { fonts, baselineFonts });
    const entries = await c.evaluate("[...document.querySelectorAll('[aria-label=划选]')].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled&&e.tabIndex>=0).length");
    assert(entries === 1, "唯一可点可聚焦入口", entries); counts.a++;
    await stable(c, () => click(c, toggle(width)), "进入模式与提示条");
    const start = sample.paragraphs[2].indexOf("资本主义"), a = { paraIndex: 2, offset: start }, b = { paraIndex: 2, offset: start + 2 };
    const p = await glyph(c, 2, start, true), q = await glyph(c, 2, start + 2);
    await stable(c, async () => { if (width < 768) { await touch(c, p); await touch(c, q); } else await drag(c, p, q); }, "选区高亮");
    await expected(c, sample.paragraphs, a, b); counts.c++; counts.d++;
    await stable(c, () => click(c, ".reader-selection-actions button"), "清选区");
    const cancelled = await c.evaluate("(()=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('.sentence').dispatchEvent(e);return e.defaultPrevented})()");
    assert(cancelled, "模式阻止系统菜单"); counts.f++;
    await sleep(400);
    const idle = await c.evaluate("__g64.callbacks"); await sleep(3000);
    assert(await c.evaluate("__g64.callbacks") === idle, "静置3秒没有rAF回调"); counts.f++;
    await stable(c, () => click(c, toggle(width)), "退出模式");
    await click(c,toggle(width));
    await glyph(c,2,start,true);
    await click(c,toggle(width));
    // 负对照：正文高度变化必须被同一逐字检查器检出。
    let negative = false;
    try { await stable(c, () => c.evaluate("(()=>{const n=document.createElement('div');n.id='g64-negative';n.style.height='10px';(()=>{const first=__g64.glyphs().find(g=>g.y>100&&g.bottom<innerHeight-120);const span=[...document.querySelectorAll('.sentence')].find(e=>Number(e.dataset.index)===first.index);span.after(n)})()})()"), "负对照"); } catch { negative = true; }
    assert(negative, "高度负对照被检出"); await c.evaluate("document.getElementById('g64-negative').remove()");
    const cases = [["中国的儒道",0,4],["那一种是对的？",0,5]];
    for (const [word,from,to] of cases) {
      const offset = sample.paragraphs[2].indexOf(word);
      await click(c, toggle(width)); const a = await glyph(c,2,offset+from,true), b = await glyph(c,2,offset+to);
      if (width<768) {await touch(c,a);await touch(c,b);} else await drag(c,a,b);
      await expected(c,sample.paragraphs,{paraIndex:2,offset:offset+from},{paraIndex:2,offset:offset+to});counts.d++;
      await click(c, ".reader-selection-actions button:last-child");
    }
    await click(c,toggle(width));
    if(width>=768) {
      await drag(c,await glyph(c,2,start+2,true),await glyph(c,2,start));await expected(c,sample.paragraphs,b,a);counts.c++;
      await click(c, ".reader-selection-actions button");
      const first=await glyph(c,0,0,true);
      await drag(c,first,()=>glyph(c,1,5),async()=>{await glyph(c,1,5,true);});
      await expected(c,sample.paragraphs,{paraIndex:0,offset:0},{paraIndex:1,offset:5});counts.c++;
    } else {
      await touch(c,await glyph(c,0,0,true));
      await c.call("Input.dispatchMouseEvent",{type:"mouseWheel",x:width/2,y:300,deltaY:400,deltaX:0});await sleep(400);
      const end=await c.evaluate("__g64.glyphs().find(g=>g.char.trim()&&g.y>=80&&g.bottom<innerHeight-120)");
      await touch(c,{x:end.x+end.width/2,y:end.y+end.height/2});
      await expected(c,sample.paragraphs,{paraIndex:0,offset:0},{paraIndex:end.paraIndex,offset:end.offset});counts.c++;
    }
    await click(c, ".reader-selection-actions button:last-child");
    // 已展开白话保持，Esc 只退出模式。
    await c.evaluate("document.querySelector('.sentence[data-index=\"4\"]').click()");
    await wait(c,"!!document.querySelector('.gloss-panel')","已有白话");
    await wait(c,"document.querySelector('.gloss-panel[data-sentence-index=\"4\"]')?.dataset.state==='done'","端点准备：白话显示完成");
    await c.evaluate("document.querySelector('.gloss-panel[data-sentence-index=\"4\"]').scrollIntoView({block:'center',behavior:'instant'})");
    await sleep(400);
    const panels=await c.evaluate("document.querySelectorAll('.gloss-panel').length");
    await click(c,toggle(width));
    const exclusions = await c.evaluate("(()=>{return ['.gloss-panel-text','.reader-tail-placeholder'].map(selector=>{const e=document.querySelector(selector);if(!e)return null;const node=document.createTreeWalker(e,NodeFilter.SHOW_TEXT).nextNode();if(!node)return null;const r=document.createRange();r.setStart(node,0);r.setEnd(node,1);const b=r.getBoundingClientRect();return {selector,x:b.x+b.width/2,y:b.y+b.height/2,width:b.width}})})()");
    for (const p of exclusions.filter(Boolean)) {
      assert(p.width>0,"排除端点有真实字框",p.selector);
      const hit = await evaluate(c,p=>{const e=document.elementFromPoint(p.x,p.y);return {panel:!!e?.closest(".gloss-panel"),source:!!e?.closest(".sentence"),tag:e?.tagName}},p);
      if(p.selector===".gloss-panel-text")assert(hit.panel,"准备坐标确实命中白话",hit);
      if(width<768)await touch(c,p);else await drag(c,p,p);
      assert(await c.evaluate("document.querySelector('.reader-selection-bar').dataset.selectionChars===undefined&&!CSS.highlights.has('gloss-selection-start')"),"白话与透明尾巴不会成为端点",p.selector);counts.c++;
    }
    assert(exclusions[0],"必须覆盖白话端点排除");
    if(width===375)assert(exclusions[1],"375必须覆盖透明尾巴端点排除");
    await c.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await c.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    assert(await c.evaluate("document.querySelectorAll('.gloss-panel').length")===panels,"Esc不穿透收起");counts.e++;
    assert(await c.evaluate("!document.querySelector('.reader-body').classList.contains('reader-body-selection')&&getComputedStyle(document.querySelector('.reader-body')).userSelect!=='none'"),"退出恢复系统选字");counts.e++;
    const behavior = await ordinary(c); assert(JSON.stringify(behavior)===JSON.stringify(baselineBehavior),"退出后点句、复制、右键、悬停与对照相同",{behavior,baselineBehavior});counts.e+=4;
    if(width===375) {
      const paragraphs=["😀".repeat(1000)+"尾。","😀".repeat(1001)+"尾。",...Array.from({length:1198},()=> "本地段落。")];
      await seed(c,paragraphs,"这是一本超过二十个汉字的超长书名用来检查手机顶栏布局.txt");
      await navigate(c,ORIGIN+"/read/g64a-fixture");const h=await header(c);
      assert(h.selection.width===72&&h.selection.height===44&&h.back.right<=h.heading.left&&h.heading.right<=h.selection.left&&h.selection.right<=h.aa.left&&h.overflow===0,"375顶栏装得下",h);
      console.log(JSON.stringify({width,header:h}));counts.a++;
      for(const [para,n]of [[0,1000],[1,1001]]) {
        await click(c,toggle(width));await touch(c,await glyph(c,para,0,true));
        await touch(c,await glyph(c,para,(n-1)*2,true));
        await expected(c,paragraphs,{paraIndex:para,offset:0},{paraIndex:para,offset:(n-1)*2});
        assert(await c.evaluate("[...document.querySelectorAll('.reader-selection-actions button')].find(b=>b.textContent==='确定').disabled")===(n>1000),"1000字确认门槛",n);counts.d++;
        await click(c,".reader-selection-actions button:last-child");
      }
    }
    if(width===375||width===1024)await menuChecks(c,width);
    if(width===1024)await highlightChecks(c);
    const supported=await c.evaluate("typeof CSS.highlights!=='undefined'");
    const current=await(await fetch("http://127.0.0.1:"+port+"/json")).json();assert(current.filter(p=>p.type==="page").length===1,"收尾只有1个页面");
    console.log(JSON.stringify({width,cssHighlights:supported,counts:{...counts},negativeDetected:negative,passed:true}));
  } finally {
    if(c){try{await c.call("Browser.close");}catch{}c.close();}
    if(!exited)await Promise.race([new Promise(r=>edge.once("exit",r)),sleep(5000)]);
    assert(exited,"浏览器进程退出");
    assert(dirname(resolve(profile))===resolve(tmpdir())&&profile.startsWith(join(tmpdir(),"gloss-g")),"安全配置目录");
    await rm(profile,{recursive:true,force:true});
  }
}
if(menuNegative){await prepareMenuNegative();try{await run(1024);}finally{const after=createHash("sha256").update(await readFile(diagnostic.sourcePath)).digest("hex");await rm(diagnostic.sourceCopy);await rm(diagnostic.chunkCopy);assert(after===diagnostic.before,"产品源码负对照前后哈希一致");console.log(JSON.stringify({menuNegativeDetected:true,productSha256Before:diagnostic.before,productSha256After:after,diagnosticDeleted:true}));}}else for(const width of [375,506,768,1024,1280,1440]) await run(width);
console.log(JSON.stringify({passed:true,counts}));
