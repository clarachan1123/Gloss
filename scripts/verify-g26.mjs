import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = "http://127.0.0.1:3463";
const CHROME = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let browserStartedAt = 0;

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
  async call(method, params = {}, label = method) {
    await this.ready;
    const id = ++this.sequence;
    const started = performance.now();
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`Chrome CDP timed out: ${method} [${label}; elapsed=${Math.round(performance.now() - started)}ms; browserAge=${Math.round(performance.now() - browserStartedAt)}ms]`));
      }, 40_000);
      this.pending.set(id, {
        done: (value) => { clearTimeout(timer); done(value); },
        fail: (error) => { clearTimeout(timer); fail(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false, label = "evaluate") {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, label);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function navigate(cdp, url) {
  await cdp.call("Page.navigate", { url }, `navigate:${url}`);
  await waitForValue(() => cdp.evaluate(`location.href.replace(/\\/$/, '') === ${JSON.stringify(url.replace(/\/$/, ""))} && document.readyState === 'complete'`, false, "wait:page-load"), "page load");
}

async function assertSinglePage(browserCdp, testTargetId, label) {
  const { targetInfos } = await browserCdp.call("Target.getTargets", {}, label);
  const pages = targetInfos.filter((info) => info.type === "page");
  if (pages.length !== 1 || pages[0].targetId !== testTargetId) {
    const extraUrls = pages.filter((info) => info.targetId !== testTargetId).map((info) => info.url);
    throw new Error(`${label}: expected only the test page; page count=${pages.length}; extra page URLs=${JSON.stringify(extraUrls)}`);
  }
}




const CLASS = "sentence-saved-collapsed";
const SAVED = [8,10,0];
const assert=(value,label)=>{if(!value)throw new Error(label);};
const evalFn=(cdp,fn,...args)=>cdp.evaluate("("+fn.toString()+")("+args.map(a=>JSON.stringify(a)).join(",")+")");
async function settled(cdp) {
  await cdp.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",true);
  await waitForValue(()=>cdp.evaluate("!document.querySelector('.reader-body')?.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.animationName!=='sample-sentence-breathe')"),"reader transitions");
}
async function readyReader(cdp) {
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.reader-body .sentence')&&!document.querySelector('.reader-body-measuring')&&document.querySelector('.reader-shelf-back')?.style.visibility==='visible'"),"reader ready");
  await cdp.evaluate("document.fonts.ready",true);
  await settled(cdp);
}
async function refresh(cdp) {
  await cdp.call('Page.reload');
  await waitForValue(()=>cdp.evaluate("document.readyState==='complete'&&!!document.querySelector('.mode-switch')"),'refresh');
  await readyReader(cdp);
}
async function mode(cdp,label) {
  await evalFn(cdp,label=>{const button=[...document.querySelectorAll('.mode-option')].find(b=>b.textContent.trim()===label);if(!button)throw Error('Missing mode '+label);button.click();},label);
  await settled(cdp);
}
async function sentence(cdp,index,last=false) {
  await evalFn(cdp,(index,last)=>{const spans=[...document.querySelectorAll('.sentence[data-index="'+index+'"]')];const span=last?spans.at(-1):spans[0];if(!span)throw Error('Missing sentence '+index);span.click();},index,last);
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\""+index+"\"][data-state=done]')"),'complete gloss '+index);
  await settled(cdp);
}
async function retained(cdp,label) {
  const indexes=await evalFn(cdp,()=>[...document.querySelectorAll('.gloss-panel-saved')].map(p=>Number(p.dataset.sentenceIndex)));
  for(const index of SAVED)assert(indexes.includes(index),label+' missing saved '+index+' '+JSON.stringify(indexes));
}
function snapshot() {
  const chars=[];
  for(const span of document.querySelectorAll('.reader-body .sentence')) {
    if(getComputedStyle(span).visibility!=='visible'||span.closest('[inert]'))continue;
    const node=span.firstChild,para=span.closest('[data-para]');
    if(!(node instanceof Text)||!para)throw Error('Invalid sentence text');
    let offset=0;
    for(const char of node.data) {
      const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+char.length);
      const rect=range.getBoundingClientRect();
      chars.push({key:para.dataset.para+':'+(Number(span.dataset.offset)+offset),char,x:rect.left+scrollX,y:rect.top+scrollY});
      offset+=char.length;
    }
  }
  return chars;
}
function compare(before,after,label) {
  assert(before.length===after.length,label+' character count');
  const map=new Map(after.map(c=>[c.key,c]));let max=0;
  for(const c of before){const n=map.get(c.key);assert(n&&n.char===c.char,label+' missing character '+c.key);const delta=Math.max(Math.abs(c.x-n.x),Math.abs(c.y-n.y));max=Math.max(max,delta);assert(delta<0.5,label+' drift '+JSON.stringify({c,n,delta}));}
  return max;
}
function layout(width) {
  const label=document.querySelector('.mode-label'),buttons=[...document.querySelectorAll('.mode-option')],feedback=document.querySelector('.feedback-button'),back=document.querySelector('.reader-shelf-back');
  const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,rects:el.getClientRects().length};};
  const l=box(label),b=buttons.map(box),f=box(feedback),r=box(back),overlap=(a,b)=>Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top);
  if(width>=768){for(const a of [l,...b])if(a.rects!==1)throw Error('Wrapped label/button '+JSON.stringify(a));const all=[l,...b,f,r];for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)if(overlap(all[i],all[j]))throw Error('Sidebar overlap '+JSON.stringify({width,all,i,j}));}
  else {if(Math.max(l.top,...b.map(v=>v.top))-Math.min(l.top,...b.map(v=>v.top))>=2)throw Error('Top bar not one row '+JSON.stringify({width,l,b}));for(const a of [l,...b])if(overlap(a,f))throw Error('Feedback overlap '+JSON.stringify({width,l,b,f}));}
  if(document.documentElement.scrollWidth>document.documentElement.clientWidth)throw Error('Horizontal overflow '+JSON.stringify({width,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,l,b,f}));
  return {width,label:l,buttons:b,feedback:f,back:r,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};
}
async function checks(cdp,width) {
  for(const value of [null,'x','reading','review']) {
    await evalFn(cdp,value=>{if(value===null)localStorage.removeItem('gloss:settings:reading-mode');else localStorage.setItem('gloss:settings:reading-mode',value);},value);
    await refresh(cdp);
    const selected=await evalFn(cdp,()=>document.querySelector('.mode-option[aria-pressed="true"]')?.textContent.trim());
    assert(selected===(value==='reading'?'收起':'显示'),'stored mode '+value+': '+selected);
  }
  await cdp.evaluate("localStorage.removeItem('gloss:settings:reading-mode')");await refresh(cdp);
  for(const index of SAVED) {
    await sentence(cdp,index);
    await evalFn(cdp,index=>{const button=document.querySelector('.gloss-panel[data-sentence-index="'+index+'"] .action-row-save');if(button?.textContent.trim()!=='留下')throw Error('Missing save button '+index);button.click();},index);
    await waitForValue(()=>cdp.evaluate("!!document.querySelector('.gloss-panel-saved[data-sentence-index=\""+index+"\"]')"),'saved '+index);
    await settled(cdp);
    const text=await evalFn(cdp,index=>document.querySelector('.gloss-panel-saved[data-sentence-index="'+index+'"] .action-row-save')?.textContent.trim(),index);
    assert(text==='取消留下','saved action label '+index);
  }
  await sentence(cdp,3);await retained(cdp,'other sentence');
  await cdp.evaluate("document.querySelector('.reader-body').click()");await settled(cdp);await retained(cdp,'blank body');
  await refresh(cdp);await retained(cdp,'refresh');
  await mode(cdp,'收起');
  assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel-saved').length")===0,'collapsed saved panels');
  const decorations=await evalFn(cdp,(indexes,cls)=>indexes.map(index=>({index,pieces:[...document.querySelectorAll('.sentence[data-index="'+index+'"]')].map(span=>({marked:span.classList.contains(cls),style:getComputedStyle(span).textDecorationStyle}))})),SAVED,CLASS);
  for(const sentence of decorations)assert(sentence.pieces.length>0&&sentence.pieces.every(p=>p.marked&&p.style==='dotted'),'collapsed decoration '+JSON.stringify(sentence));
  assert(await cdp.evaluate("document.querySelectorAll('.reader-tail-placeholder."+CLASS+"').length")===0,'placeholder decoration');
  assert(await cdp.evaluate("document.querySelectorAll('.saved-marker').length")===0,'legacy markers');
  const before=await evalFn(cdp,snapshot);
  await evalFn(cdp,cls=>document.querySelectorAll('.'+cls).forEach(span=>span.classList.remove(cls)),CLASS);
  const removed=compare(before,await evalFn(cdp,snapshot),'remove underline');
  await evalFn(cdp,(indexes,cls)=>indexes.forEach(index=>document.querySelectorAll('.sentence[data-index="'+index+'"]').forEach(span=>span.classList.add(cls))),SAVED,CLASS);
  const restored=compare(before,await evalFn(cdp,snapshot),'restore underline');
  for(const last of [false,true]) {
    await sentence(cdp,8);
    await sleep(300); // Separate independent clicks beyond the existing same-sentence debounce.
    await sentence(cdp,10,last);
    assert(await cdp.evaluate("!!document.querySelector('.gloss-panel-saved[data-sentence-index=\"10\"] .action-row-save')"),'saved action on fragment '+last);
    assert(await cdp.evaluate("document.querySelectorAll('.reader-tail-placeholder."+CLASS+"').length")===0,'split placeholder decoration');
    // Establish collapsed state again so each fragment independently opens the saved region.
    await mode(cdp,'显示');await mode(cdp,'收起');
  }
  const boxes=await evalFn(cdp,layout,width);
  console.log(JSON.stringify({width,storedModes:4,savedIndexes:SAVED,maxCharDelta:Math.max(removed,restored),characters:before.length,layout:boxes}));
}
async function run(width) {
  const profile=await mkdtemp(join(tmpdir(),"gloss-g26-")), port=await freePort();
  browserStartedAt=performance.now();
  const edge=spawn(CHROME,["--headless=new","--disable-gpu","--no-sandbox","--remote-debugging-port="+port,"--remote-allow-origins=*","--user-data-dir="+profile,"--no-first-run","--no-default-browser-check","--disable-sync","about:blank"],{stdio:["ignore","ignore","pipe"],windowsHide:true});
  let cdp, browser;
  try {
    const target=await waitForValue(async()=>{const r=await fetch("http://127.0.0.1:"+port+"/json");return(await r.json()).find(t=>t.type==="page");},"Edge CDP");
    const version=await(await fetch("http://127.0.0.1:"+port+"/json/version")).json();
    cdp=new Cdp(target.webSocketDebuggerUrl); browser=new Cdp(version.webSocketDebuggerUrl);
    await cdp.call("Page.enable"); await cdp.call("Runtime.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await assertSinglePage(browser,target.id,"start:single-page");
    await navigate(cdp,ORIGIN+"/read/sample");
    await readyReader(cdp);
    await checks(cdp,width);
    await assertSinglePage(browser,target.id,"finish:single-page");
  } finally {
    cdp?.close();browser?.close();edge.kill();
    if(edge.exitCode===null)await Promise.race([new Promise(done=>edge.once("exit",done)),sleep(5000)]);
    const p=resolve(profile);
    if(!p.startsWith(resolve(tmpdir(),"gloss-g26-")))throw new Error("Unexpected profile path");
    await rm(p,{recursive:true,force:true}).catch(e=>console.warn("Profile cleanup: "+e.code));
  }
}
for (const width of [375,506,768,1024,1280]) await run(width);
console.log("G-26 checks passed");
