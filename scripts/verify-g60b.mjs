import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = "http://127.0.0.1:3462";
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



const DIAGNOSTIC_BREATH_STOPPED = false;
const browserSource = `
${DIAGNOSTIC_BREATH_STOPPED ? `localStorage.setItem("gloss:sample:breathed", "1");` : ""}
window.__g59 = {events: [], hidden: document.hidden, landingBefore: null};
addEventListener('gloss:analytics', e => window.__g59.events.push(e.detail));
addEventListener('visibilitychange', () => { if(document.hidden) window.__g59.hidden = true; });
window.__g59.snapshot = function(selector) {
  if(document.hidden || this.hidden) throw new Error('document.hidden during measurement');
  const scope = document.querySelector(selector);
  if(!scope) throw new Error('Missing original text scope');
  const chars = [];
  for(const span of scope.querySelectorAll('.sentence')) {
    if(getComputedStyle(span).visibility !== 'visible' || span.closest('[inert]')) continue;
    const node = span.firstChild, para = span.closest('[data-para]');
    if(!(node instanceof Text) || !para) throw new Error('Invalid real sentence');
    let local = 0;
    for(const char of node.data) {
      const range = document.createRange(); range.setStart(node, local); range.setEnd(node, local + char.length);
      const rect = range.getBoundingClientRect();
      chars.push({key: para.dataset.para+':'+(Number(span.dataset.offset)+local),
        para: Number(para.dataset.para), offset: Number(span.dataset.offset)+local, index: Number(span.dataset.index),
        char, x: rect.left+scrollX, y: rect.top+scrollY,
        tail: !!span.closest('.reader-tail-line'), lineHeight: parseFloat(getComputedStyle(span).lineHeight)});
      local += char.length;
    }
  }
  return {chars, panels:[...scope.querySelectorAll('.gloss-panel')].map(p=>({index:Number(p.dataset.sentenceIndex),bottom:p.getBoundingClientRect().bottom+scrollY})),
    placeholders:[...scope.querySelectorAll('.reader-tail-placeholder')].map(p=>({text:p.textContent,valid:p.getAttribute('aria-hidden')==='true'&&p.hasAttribute('inert')&&!p.matches('.sentence,[data-index],[data-offset],.sentence-breathe,.sentence-gloss-hover,.sentence-hover')}))};
};
(function watchLanding(){
  const scope=document.querySelector('.landing-demo-visible');
  if(scope && !scope.querySelector('.landing-demo-panel-slot') && scope.querySelectorAll('.sentence').length===4 && !window.__g59.landingBefore)
    window.__g59.landingBefore=window.__g59.snapshot('.landing-demo-visible');
  if(!window.__g59.landingBefore) requestAnimationFrame(watchLanding);
})();`;
const WIDTHS = [375, 506, 768, 1024, 1280];
const MEASURE = process.argv.includes("--measure");
const assert = (ok, label) => { if (!ok) throw new Error(label); };
const evalFn = (cdp, fn, ...args) => cdp.evaluate("(" + fn.toString() + ")(" + args.map(a => JSON.stringify(a)).join(",") + ")");
async function ready(cdp, selector) {
  await waitForValue(() => cdp.evaluate("!!document.querySelector(" + JSON.stringify(selector) + ")"), selector);
  await cdp.evaluate("document.fonts.ready", true);
  await cdp.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))", true);
}
async function click(cdp, selector) {
  if(selector==='.feedback-button'&&await cdp.evaluate("innerWidth<768&&!!document.querySelector('.reader-body-reader')")){
    if(await cdp.evaluate("!!document.querySelector('.feedback-card')"))selector='.reader-typography-aa';
    else {if(!await cdp.evaluate("!!document.querySelector('.reader-typography-sheet')"))await click(cdp,'.reader-typography-aa');
      await cdp.evaluate("document.querySelector('.reader-settings-feedback').scrollIntoView({block:'nearest'})");selector='.reader-settings-feedback';}
  }
  const p = await evalFn(cdp, s => { const r = document.querySelector(s).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }, selector);
  await cdp.call("Input.dispatchMouseEvent", {type:"mousePressed",button:"left",clickCount:1,...p});
  await cdp.call("Input.dispatchMouseEvent", {type:"mouseReleased",button:"left",clickCount:1,...p});
}
function space(page) {
  const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  const text = el => { const r=document.createRange(); r.selectNodeContents(el); return rect(r); };
  if(page==="reader") {
    const back=document.querySelector(".reader-shelf-back"), mode=document.querySelector(".mode-switch"), col=document.querySelector(".col-left");
    const cs=getComputedStyle(col), c=rect(col), b=rect(back), m=rect(mode), buttons=[...mode.querySelectorAll("button")].map(rect);
    return {viewport:document.documentElement.clientWidth,back:b,backText:text(back),mode:m,modeButtons:buttons,modeRightSpace:c.right-parseFloat(cs.paddingRight)-buttons.at(-1).right,body:rect(document.querySelector(".reader-body"))};
  }
  if(page==="shelf") {
    const h=document.querySelector(".shelf-heading .wordmark"), r=document.createRange(); r.selectNode(h.firstChild);
    return {viewport:document.documentElement.clientWidth,heading:rect(document.querySelector(".shelf-heading")),wordmark:rect(h),wordmarkText:rect(r),feedback:rect(document.querySelector('.shelf-heading .feedback-button'))};
  }
  return {header:rect(document.querySelector(".landing-header")),wordmark:rect(document.querySelector(".landing-header .wordmark")),viewport:document.documentElement.clientWidth,primary:rect(document.querySelector(".landing-primary")),secondary:rect(document.querySelector(".landing-secondary")),feedback:rect(document.querySelector(".landing-feedback"))};
}

function buttonBoxes() {
  const button = document.querySelector(innerWidth<768&&document.querySelector(".reader-body-reader")?".reader-settings-feedback":".feedback-button"), b = button.getBoundingClientRect();
  const plain = r => ({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom});
  const intersections = [];
  const overlap = (r, name) => {
    if (r.width > 0 && r.height > 0 && Math.min(b.right,r.right) > Math.max(b.left,r.left) && Math.min(b.bottom,r.bottom) > Math.max(b.top,r.top)) intersections.push({element:name,rect:plain(r)});
  };
  const scope = innerWidth < 768 && button.closest(".reader-typography-sheet") || document.body;
  for (const el of scope.querySelectorAll("*")) {
    if (el === button || button.contains(el)) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility !== "visible" || s.opacity === "0") continue;
    if (el.contains(button)) {
      for (const node of el.childNodes) if (node instanceof Text && node.data.trim()) {
        const range = document.createRange(); range.selectNodeContents(node);
        for (const r of range.getClientRects()) overlap(r,el.tagName+"."+el.className+" direct text");
      }
    } else {
      // Transparent layout containers do not paint a visible frame. Their
      // visible descendants remain independently checked below.
      const ownText=[...el.childNodes].some(node=>node instanceof Text&&node.data.trim());
      const control=el.matches("a,button,input,textarea,select,img,svg,canvas,video");
      const opaque=color=>color!=="transparent"&&color!=="rgba(0, 0, 0, 0)";
      const background=opaque(s.backgroundColor)||s.backgroundImage!=="none";
      const border=["Top","Right","Bottom","Left"].some(side=>parseFloat(s["border"+side+"Width"])>0&&s["border"+side+"Style"]!=="none"&&opaque(s["border"+side+"Color"]));
      if(ownText||control||background||border)overlap(el.getBoundingClientRect(),el.tagName+"."+el.className);
    }
  }
  return {button:plain(b),text:button.closest('.shelf-heading') ? button.getAttribute("aria-label") : button.textContent,clientWidth:document.documentElement.clientWidth,height:innerHeight,intersections};
}
async function originalSnapshot(cdp) {
  return cdp.evaluate("window.__g59.snapshot('.reader-body').chars.filter(c=>c.y>=scrollY&&c.y<scrollY+innerHeight)");
}
async function compareOriginal(cdp, before) {
  const after = new Map((await originalSnapshot(cdp)).map(c=>[c.key,c]));
  for(const c of before) {
    const n=after.get(c.key); assert(n,"original disappeared "+c.key);
    assert(Math.abs(c.x-n.x)<0.5&&Math.abs(c.y-n.y)<0.5,"original drift "+c.key);
  }
}
async function cardBounds(cdp) {
  const v=await evalFn(cdp,()=>{
    const card=document.querySelector(".feedback-card"),r=card.getBoundingClientRect();
    return {label:card.getAttribute("aria-label"),left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:innerHeight,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth};
  });
  assert(v.label==="体验反馈"&&v.left>=0&&v.top>=0&&v.right<=v.client&&v.bottom<=v.height&&v.scroll<=v.client,"card bounds "+JSON.stringify(v));
}
async function key(cdp,name,code,text) {
  await cdp.call("Input.dispatchKeyEvent",{type:"keyDown",key:name,code,...(text?{text}:{})});
  await cdp.call("Input.dispatchKeyEvent",{type:"keyUp",key:name,code});
}
async function checks(cdp,width,page) {
  if(page==='reader'&&width<768){await click(cdp,'.reader-typography-aa');await cdp.evaluate("document.querySelector('.reader-settings-feedback').scrollIntoView({block:'nearest'})");}
  const box=await evalFn(cdp,buttonBoxes);
  assert(box.text==="体验反馈","button label");
  assert(box.button.x>=0&&box.button.y>=0&&box.button.right<=box.clientWidth&&box.button.bottom<=box.height,"button viewport "+JSON.stringify(box));
  assert(box.intersections.length===0,"button overlap "+JSON.stringify({width,page,...box}));
  if(page==="shelf") {
    const shelfFacts=()=>evalFn(cdp,()=>{const h=document.querySelector('.shelf-heading h1'),b=document.querySelector('.feedback-button'),n=document.querySelector('.shelf-count'),r=b.getBoundingClientRect(),a=n.getBoundingClientRect(),header=document.querySelector('.shelf-heading').getBoundingClientRect();return h.textContent==='我的书架'&&getComputedStyle(h).clipPath==='inset(50%)'&&h.getBoundingClientRect().width===1&&r.right===header.right-(innerWidth<768?12:0)&&r.left>=0&&(innerWidth<768||a.right<=r.left);});
    assert(await shelfFacts(),'书架读屏标题与页头按钮');
    await cdp.evaluate("document.querySelector('.shelf-heading h1').style.clipPath='none'");
    assert(!await shelfFacts(),'页头负对照未检出');
    await cdp.evaluate("document.querySelector('.shelf-heading h1').style.removeProperty('clip-path')");
    console.log(JSON.stringify({shelfHeaderNegativeDetected:true,width}));
  }
  if(page==="landing") {
    const read=()=>evalFn(cdp,()=>[...document.querySelectorAll(".landing-primary,.landing-secondary")].map(el=>{const r=el.getBoundingClientRect();return[r.x,r.y,r.width,r.height];}));
    const before=await read();
    await cdp.evaluate("window.feedbackHidden=document.createElement('style');feedbackHidden.textContent='.feedback-entry{display:none!important}';document.head.append(feedbackHidden)");
    const hidden=await read();
    for(let i=0;i<before.length;i++)for(let j=0;j<4;j++)assert(Math.abs(before[i][j]-hidden[i][j])<0.5,"landing main buttons moved");
    await cdp.evaluate("feedbackHidden.remove()");
  }
  if(page==='reader'&&width<768)await click(cdp,'.reader-typography-aa');
  let before;
  if(page==="reader") {
    await evalFn(cdp,()=>document.querySelector('.sentence[data-index="0"]').click());
    await waitForValue(()=>cdp.evaluate("!!document.querySelector('.gloss-panel[data-state=done]')"),"sample gloss");
    await cdp.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",true);
    before=await originalSnapshot(cdp);
  }
  await cdp.evaluate("feedbackEvents=[]");
  await click(cdp,".feedback-button"); await ready(cdp,".feedback-card textarea");
  await cardBounds(cdp);
  if(page==="reader") {
    await cdp.evaluate("document.querySelector('.feedback-card textarea').focus()");
    await cdp.call("Input.insertText",{text:"测试"});
    await key(cdp," ","Space"," "); await key(cdp,"ArrowLeft","ArrowLeft"); await key(cdp,"ArrowRight","ArrowRight"); await key(cdp,"Enter","Enter","\r");
    const draft=await cdp.evaluate("document.querySelector('.feedback-card textarea').value");
    assert(draft==="测试 \n","textarea keyboard "+JSON.stringify(draft));
    await compareOriginal(cdp,before);
    assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===1"),"typing collapsed gloss");
    await click(cdp,".feedback-send");
    await waitForValue(()=>cdp.evaluate("document.querySelector('.feedback-card').textContent.includes('没发出去，可以稍后再试，或加微信 Claraiing')"),"disabled feedback failure");
    assert(await cdp.evaluate("feedbackResponses.length===1&&feedbackResponses[0]===503"),"feedback must return 503");
    assert(await cdp.evaluate("document.querySelector('.feedback-card textarea').value")===draft,"failure lost draft");
    await compareOriginal(cdp,before); await cardBounds(cdp);
  }
  await cdp.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(text!=='Claraiing')throw new Error('wrong account')}}})");
  await click(cdp,".feedback-copy");
  await waitForValue(()=>cdp.evaluate("document.querySelector('.feedback-copy').textContent==='已复制'"),"copy");
  await waitForValue(()=>cdp.evaluate("document.querySelector('.feedback-copy').textContent==='复制'"),"copy reset",3000);
  await cdp.evaluate("navigator.clipboard.writeText=async()=>{throw new Error('denied')}");
  await click(cdp,".feedback-copy");
  assert(await cdp.evaluate("getSelection().toString()==='Claraiing'&&document.querySelector('.feedback-card').textContent.includes('请手动复制')"),"manual copy");
  await cdp.evaluate("getSelection().removeAllRanges()");
  for(const method of ["escape","button","outside"]) {
    if(method!=="escape") { await click(cdp,".feedback-button"); await ready(cdp,".feedback-card"); }
    if(method==="escape") await key(cdp,"Escape","Escape");
    else if(method==="button") await click(cdp,".feedback-button");
    else {
      const point=page==="reader"?await evalFn(cdp,()=>{
        for(const span of document.querySelectorAll('.reader-body .sentence:not([data-index="0"])')) {
          if(getComputedStyle(span).visibility!=="visible")continue;
          const node=span.firstChild;
          if(!(node instanceof Text))continue;
          for(let i=0;i<node.length;i++) {
            const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);
            const r=range.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
            if(x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&document.elementFromPoint(x,y)?.closest(".sentence")===span)return{x,y};
          }
        }
        throw new Error("No visible outside sentence");
      }):{x:1,y:1};
      await cdp.call("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});
      await cdp.call("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});
    }
    await waitForValue(()=>cdp.evaluate("!document.querySelector('.feedback-card')"),"close "+method);
    assert(await cdp.evaluate("document.activeElement===document.querySelector(innerWidth<768&&document.querySelector('.reader-body-reader')?'.reader-typography-aa':'.feedback-button')"),"focus return");
    if(before) {
      await compareOriginal(cdp,before);
      assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===1"),"close affected gloss");
    }
  }
  assert(await cdp.evaluate("feedbackEvents.length===0"),"feedback analytics");
  console.log(JSON.stringify({width,page,button:box.button,overlaps:0,withinViewport:true,keyboard:page==="reader",disabledWrite503:page==="reader",analytics:0}));
}

async function run(width, page) {
  const profile=await mkdtemp(join(tmpdir(),"gloss-g60b-")), port=await freePort();
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
    await cdp.call("Page.addScriptToEvaluateOnNewDocument",{source:browserSource+"window.feedbackEvents=[];window.feedbackResponses=[];addEventListener('gloss:analytics',e=>feedbackEvents.push(e.detail));const originalFetch=window.fetch;window.fetch=async(...args)=>{const r=await originalFetch(...args);if(args[0]==='/api/feedback')feedbackResponses.push(r.status);return r;};"});
    await navigate(cdp,ORIGIN+(page==="reader"?"/read/sample":"/"));
    await ready(cdp,page==="reader"?".reader-shelf-back":".landing-secondary");
    if(page==="shelf") {
      await click(cdp,".landing-secondary"); await ready(cdp,"input[type=file]");
      await evalFn(cdp,()=>{const input=document.querySelector("input[type=file]"), dt=new DataTransfer();dt.items.add(new File(["南郭子綦隐机而坐，仰天而嘘，荅焉似丧其耦。"],"G-60b.txt",{type:"text/plain"}));input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));});
      await waitForValue(()=>cdp.evaluate("location.pathname.startsWith('/read/')&&location.pathname!='/read/sample'"),"txt import");
      await navigate(cdp,ORIGIN+"/"); await ready(cdp,".shelf-heading");
    }
    if(page==='reader')await ready(cdp,'.reader-body');
    console.log(JSON.stringify({width,page,space:await evalFn(cdp,space,page)}));
    if(!MEASURE) await checks(cdp,width,page);
    await assertSinglePage(browser,target.id,"finish:single-page");
  } finally {
    cdp?.close();browser?.close();edge.kill();
    if(edge.exitCode===null)await Promise.race([new Promise(done=>edge.once("exit",done)),sleep(5000)]);
    const p=resolve(profile);
    if(!p.startsWith(resolve(tmpdir(),"gloss-g60b-")))throw new Error("Unexpected profile path");
    await rm(p,{recursive:true,force:true}).catch(e=>console.warn("Profile cleanup: "+e.code));
  }
}
await run(1440,"shelf");
for (const width of WIDTHS) for (const page of (process.argv.includes("--measure-landing") ? ["landing"] : ["reader","shelf","landing"])) await run(width,page);
console.log(MEASURE?"G-60b baseline measurements complete":"G-60b checks passed");
