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


// 开发探针独立运行，不计入 i–viii 的正式验收。
const RESULT_PARAGRAPHS = [
  "开头介绍海岸的变化。这里作为不变的参照段。",
  "这一段描写不同的海面。先记住潮水会来回移动。",
  "沿岸的人观察天气。风向有时也会改变。",
  "这里先说潮汐如何改变海水，然后说明月亮怎样影响水面。接下来讨论海岸的其他现象。还会继续比较不同地区的情况。",
  ...Array.from({length:60},()=>"后面的原文用于检查可见字的位置。读者可以继续向下阅读。")
];
async function prepareResults(c,width) {
  await navigate(c,ORIGIN+"/read/sample");
  await evaluate(c,width=>{const theme={375:"parchment",506:"moon-white",768:"eye-green",1024:"dark",1280:"parchment",1440:"moon-white"}[width];localStorage.setItem("gloss:settings:theme",theme==="dark"?"parchment":theme);localStorage.setItem("gloss:settings:appearance",theme==="dark"?"dark":"light");localStorage.setItem("gloss:settings:reading-mode","review");for(const key of ["gloss:pos:g64a-fixture","gloss:saved:g64a-fixture","gloss:selection-saved:g64a-fixture"])localStorage.removeItem(key);},width);
  await c.evaluate('new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase("gloss-selection-cache");r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error("缓存未关闭"));})');
  await seed(c,RESULT_PARAGRAPHS,"划选结果本地验证.txt");
  await navigate(c,ORIGIN+"/read/g64a-fixture");
  await c.evaluate("("+resultMock.toString()+")()");
  await c.evaluate("("+returnHarness.toString()+")()");
  await evaluate(c,text=>__g64.resultParagraph=text,RESULT_PARAGRAPHS[3]);
  await glyph(c,3,0,true);
}

function returnHarness(){
  __g64.openings=new Map();
  __g64.captureOpening=(id,para,end,closingIndexes=[])=>{
    const panels=[...document.querySelectorAll(".gloss-panel")],closing=panels.filter(p=>!p.classList.contains("gloss-panel-saved")&&(p.dataset.selectionId||closingIndexes.includes(Number(p.dataset.sentenceIndex))));
    const current=__g64.glyphs().map(g=>({...g,docY:g.y+scrollY}));
    const bases=closing.map(p=>__g64.openings.get(p.dataset.selectionId??"sentence:"+p.dataset.sentenceIndex)).filter(base=>base&&base.para===para).sort((a,b)=>a.panels.length-b.panels.length);
    // 合并与新插入共用一次布局事务：原行基准取被替换面板打开前的排版，不能把它的旧续排当作原行。
    if(bases.length){
      const base=bases[0],old=new Map(base.glyphs.map(g=>[g.key,g])),first=base.glyphs[0],same=current.find(g=>g.key===first.key);
      const dy=same.y-first.y;
      for(const g of current)if(old.has(g.key)){const original=old.get(g.key);g.x=original.x;g.y=original.y+dy;g.docY=g.y+scrollY;}
    }
    __g64.openings.set(id,{id,para,end,glyphs:current,scrollY,panels:panels.filter(p=>!closing.includes(p)).map(p=>p.dataset.selectionId??"sentence:"+p.dataset.sentenceIndex)});
  };
  __g64.captureReturn=(selector,futureScroll=0)=>{
    const panel=document.querySelector(selector);
    if(!panel)throw Error("回接检查必须有待收起面板");
    const id=panel.dataset.selectionId??"sentence:"+panel.dataset.sentenceIndex,base=__g64.openings.get(id);
    if(!base)throw Error("缺少打开前的原行基准："+id);
    const now=__g64.glyphs(),byKey=new Map(now.map(g=>[g.key,g])),rect=panel.getBoundingClientRect();
    const returning=base.glyphs.filter(g=>g.paraIndex===base.para&&g.offset>=base.end).filter(g=>{
      const n=byKey.get(g.key);return n&&n.y>=rect.bottom-.5&&(Math.abs(n.y+scrollY-g.docY)>.5||Math.abs(n.x-g.x)>.5);
    });
    const keys=new Set(returning.map(g=>g.key));
    const references=now.filter(g=>!keys.has(g.key)&&g.y>60+futureScroll&&g.bottom<innerHeight+futureScroll&&g.char.trim());
    const reference=references.find(g=>g.paraIndex<base.para)??references[0];
    if(!returning.length||!reference)throw Error("场景必须实际触发回接且有非回接参照字："+JSON.stringify({id,returning:returning.length,references:references.length}));
    const originalReference=base.glyphs.find(g=>g.key===reference.key);
    if(!originalReference)throw Error("原行基准缺少参照字");
    return {id,base,returning,reference,originalReference,scrollY,paragraph:__g64.resultParagraph};
  };
  __g64.checkReturn=(state,scrollDelta=0)=>new Promise(resolve=>{
    let failure=null,frames=0,maxReturn=0,maxReference=0,returningCount=0,newContinuationCount=0;
    const frame=()=>{
      const now=new Map(__g64.glyphs().map(g=>[g.key,g])),ref=now.get(state.reference.key);
      if(!ref)failure??={label:"参照字丢失",key:state.reference.key};
      else{
        const drift=Math.max(Math.abs(ref.x-state.reference.x),Math.abs(ref.y-state.reference.y+scrollDelta));
        maxReference=Math.max(maxReference,drift);
        if(drift>=1)failure??={label:"非回接参照字位移",key:ref.key,dx:ref.x-state.reference.x,dy:ref.y-state.reference.y+scrollDelta};
        // 同一事务新插入的面板会再续排自己的后文；这些字交给插入检查，不算已回到原行的字。
        const newContinuations=[...document.querySelectorAll(".gloss-panel")].filter(panel=>!state.base.panels.includes(panel.dataset.selectionId??"sentence:"+panel.dataset.sentenceIndex)).map(panel=>{
          const spans=[...document.querySelectorAll('.sentence[data-index="'+panel.dataset.sentenceIndex+'"]')];
          return {para:Number(spans[0]?.closest("[data-para]")?.getAttribute("data-para")),end:Math.max(...spans.map(span=>Number(span.dataset.offset)+span.textContent.length))};
        });
        const returned=state.returning.filter(g=>!newContinuations.some(c=>c.para===g.paraIndex&&g.offset>=c.end));
        returningCount=returned.length;newContinuationCount=state.returning.length-returned.length;
        for(const old of returned){
          const g=now.get(old.key),expectedY=old.y+ref.y-state.originalReference.y;
          const d=g?Math.max(Math.abs(g.x-old.x),Math.abs(g.y-expectedY)):Infinity;
          maxReturn=Math.max(maxReturn,d);
          if(d>.5)failure??={label:"回接字不在打开前的原行位置",key:old.key,dx:g?g.x-old.x:null,dy:g?g.y-expectedY:null};
        }
      }
      if(++frames<60)requestAnimationFrame(frame);
      else{
        const spans=[...document.querySelectorAll('[data-reader-block][data-para="'+state.base.para+'"] .sentence')];
        const text=spans.map(s=>s.textContent).join("");
        const keys=__g64.glyphs().filter(g=>g.paraIndex===state.base.para).map(g=>g.key);
        const integrity=text===state.paragraph&&new Set(keys).size===keys.length;
        if(!integrity)failure??={label:"回接后原文重复或丢失"};
        resolve({failure,frames,returning:returningCount,newContinuationCount,reference:state.reference.key,maxReturn,maxReference,integrity});
      }
    };requestAnimationFrame(frame);
  });
  __g64.findUnique=phrase=>{
    const x=scrollX,y=scrollY,selection=getSelection(),saved=[...Array(selection.rangeCount)].map((_,i)=>selection.getRangeAt(i).cloneRange());
    selection.removeAllRanges();
    let first=null,count=0;
    for(let i=0;i<3;i++){
      if(!window.find(phrase,false,false,true,false,false,false))break;
      const range=selection.getRangeAt(0);
      if(first&&range.startContainer===first.node&&range.startOffset===first.offset)break;
      first??={node:range.startContainer,offset:range.startOffset};count++;
    }
    selection.removeAllRanges();saved.forEach(r=>selection.addRange(r));scrollTo({left:x,top:y,behavior:"instant"});
    return count;
  };
}
async function recordOpening(c,source){
  const sentence=segmentParagraphs(RESULT_PARAGRAPHS).sentences.filter(s=>s.paraIndex===source.end.paraIndex&&s.start<source.end.offset).at(-1);
  const id=[source.kind,source.start.paraIndex,source.start.offset,source.end.paraIndex,source.end.offset].join(":");
  const touched=segmentParagraphs(RESULT_PARAGRAPHS).sentences.filter(s=>(s.paraIndex>source.start.paraIndex||s.paraIndex===source.start.paraIndex&&s.start+s.text.length>source.start.offset)&&(s.paraIndex<source.end.paraIndex||s.paraIndex===source.end.paraIndex&&s.start<source.end.offset)).map(s=>s.index);
  await evaluate(c,(id,para,end,touched)=>__g64.captureOpening(id,para,end,touched),id,sentence.paraIndex,sentence.start+sentence.text.length,touched);
}
async function captureReturn(c,selector='[data-selection-id]:not(.gloss-panel-saved)',futureScroll=0){
  return evaluate(c,(selector,futureScroll)=>__g64.captureReturn(selector,futureScroll),selector,futureScroll);
}
async function assertReturn(c,state,label,scrollDelta=0){
  const result=await evaluate(c,(state,scrollDelta)=>__g64.checkReturn(state,scrollDelta),state,scrollDelta);
  const finds=await evaluate(c,phrase=>__g64.findUnique(phrase),RESULT_PARAGRAPHS[3].slice(0,14));
  assert(!result.failure&&result.returning>0&&result.integrity&&finds===1,label,{...result,finds});
  console.log(JSON.stringify({returnCheck:{label,...result,finds}}));
  counts.returnChecks=(counts.returnChecks??0)+1;
  return result;
}

function resultMock(){
  const original=window.fetch;
  __g64.singleRequests=[];__g64.resultRequests=[];__g64.resultEvents=[];__g64.resultErrors=[];__g64.resultMode="done";
  addEventListener("gloss:analytics",event=>__g64.resultEvents.push(event.detail));
  addEventListener("unhandledrejection",event=>__g64.resultErrors.push(String(event.reason?.message??event.reason)));
  window.fetch=async function(url,init){
    const path=String(url);
    if(path.endsWith("/api/gloss"))__g64.singleRequests.push({input:JSON.parse(init.body)});
    if(!path.endsWith("/api/term")&&!path.endsWith("/api/range-gloss"))return original.apply(this,arguments);
    const kind=path.endsWith("/api/term")?"term":"range",mode=__g64.resultMode;
    __g64.resultRequests.push({kind,input:JSON.parse(init.body)});
    if(mode==="refused")return Response.json({error:"refused"},{status:422});
    if(mode==="error")return Response.json({error:"api_error"},{status:502});
    const text=("这里是在说海水随月亮的影响不断变化。").repeat(kind==="term"?5:9).slice(0,kind==="term"?100:150);
    let timer,offset=0,stopped=false;
    return new Response(new ReadableStream({
      start(controller){
        const abort=()=>{stopped=true;clearTimeout(timer);controller.error(new DOMException("aborted","AbortError"));};
        if(init.signal?.aborted){abort();return;}
        init.signal?.addEventListener("abort",abort,{once:true});
        const next=()=>{if(stopped)return;if(mode==="stream-error"&&offset>=40){stopped=true;controller.error(new Error("本地模拟断流"));return;}if(offset>=text.length){stopped=true;init.signal?.removeEventListener("abort",abort);controller.close();return;}controller.enqueue(new TextEncoder().encode(text.slice(offset,offset+=4)));timer=setTimeout(next,50);};
        timer=setTimeout(next,100);
      },cancel(){stopped=true;clearTimeout(timer);}
    }),{headers:{"content-type":"text/plain"}});
  };
}
async function chooseResult(c,width,a,b,paraIndex=3) {
  await click(c,toggle(width));
  const first=await glyph(c,paraIndex,a,true),last=await glyph(c,paraIndex,b);
  if(width<768){await touch(c,first);await touch(c,last);}else await drag(c,first,last);
  const source=selection.normalizeSelection(RESULT_PARAGRAPHS,segmentParagraphs(RESULT_PARAGRAPHS).sentences,{paraIndex,offset:a},{paraIndex,offset:b});
  assert(source,"新场景必须形成选区");
  await evaluate(c,source=>__g64.chosenResult=source,source);
  return source;
}

async function resultFunctionalSmoke(c,width,source){
  await c.evaluate('localStorage.setItem("gloss:analytics:optout","0");__g64.resultEvents=[]');
  const panel="[data-selection-id]";
  assert(await c.evaluate("document.querySelector('[data-selection-id] .gloss-panel-title').textContent")==="「潮汐」在这里指什么","语境标题");
  assert(await c.evaluate("document.querySelectorAll('[data-selection-id] .action-row button').length")===1,"仅留下，无解释占位");
  await click(c,panel+" .action-row-save");
  await wait(c,"!!document.querySelector('.gloss-panel-saved[data-selection-id]')&&document.querySelectorAll('[data-saved-selection-id]').length===1","保存成功才切换");
  const record=await c.evaluate('JSON.parse(localStorage.getItem("gloss:selection-saved:g64a-fixture")).entries[0]');
  assert(Object.keys(record).sort().join(",")==="end,model,promptVersion,resultKind,savedAt,sourceHash,start,text","独立记录字段");
  const savedClose=await captureReturn(c,panel);
  await resultReadingMode(c,width);
  await wait(c,"!document.querySelector('[data-selection-id]')&&CSS.highlights.has('gloss-result-saved')","保存范围收起与点状下划线");
  await assertReturn(c,savedClose,"iv 模式切换收起已留下范围");
  const savedPoint=await glyph(c,3,source.start.offset,true);
  await recordOpening(c,source);
  await realClick(c,savedPoint);
  await wait(c,"!!document.querySelector('[data-selection-id]')&&!CSS.highlights.has('gloss-result-saved')","点击范围展开");
  const savedToggle=await captureReturn(c,panel);
  await realClick(c,await glyph(c,3,source.start.offset));
  await wait(c,"!document.querySelector('[data-selection-id]')&&CSS.highlights.has('gloss-result-saved')","再点范围收起");
  await assertReturn(c,savedToggle,"iv 点击已留下范围收起");
  await click(c,"[data-saved-selection-id]");
  await sleep(1000);
  await wait(c,"!!document.querySelector('[data-selection-id]')","左栏范围跳转");
  const top=await evaluate(c,p=>__g64.glyphs().find(g=>g.paraIndex===p.paraIndex&&g.offset===p.offset).y,source.start);
  assert(Math.abs(top-(width<768?await c.evaluate('document.querySelector(".col-left").getBoundingClientRect().bottom'):0))<1,"跳到范围首字",top);
  await navigate(c,ORIGIN+"/read/g64a-fixture");
  await wait(c,"document.querySelectorAll('[data-saved-selection-id]').length===1&&CSS.highlights.has('gloss-result-saved')","刷新恢复保存范围");
  assert(await c.evaluate("!document.querySelector('[data-selection-id]')"),"刷新保留收起模式");
  console.log(JSON.stringify({resultFunctionalSmoke:{width,savedFields:true,collapsedUnderline:true,rangeToggle:true,sidebarJump:true,refresh:true}}));
}

async function resultProbe(c,width) {
  await prepareResults(c,width);
  const a=RESULT_PARAGRAPHS[3].indexOf("潮汐");
  const source=await chooseResult(c,width,a,a+1);
  const before=await c.evaluate("({glyphs:__g64.glyphs().filter(g=>g.y>60&&g.bottom<innerHeight),para:document.querySelector('.reader-paragraph:nth-child(4)').getBoundingClientRect().height})");
  await click(c,".reader-selection-actions button:nth-child(2)");
  await wait(c,"!!document.querySelector('[data-selection-id]')","范围结果插入");
  await sleep(100);
  const initial=await evaluate(c,before=>{const panel=document.querySelector("[data-selection-id]"),r=panel.getBoundingClientRect(),style=getComputedStyle(panel),now=new Map(__g64.glyphs().map(g=>[g.key,g]));return{height:r.height,marginTop:style.marginTop,marginBottom:style.marginBottom,para:document.querySelector(".reader-paragraph:nth-child(4)").getBoundingClientRect().height,changes:before.glyphs.map(g=>{const n=now.get(g.key);return{para:g.paraIndex,offset:g.offset,dx:n?n.x-g.x:null,dy:n?n.y-g.y:null}}),errors:__g64.resultErrors};},before);
  await wait(c,"document.querySelector('[data-selection-id]')?.dataset.state==='done'","范围结果放完");
  console.log(JSON.stringify({resultProbe:{width,source:{start:source.start,end:source.end},beforePara:before.para,initial:{height:initial.height,marginTop:initial.marginTop,marginBottom:initial.marginBottom,para:initial.para,errors:initial.errors,changes:[...new Map(initial.changes.map(g=>[g.para+":"+g.dx+":"+g.dy,g])).values()]},final:await c.evaluate("({height:document.querySelector('[data-selection-id]').getBoundingClientRect().height,requests:__g64.resultRequests.length,errors:__g64.resultErrors})")}}));
  await resultFunctionalSmoke(c,width,source);
}


async function resultGeometry(c,width,mode="done",kind="term"){
  await prepareResults(c,width);
  await c.evaluate('localStorage.setItem("gloss:analytics:optout","0");__g64.resultEvents=[]');
  await evaluate(c,mode=>__g64.resultMode=mode,mode);
  const source=kind==="term"?await chooseResult(c,width,4,5):await chooseResult(c,width,0,32);
  const sentence=segmentParagraphs(RESULT_PARAGRAPHS).sentences.find(s=>s.paraIndex===3&&s.start<=source.end.offset-1&&s.start+s.text.length>=source.end.offset);
  const input={source,sentenceEnd:sentence.start+sentence.text.length,mode};
  await evaluate(c,input=>{
    const before=__g64.glyphs().filter(g=>g.y>60&&g.bottom<innerHeight);
    const end=before.find(g=>g.paraIndex===input.source.end.paraIndex&&g.offset===input.source.end.offset-1);
    if(!end)throw Error("必须存在选区末字");
    const above=before.filter(g=>g.y<end.y||g.paraIndex===3&&g.offset<input.sentenceEnd);
    const paraBefore=document.querySelector(".reader-paragraph:nth-child(4)").getBoundingClientRect().height;
    __g64.geometryPromise=new Promise(resolve=>{
      let previous=null,initial=null,frames=0,settled=0,growth=0,failure=null;
      const fail=(label,detail)=>{failure??={label,...detail};};
      const frame=()=>{
        frames++;
        const panel=document.querySelector('[data-selection-id]');
        if(panel&&document.querySelector(".reader-body").dataset.measuring==="false"){
          if(input.mode==="negative-h"&&!__g64.letterFault){const span=document.querySelector('[data-para="3"] .sentence');span.classList.add("g64-spacing-negative");span.style.letterSpacing="1px";__g64.letterFault=true;}
          const rect=panel.getBoundingClientRect(),now=new Map(__g64.glyphs().map(g=>[g.key,g]));
          for(const g of above){const n=now.get(g.key);if(!n||n.x!==g.x||n.y!==g.y)fail("选区末字与上方字严格不动",{key:g.key,dx:n?n.x-g.x:null,dy:n?n.y-g.y:null});}
          const translate=getComputedStyle(document.querySelector(".reader-body")).translate.split(/\s+/).map(parseFloat).filter(Number.isFinite);
          if(translate.some(v=>Math.abs(v)>=1))fail("translate 小于一像素",{translate});
          if(!initial){
            const sentenceLast=before.find(g=>g.paraIndex===3&&g.offset===input.sentenceEnd-1);
            const tail=before.filter(g=>g.paraIndex===3&&g.offset>=input.sentenceEnd&&g.y===sentenceLast?.y);
            for(const g of tail){const n=now.get(g.key);if(!n||n.y<rect.bottom)fail("G-63 原行尾字必须续排至面板下方",{key:g.key,top:n?.y,panelBottom:rect.bottom});}
            const originals=[...document.querySelectorAll('[data-reader-block][data-para="3"] .sentence')].map(e=>e.textContent).join("");
            if(originals!==__g64.resultParagraph)fail("G-63 续排原文恰好一次且顺序不变",{length:originals.length});
            const paraAfter=document.querySelector(".reader-paragraph:nth-child(4)").getBoundingClientRect().height;
            const delta=paraAfter-paraBefore;
            for(const g of before.filter(g=>g.paraIndex>3)){const n=now.get(g.key);if(!n||n.x!==g.x||Math.abs(n.y-g.y-delta)>.5)fail("初次插入下段随续排后的高度位移",{key:g.key,dy:n?n.y-g.y:null,delta});}
            initial={height:rect.height,tailCount:tail.length,paragraphGrowth:delta};
          }else if(previous){
            const dh=rect.height-previous.height;
            if(dh!==0)growth++;
            for(const g of previous.below){const n=now.get(g.key);if(!n||Math.abs(n.y-g.y-dh)>.5)fail("后续可见字随面板同帧增高",{key:g.key,dy:n?n.y-g.y:null,dh,state:panel.dataset.state});}
          }
          previous={height:rect.height,below:[...now.values()].filter(g=>g.y>=rect.bottom&&g.bottom<innerHeight&&g.y>60)};
          const done=["done","failed"].includes(panel.dataset.state);
          settled=done?settled+1:0;
          if(settled>=60){resolve({failure,initial,frames,settled,growth,state:panel.dataset.state});return;}
        }
        if(frames>=1200){resolve({failure:failure??{label:"采样未完成"},frames,initial,growth});return;}
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  },input);
  await evaluate(c,text=>__g64.resultParagraph=text,RESULT_PARAGRAPHS[3]);
  await click(c,".reader-selection-actions button:nth-child(2)");
  const result=await c.evaluate("__g64.geometryPromise");
  console.log(JSON.stringify({resultGeometry:{width,mode,kind,...result}}));
  if(mode==="negative-h"){assert(result.failure,"h 改变原文字距必须被 i 检出",result);counts.negativeH=(counts.negativeH??0)+1;return;}
  assert(!result.failure,"i 初次续排与后续逐帧位移",result);
  assert(result.initial.height>0&&result.initial.paragraphGrowth>0&&result.settled>=60,"i 风险被触发且离散变化后采样六十帧",result);
  if(mode==="done")assert(result.growth>0,"i 流式面板确实增高",result);
  counts.i=(counts.i??0)+1;
}


async function confirmResult(c){await recordOpening(c,await c.evaluate("__g64.chosenResult"));await click(c,".reader-selection-actions button:nth-child(2)");await wait(c,"!!document.querySelector('[data-selection-id]')","结果出现");}
async function finishResult(c){await wait(c,"document.querySelector('[data-selection-id]:not(.gloss-panel-saved)')?.dataset.state==='done'","临时结果完成");}

async function resultCollapseCheck(c,kind,point){
  const state=await captureReturn(c);
  if(kind==="escape"){await c.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await c.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});}
  else if(kind==="source")await realClick(c,await glyph(c,3,point));
  else if(kind==="other")await realClick(c,await glyph(c,4,0));
  else await c.evaluate("document.querySelector('.reader-body').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await wait(c,"!document.querySelector('[data-selection-id]:not(.gloss-panel-saved)')","临时结果收起 "+kind);
  await assertReturn(c,state,"iii "+kind+" 回接与参照字");
  counts.iii=(counts.iii??0)+1;
}

async function resultMerge(c,width){
  await prepareResults(c,width);
  const first=segmentParagraphs(RESULT_PARAGRAPHS).sentences.find(s=>s.paraIndex===3);
  await evaluate(c,(id,para,end)=>__g64.captureOpening(id,para,end),"sentence:"+first.index,3,first.start+first.text.length);
  await realClick(c,await glyph(c,3,0,true));
  await wait(c,"document.querySelector('.gloss-panel:not([data-selection-id])')?.dataset.state==='done'","合并前单句完成");
  const source=await chooseResult(c,width,0,32);
  assert(source.kind==="range","合并选区必须为范围白话",source);
  const mergeReturn=await captureReturn(c,".gloss-panel:not([data-selection-id])");
  await confirmResult(c);
  await wait(c,"!document.querySelector('.gloss-panel:not([data-selection-id])')","夹带临时单句被合并");
  await assertReturn(c,mergeReturn,"ii 合并临时单句白话");
  const last=segmentParagraphs(RESULT_PARAGRAPHS).sentences.filter(s=>s.paraIndex===3&&s.start<source.end.offset).at(-1);
  assert(await c.evaluate("Number(document.querySelector('[data-selection-id]').dataset.sentenceIndex)")===last.index,"合并结果插在末字源句之后");
  await finishResult(c);
  assert(await c.evaluate("!document.querySelector('[data-selection-id] .gloss-panel-title')&&document.querySelectorAll('[data-selection-id] .action-row button').length===1"),"范围无标题且仅留下");
  counts.ii=(counts.ii??0)+1;
  for(const kind of ["escape","blank","other","source"]){
    if(kind!=="escape"){await prepareResults(c,width);await chooseResult(c,width,0,32);await confirmResult(c);await finishResult(c);}
    await resultCollapseCheck(c,kind,source.start.offset);
  }
  await prepareResults(c,width);await chooseResult(c,width,0,32);await confirmResult(c);await finishResult(c);
  assert(await c.evaluate("document.querySelectorAll('.gloss-panel').length")===1,"离屏场景只关闭被测面板");
  const offscreenState=await captureReturn(c,undefined,1800);
  const readerScroll=await c.evaluate("(()=>{dispatchEvent(new WheelEvent('wheel'));const y=scrollY;scrollBy({top:1800,behavior:'instant'});return scrollY-y;})()");
  assert(readerScroll===1800,"离屏滚动量实际触发",readerScroll);
  await wait(c,"!document.querySelector('[data-selection-id]')","整段离屏收起");
  await assertReturn(c,offscreenState,"iii 整段离屏回接",readerScroll);
  assert(await c.evaluate("scrollY")>1000,"离屏风险实际触发");counts.iii++;
  console.log(JSON.stringify({resultMerge:{width,merged:true,rangePanel:true,collapsePaths:5}}));
}
async function resultEvents(c,width){
  await prepareResults(c,width);
  await c.evaluate('localStorage.setItem("gloss:analytics:optout","0");__g64.resultEvents=[]');
  await chooseResult(c,width,4,5);await confirmResult(c);await finishResult(c);
  const events=await c.evaluate("__g64.resultEvents");
  const selectionEvents=events.filter(e=>e.event.startsWith("selection_"));
  const fields={selection_mode_enter:["event","pointer"],selection_confirm:["event","resultKind","charsBucket","sentenceCountBucket"],selection_result:["event","resultKind","outcome"],selection_save:["event","resultKind"]};
  for(const event of selectionEvents)assert(Object.keys(event).sort().join(",")===fields[event.event].sort().join(","),"vii 新事件仅白名单字段",event);
  assert(selectionEvents.some(e=>e.event==="selection_mode_enter")&&selectionEvents.some(e=>e.event==="selection_confirm")&&selectionEvents.some(e=>e.event==="selection_result"&&e.outcome==="done"),"vii 新事件实际触发",selectionEvents);
  assert(!events.some(e=>/^(sentence_click|gloss_|deep_explain_|report_error_click)/.test(e.event)),"vii 词语结果不发送点句旧事件",events.map(e=>e.event));
  await resultCollapseCheck(c,"escape",4);
  await c.evaluate('localStorage.setItem("gloss:analytics:optout","1");__g64.resultEvents=[]');
  await chooseResult(c,width,0,32);await confirmResult(c);await finishResult(c);
  assert((await c.evaluate("__g64.resultEvents")).length===0,"vii 退出开关下零发送");
  counts.vii=(counts.vii??0)+2;
  console.log(JSON.stringify({resultEvents:{width,whitelist:true,noOldEvents:true,optout:true}}));
}


async function resultReadingMode(c,width){
  if(width<768){
    await click(c,".reader-typography-aa");
    await wait(c,"!!document.querySelector('.reader-typography-sheet')","手机设置打开");
    await click(c,".reader-more-typography");
    await click(c,".reader-typography-sheet .mode-options .mode-option:nth-child(2)");
    await click(c,'[aria-label="关闭阅读设置"]');
  }else await click(c,".mode-options .mode-option:nth-child(2)");
}

async function resultMultiple(c,width){
  await prepareResults(c,width);
  for(const start of [0,4]){
    await chooseResult(c,width,start,32);await confirmResult(c);await finishResult(c);
    await click(c,"[data-selection-id]:not(.gloss-panel-saved) .action-row-save");
    await wait(c,"document.querySelectorAll('.gloss-panel-saved[data-selection-id]').length==="+(start===0?1:2),"多个范围分别保存");
  }
  await chooseResult(c,width,6,32);await confirmResult(c);await finishResult(c);
  const order=await c.evaluate("[...document.querySelectorAll('[data-selection-id]')].map(e=>({id:e.dataset.selectionId,index:e.dataset.sentenceIndex,saved:e.classList.contains('gloss-panel-saved')}))");
  assert(order.length===3&&new Set(order.map(e=>e.index)).size===1&&order[0].id.split(':')[2]==='0'&&order[1].id.split(':')[2]==='4'&&!order[2].saved,"v 同一位置两保存加一临时按起点排序",order);
  await resultCollapseCheck(c,"escape",6);
  await resultReadingMode(c,width);
  await wait(c,"document.querySelectorAll('[data-selection-id]').length===0","阅读模式收起两条保存范围");
  await realClick(c,await glyph(c,3,4,true));
  const expanded=await c.evaluate("[...document.querySelectorAll('.gloss-panel-saved[data-selection-id]')].map(e=>e.dataset.selectionId)");
  assert(expanded.length===1&&expanded[0]===order[1].id,"v 重叠点击展开最短保存范围",expanded);
  assert(await c.evaluate("JSON.parse(localStorage.getItem('gloss:selection-saved:g64a-fixture')).entries.length")===2,"v 重叠存储互不覆盖");
  counts.v=(counts.v??0)+1;
  console.log(JSON.stringify({resultMultiple:{width,panels:3,shortest:true,savedRecords:2}}));
}
async function resultReaderScroll(c,width){
  await prepareResults(c,width);
  await chooseResult(c,width,0,32);await confirmResult(c);
  await wait(c,"document.querySelector('[data-selection-id]')?.dataset.state==='busy'&&document.querySelector('[data-selection-id] .gloss-panel-text')?.textContent.length>0","生成中实际已有文字");
  const before=await c.evaluate("scrollY");
  await c.call("Input.dispatchMouseEvent",{type:"mouseWheel",x:width/2,y:500,deltaY:120,deltaX:0});
  await sleep(150);
  const result=await c.evaluate("new Promise(resolve=>{const values=[];const frame=()=>{values.push(scrollY);if(values.length<60)requestAnimationFrame(frame);else resolve({values,text:document.querySelector('[data-selection-id] .gloss-panel-text')?.textContent.length,state:document.querySelector('[data-selection-id]')?.dataset.state});};requestAnimationFrame(frame);})");
  assert(result.values[0]>=before+119&&result.values.every(y=>y>=before+119),"vi 读者滚动不被补偿抵消",{before,min:Math.min(...result.values),max:Math.max(...result.values)});
  assert(result.text>0,"vi 生成风险实际触发");counts.vi=(counts.vi??0)+1;
  console.log(JSON.stringify({resultReaderScroll:{width,before,min:Math.min(...result.values),max:Math.max(...result.values),frames:result.values.length}}));
}


async function resultWhole(c,width){
  await prepareResults(c,width);
  await c.evaluate('localStorage.setItem("gloss:analytics:optout","0");__g64.resultEvents=[]');
  await realClick(c,await glyph(c,3,4,true));
  await wait(c,"document.querySelector('.gloss-panel:not([data-selection-id])')?.dataset.state==='done'","整句复用前已有完成单句");
  const before=await c.evaluate("({text:document.querySelector('.gloss-panel-text').textContent,requests:__g64.singleRequests.length})");
  await c.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await c.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await wait(c,"!document.querySelector('.gloss-panel')","整句复用前收起单句");
  const sentence=segmentParagraphs(RESULT_PARAGRAPHS).sentences.find(s=>s.paraIndex===3);
  const source=await chooseResult(c,width,0,sentence.text.length-1);
  assert(source.kind==="sentence","整句选区分流",source.kind);
  await click(c,".reader-selection-actions button:nth-child(2)");
  await wait(c,"document.querySelector('.gloss-panel:not([data-selection-id])')?.dataset.state==='done'","确认整句复用已有单句");
  const after=await c.evaluate("({text:document.querySelector('.gloss-panel-text').textContent,requests:__g64.singleRequests.length,selectionRequests:__g64.resultRequests.length,events:__g64.resultEvents.map(e=>e.event),explain:!!document.querySelector('.action-row-explain')})");
  assert(before.text===after.text&&before.requests===after.requests&&after.selectionRequests===0&&after.explain,"整句复用不发新请求并沿用原操作行",{before,after});
  assert(after.events.includes("selection_confirm")&&after.events.some(e=>e==="sentence_click"||e==="sentence_reclick"),"整句沿用点句埋点",after.events);
  counts.whole=(counts.whole??0)+1;
}
async function resultInputAndPointer(c,width){
  const original=RESULT_PARAGRAPHS[3];
  try{
    RESULT_PARAGRAPHS[3]="这里先说潮汐"+"海水".repeat(600)+"。";
    await prepareResults(c,width);
    await c.evaluate('localStorage.setItem("gloss:analytics:optout","0");__g64.resultEvents=[]');
    const invalid=await chooseResult(c,width,4,5);
    assert(invalid.kind==="term"&&RESULT_PARAGRAPHS[3].length>1000,"非法输入场景必须是短词落在超预算源句中",invalid.kind);
    await click(c,".reader-selection-actions button:nth-child(2)");
    await wait(c,"document.querySelector('[data-selection-id]')?.dataset.state==='failed'","输入校验失败显示错误面板");
    const error=await c.evaluate("({errors:__g64.resultErrors,requests:__g64.resultRequests.length,disabled:document.querySelector('[data-selection-id] .action-row-save').disabled})");
    assert(error.errors.length===0&&error.requests===0&&error.disabled,"校验失败不抛异常、不请求、不可留下",error);
  }finally{RESULT_PARAGRAPHS[3]=original;}
  await prepareResults(c,width);
  await chooseResult(c,width,4,5);
  const point=await c.evaluate("(()=>{const r=document.querySelector('.reader-selection-actions button:nth-child(2)').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  if(width<768)await touch(c,point);else await realClick(c,point);
  await finishResult(c);
  const painted=await c.evaluate("({mouse:CSS.highlights.has('gloss-result-mouse'),touch:CSS.highlights.has('gloss-result-touch'),legacy:document.querySelectorAll('.sentence-active').length,mode:document.querySelector('[data-selection-control][aria-pressed=true]')!==null})");
  assert(painted.mouse===(width>=768)&&painted.touch===(width<768)&&painted.legacy===0&&!painted.mode,"确认指针来源只走原文 Custom Highlight",painted);
  counts.inputAndPointer=(counts.inputAndPointer??0)+1;
}

async function resultNewCases(c,width){
  for(const kind of ["term","range"])for(const mode of ["done","error","refused","stream-error"])await resultGeometry(c,width,mode,kind);
  await resultMerge(c,width);
  await resultEvents(c,width);
  await resultWhole(c,width);
  await resultInputAndPointer(c,width);
  await resultMultiple(c,width);
  await resultReaderScroll(c,width);
  if(width===1024){await resultReplacement(c,width);await resultGeometry(c,width,"negative-h");}
  await prepareResults(c,width);const source=await chooseResult(c,width,4,5);await confirmResult(c);await finishResult(c);
  await resultFunctionalSmoke(c,width,source);counts.iv=(counts.iv??0)+1;
}


const compensationNegative=process.env.G64A_ANCHOR_NEGATIVE==="1";
async function prepareCompensationNegative(){
  const sourcePath=join(ROOT,"components/reader/Reader.tsx"),source=await readFile(sourcePath,"utf8");
  const ast=ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),sourceMatches=[];
  const visit=node=>{if(ts.isIfStatement(node)&&node.expression.getText(ast)==="transaction?.anchor"&&node.thenStatement.getText(ast).includes("growthAnchorRef.current.scrollY"))sourceMatches.push(node);ts.forEachChild(node,visit);};visit(ast);
  assert(sourceMatches.length===1,"补偿源码整文件匹配恰好一处",sourceMatches.length);
  const sourceNode=sourceMatches[0],sourceCopy=join(ROOT,"tmp-g64a-anchor-negative.tsx"),chunkCopy=join(ROOT,"tmp-g64a-anchor-negative.js");
  const chunks=[];
  for(const file of await readdir(join(ROOT,".next/static/chunks")))if(file.endsWith(".js")){
    const body=await readFile(join(ROOT,".next/static/chunks",file),"utf8"),tree=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const scan=node=>{if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken&&/^[$\w]+\?\.anchor$/.test(node.left.getText(tree))&&node.right.getText(tree).includes(".scrollY=window.scrollY"))chunks.push({file,body,start:node.getStart(tree),end:node.end,condition:node.left.getText(tree)});ts.forEachChild(node,scan);};scan(tree);
  }
  assert(chunks.length===1,"补偿构建整文件匹配恰好一处",chunks.length);
  const chunk=chunks[0],patched=chunk.body.slice(0,chunk.start)+"void 0"+chunk.body.slice(chunk.end);
  await writeFile(sourceCopy,source.slice(0,sourceNode.getStart(ast))+"if (transaction?.anchor) { /* 诊断副本：插入后的锚定补偿已注释 */ }"+source.slice(sourceNode.end));
  await writeFile(chunkCopy,patched);
  diagnostic={sourcePath,sourceCopy,chunkCopy,file:chunk.file,body:patched,before:createHash("sha256").update(source).digest("hex"),hits:0};
}

async function resultReplacement(c,width,negative=false){
  await prepareResults(c,width);
  await chooseResult(c,width,4,5);await confirmResult(c);await finishResult(c);
  const source=await chooseResult(c,width,4,5,4);
  assert(await c.evaluate("document.querySelectorAll('[data-selection-id]').length")===1,"旧临时结果在确认之前仍然存在");
  const state=await captureReturn(c);
  await confirmResult(c);
  const result=await evaluate(c,state=>__g64.checkReturn(state),state);
  const finds=await evaluate(c,phrase=>__g64.findUnique(phrase),RESULT_PARAGRAPHS[3].slice(0,14));
  console.log(JSON.stringify({resultReplacement:{width,negative,...result,finds}}));
  if(negative){assert(result.failure&&diagnostic.hits>=1,"g 禁用补偿必须被 i 检出",{...result,hits:diagnostic.hits});counts.negativeG=(counts.negativeG??0)+1;}
  else{assert(!result.failure&&result.returning>0&&result.integrity&&finds===1,"i 替换旧结果的回接与非回接参照字",result);counts.i=(counts.i??0)+1;counts.returnChecks=(counts.returnChecks??0)+1;}
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
    if(compensationNegative){await resultReplacement(c,width,true);return;}
    if(process.env.G64A_EXTRA_ONLY==="1"){await resultWhole(c,width);await resultInputAndPointer(c,width);return;}
    if(process.env.G64A_REPLACEMENT_ONLY==="1"){await resultReplacement(c,width);return;}
    if(process.env.G64A_SPACING_NEGATIVE==="1"){await resultGeometry(c,width,"negative-h");return;}
    if(process.env.G64A_RESULTS_ONLY==="1"){await resultNewCases(c,width);return;}
    if(process.env.G64A_RESULT_PROBE==="1"){await resultProbe(c,width);return;}
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
    await resultNewCases(c,width);
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
if(compensationNegative){await prepareCompensationNegative();try{await run(1024);}finally{const after=createHash("sha256").update(await readFile(diagnostic.sourcePath)).digest("hex");await rm(diagnostic.sourceCopy);await rm(diagnostic.chunkCopy);assert(after===diagnostic.before,"产品源码补偿负对照前后哈希一致");console.log(JSON.stringify({anchorNegativeDetected:true,productSha256Before:diagnostic.before,productSha256After:after,diagnosticDeleted:true}));}process.exit(0);}
if(menuNegative){await prepareMenuNegative();try{await run(1024);}finally{const after=createHash("sha256").update(await readFile(diagnostic.sourcePath)).digest("hex");await rm(diagnostic.sourceCopy);await rm(diagnostic.chunkCopy);assert(after===diagnostic.before,"产品源码负对照前后哈希一致");console.log(JSON.stringify({menuNegativeDetected:true,productSha256Before:diagnostic.before,productSha256After:after,diagnosticDeleted:true}));}}else for(const width of process.env.G64A_EXTRA_ONLY==="1"?[375,1024]:process.env.G64A_RESULT_PROBE==="1"||process.env.G64A_REPLACEMENT_ONLY==="1"||process.env.G64A_SPACING_NEGATIVE==="1"?[1024]:[375,506,768,1024,1280,1440]) await run(width);

const partial=menuNegative||["G64A_EXTRA_ONLY","G64A_RESULT_PROBE","G64A_RESULTS_ONLY","G64A_REPLACEMENT_ONLY","G64A_SPACING_NEGATIVE"].some(key=>process.env[key]==="1");
if(!partial){
  // 负对照使用新的无配置进程；每次浏览器已关闭后才启动下一轮。
  for(const flag of ["G64A_ANCHOR_NEGATIVE","G64A_MENU_NEGATIVE"]){
    const quote=value=>"'"+value.replaceAll("'","''")+"'";
    const command="$env:"+flag+"='1'\n& "+quote(process.execPath)+" "+quote(join(ROOT,"scripts/verify-g64a.mjs"));
    const child=spawn("powershell.exe",["-NoProfile","-Command",command],{cwd:ROOT,windowsHide:true,stdio:"inherit"});
    const status=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
    assert(status===0,"完整门槛的独立负对照必须通过",{flag,status});
    counts[flag==="G64A_ANCHOR_NEGATIVE"?"negativeG":"negativeMenu"]=1;
  }
  assert(counts.a===7&&counts.h===4&&counts.i>=49&&counts.returnChecks>=61&&counts.iv===6&&counts.v===6&&counts.vi===6&&counts.vii===12&&counts.whole===6&&counts.inputAndPointer===6&&counts.negativeH===1,"完整场景数量门槛",counts);
}
console.log(JSON.stringify({passed:true,scope:partial?"开发分组检查":"a-h 与 i-viii",resultsAcceptance:!partial,counts}));
