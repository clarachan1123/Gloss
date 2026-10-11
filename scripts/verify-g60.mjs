import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = "http://127.0.0.1:3470";
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
const WIDTHS=[375,506,768,1024,1280];
const BASELINE_ONLY=process.argv.includes("--baseline");
const DIAGNOSE_EXPANSION=process.argv.includes("--diagnose-expansion");
const DIAGNOSE_DRIFT=process.argv.includes("--diagnose-drift");
const assert=(value,message)=>{if(!value)throw new Error(message);};
const evalFn=(cdp,fn,...args)=>cdp.evaluate("("+fn.toString()+")("+args.map(a=>JSON.stringify(a)).join(",")+")");
async function settled(cdp){await cdp.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",true);}
async function ready(cdp,selector){await waitForValue(()=>cdp.evaluate("!!document.querySelector("+JSON.stringify(selector)+")"),selector);await cdp.evaluate("document.fonts.ready",true);await settled(cdp);}
async function click(cdp,selector){
 const point=await evalFn(cdp,s=>{const el=document.querySelector(s);if(!el)throw new Error("Missing click target");const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);
 await cdp.call("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});
 await cdp.call("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await settled(cdp);
}
async function measureA(cdp,width){
 const metrics=await evalFn(cdp,()=>{
  const link=document.querySelector(".reader-shelf-back"),row=link.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(link);const homeWidth=range.getBoundingClientRect().width;
  const own=document.createElement("span");own.style.font=getComputedStyle(link).font;own.style.position="fixed";own.textContent="← 回到书架";document.body.append(own);const shelfWidth=own.getBoundingClientRect().width;own.remove();
  let button=document.querySelector(".feedback-button"),probe;
  if(!button){probe=document.createElement("button");probe.textContent="提意见";probe.style.cssText="position:fixed;font:inherit;font-size:14px;line-height:1;padding:0;border:0;background:transparent;white-space:nowrap";document.querySelector(".col-left").append(probe);button=probe;}
  const buttonWidth=button.getBoundingClientRect().width;probe?.remove();
  return{rowWidth:row.width,homeWidth,shelfWidth,remaining:row.width-Math.max(homeWidth,shelfWidth),buttonWidth,fontSize:getComputedStyle(document.querySelector(".mode-option")).fontSize};
 });
 assert(metrics.remaining>=metrics.buttonWidth,"A does not fit at "+width);console.log(JSON.stringify({width,position:"A",...metrics}));
}
function metrics(page){
 const selector=page==="reader"?".col-left,.col-left .wordmark,.reader-shelf-back,.mode-switch,.mode-option,.side-section,.col-main,.reader-body":page==="shelf"?".shelf-heading,.shelf-heading-top,.shelf-heading .wordmark,.shelf-count,.shelf-heading h1,.shelf-heading p,.continue-reading,.shelf":".landing-content,.landing-header,.landing-header .wordmark,.landing-header h1,.landing-subtitle,.landing-actions,.landing-primary,.landing-secondary,.landing-secondary-group small,.landing-demonstration,.landing-demo-footer,.landing-supplement";
 return [...document.querySelectorAll(selector)].map((el,index)=>{
 const r=el.getBoundingClientRect(),result={key:index+":"+el.className,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};
 if(el.matches(".shelf-heading h1")){const range=document.createRange();range.selectNode(el.firstChild);const t=range.getBoundingClientRect();result.titleX=t.x;result.titleY=t.y;result.titleWidth=t.width;result.titleHeight=t.height;}
 return result;});
}
async function landingLayout(cdp,width){
 await waitForValue(()=>cdp.evaluate("document.querySelector('.landing-demo-pointer-settled')&&!document.querySelector('.landing-demonstration').getAnimations({subtree:true}).some(a=>a instanceof CSSTransition&&a.playState==='running')"),"landing CSS transitions complete");
 const before=await evalFn(cdp,()=>{
  const row=document.querySelector(".landing-feedback"),r=row.getBoundingClientRect(),style=getComputedStyle(row),button=row.querySelector(".feedback-button"),b=button.getBoundingClientRect();
  const elements=[...document.querySelectorAll(".landing-content *")].filter(el=>!el.closest(".landing-feedback")).map((el,index)=>{
   const rect=el.getBoundingClientRect();
   return{key:index+":"+el.tagName+"."+el.className,x:rect.x+scrollX,y:rect.y+scrollY,width:rect.width,height:rect.height,below:rect.top>=r.bottom};
  });
  return{elements,row:{text:row.firstChild.textContent,button:button.textContent,visible:getComputedStyle(button).display!=="none"&&b.width>0&&b.height>0,left:r.left,right:r.right,bottom:r.bottom,top:r.top,height:r.height,occupiedHeight:r.height+parseFloat(style.marginTop)+parseFloat(style.marginBottom),buttonRight:b.right,buttonLeft:b.left,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}};
 });
 assert(before.row.text==="测试版，很需要你的意见。"&&before.row.button==="提意见"&&before.row.visible,"landing feedback text/visibility "+width);
 assert(before.row.left>=0&&before.row.right<=before.row.clientWidth&&before.row.buttonRight<=before.row.clientWidth&&before.row.scrollWidth<=before.row.clientWidth,"landing horizontal overflow "+JSON.stringify({width,row:before.row}));
 await cdp.evaluate("window.__g60hidden=document.createElement('style');window.__g60hidden.textContent='.landing-feedback{display:none!important}';document.head.append(window.__g60hidden)");
 await settled(cdp);
 const hidden=await evalFn(cdp,()=>[...document.querySelectorAll(".landing-content *")].filter(el=>!el.closest(".landing-feedback")).map((el,index)=>{const r=el.getBoundingClientRect();return{key:index+":"+el.tagName+"."+el.className,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};}));
 assert(before.elements.length===hidden.length,"landing element count");
 let maxDelta=0,belowCount=0;
 const comparisons=[];
 for(let i=0;i<before.elements.length;i++){
  const element=before.elements[i],control=hidden[i],deltas={};
  assert(element.key===control.key,"landing element mismatch");
  for(const coordinate of ["x","width","height"]){
   const delta=element[coordinate]-control[coordinate];deltas[coordinate]=delta;maxDelta=Math.max(maxDelta,Math.abs(delta));
   assert(Math.abs(delta)<0.5,JSON.stringify({width,page:"landing",element:element.key,coordinate,withFeedback:element[coordinate],hidden:control[coordinate],delta}));
  }
  const deltaY=element.y-control.y,expected=element.below?before.row.occupiedHeight:0;
  if(element.below)belowCount++;
  maxDelta=Math.max(maxDelta,Math.abs(deltaY-expected));deltas.y=deltaY;
  assert(Math.abs(deltaY-expected)<0.5,JSON.stringify({width,page:"landing",element:element.key,coordinate:"y",withFeedback:element.y,hidden:control.y,delta:deltaY,expected}));
  comparisons.push({element:element.key,below:element.below,deltas});
 }
 await cdp.evaluate("window.__g60hidden.remove()");await settled(cdp);
 console.log(JSON.stringify({width,page:"landing",comparison:"CSS display:none new row only",a:true,b:true,c:true,maxDelta,belowCount,row:before.row,elements:comparisons}));
}
async function layout(cdp,width,page){
 if(page==="landing"){await landingLayout(cdp,width);return;}
 const before=await evalFn(cdp,metrics,page);
 await cdp.evaluate("window.__g60hidden=document.createElement('style');window.__g60hidden.textContent='.feedback-entry,.landing-feedback{display:none!important}';document.head.append(window.__g60hidden)");
 await settled(cdp);const hidden=await evalFn(cdp,metrics,page);assert(before.length===hidden.length,"metric count "+page);let maxDelta=0;
 for(let i=0;i<before.length;i++)for(const key of Object.keys(before[i]).filter(k=>k!=="key")){
 const delta=Math.abs(before[i][key]-hidden[i][key]);maxDelta=Math.max(maxDelta,delta);assert(delta<0.5,JSON.stringify({width,page,element:before[i].key,coordinate:key,delta}));}
 await cdp.evaluate("window.__g60hidden.remove()");await settled(cdp);
 const fit=await evalFn(cdp,page=>{
 const b=document.querySelector(".feedback-button"),r=b.getBoundingClientRect(),anchor=document.querySelector(page==="reader"?".reader-shelf-back":page==="shelf"?".shelf-heading h1":".landing-feedback"),a=anchor.getBoundingClientRect();
 const range=document.createRange();range.selectNode(anchor.firstChild);const content=range.getBoundingClientRect();
 return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,anchorTop:a.top,anchorBottom:a.bottom,contentRight:content.right,font:getComputedStyle(b).fontSize};},page);
 assert(fit.left>=fit.contentRight&&fit.top>=fit.anchorTop&&fit.bottom<=fit.anchorBottom,"button placement "+JSON.stringify({width,page,fit}));assert(fit.font==="14px","feedback font");
 console.log(JSON.stringify({width,page,comparison:"CSS display:none",maxDelta,placement:fit}));
}
function driftContext(){
 const active=document.activeElement,card=document.querySelector(".feedback-card");
 const describe=el=>el?{tag:el.tagName,class:el.className}:null;
 const style=card?getComputedStyle(card):null;
 return{activeElement:describe(active),scrollX,scrollY,panel:document.querySelector(".gloss-panel")?.getAttribute("data-state")??null,
 card:card?{position:style.position,offsetParent:describe(card.offsetParent),parent:describe(card.parentElement)}:null};
}
async function cardCheck(cdp,width,page,expanded=false){
 const snapshot=()=>cdp.evaluate("window.__g59.snapshot('.reader-body').chars.filter(c=>c.y>=scrollY&&c.y<scrollY+innerHeight)");
 const before=page==="reader"?await snapshot():null;const beforeContext=await evalFn(cdp,driftContext);await cdp.evaluate("window.__g59.events=[]");await click(cdp,".feedback-button");const openedContext=await evalFn(cdp,driftContext);if(DIAGNOSE_DRIFT)console.log(JSON.stringify({diagnostic:"baseline",width,expanded,timing:expanded?"after sentence click, data-state done and two animation frames; before feedback click":"before sentence expansion",beforeContext,openedContext}));
 assert(await cdp.evaluate("document.querySelector('.feedback-button').getAttribute('aria-expanded')==='true'"),"expanded aria");
 const card=await evalFn(cdp,()=>{
 const el=document.querySelector(".feedback-card");if(!el||el.getAttribute("role")!=="dialog"||el.getAttribute("aria-label")!=="提意见")throw new Error("dialog semantics");
 const r=el.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight};});
 assert(card.left>=0&&card.top>=0&&card.right<=card.clientWidth&&card.bottom<=card.height&&card.width<=Math.min(320,width-32)&&card.scrollWidth<=card.clientWidth,"card bounds "+JSON.stringify({width,page,card}));
 let maxCharDelta=0;
 const unchanged=async()=>{
 if(!before)return;const after=new Map((await snapshot()).map(c=>[c.key,c]));
 for(const c of before){const n=after.get(c.key);assert(n,"original disappeared "+c.key);for(const key of ["x","y"]){const d=Math.abs(n[key]-c[key]);maxCharDelta=Math.max(maxCharDelta,d);if(d>=0.5){
 const original=await cdp.evaluate("window.__g60beforeExpansion??null");
 let tailRange=null;
 if(original){
  const own=original.chars.filter(c=>c.index===0),last=[...own].reverse().find(c=>c.char.trim()),end=last.offset+last.char.length;
  const next=original.chars.find(c=>c.para===last.para&&c.offset>=end&&c.char.trim()&&c.y>last.y+last.lineHeight/2);
  const paraEnd=Math.max(...original.chars.filter(c=>c.para===last.para).map(c=>c.offset+c.char.length));
  tailRange={para:last.para,start:end,end:next?.offset??paraEnd,contains:c.para===last.para&&c.offset>=end&&c.offset<(next?.offset??paraEnd)};
 }
 console.log(JSON.stringify({diagnostic:"drift",width,expanded,key,d,char:c.char,sentenceIndex:c.index,offset:c.offset,before:{x:c.x,y:c.y,tail:c.tail},after:{x:n.x,y:n.y,tail:n.tail},tailRange,beforeContext,openedContext,currentContext:await evalFn(cdp,driftContext)}));
}assert(d<0.5,"original drift "+JSON.stringify({width,key,d}));}}};
 await unchanged();
 await cdp.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(text!=='Claraiing')throw new Error('wrong account');window.__g60copied=text;}}})");
 await click(cdp,".feedback-copy");await waitForValue(()=>cdp.evaluate("document.querySelector('.feedback-copy')?.textContent==='已复制'"),"copied");
 assert(await cdp.evaluate("window.__g60copied==='Claraiing'"),"clipboard argument");await unchanged();if(expanded)assert(await cdp.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\"0\"]')"),"copy collapsed gloss");
 await waitForValue(()=>cdp.evaluate("document.querySelector('.feedback-copy')?.textContent==='复制微信号'"),"copy reset",3000);
 await cdp.evaluate("navigator.clipboard.writeText=async()=>{throw new Error('denied')}");
 await click(cdp,".feedback-copy");
 assert(await cdp.evaluate("getSelection().toString()==='Claraiing'&&document.querySelector('.feedback-card [role=status]')?.textContent==='请手动复制'"),"copy fallback");
 await cdp.evaluate("getSelection().removeAllRanges()");await unchanged();
 for(const method of ["escape","button","outside"]){
 if(method!=="escape")await click(cdp,".feedback-button");
 if(method==="escape"){await cdp.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});}
 else if(method==="button")await click(cdp,".feedback-button");
 else{
 const point=page==="reader"?await evalFn(cdp,()=>{
  for(const span of document.querySelectorAll('.reader-body .sentence:not([data-index="0"])')){
   if(getComputedStyle(span).visibility!=="visible"||span.closest("[inert]"))continue;
   const node=span.firstChild;
   for(let offset=0;offset<node.length;offset++){
    const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);const r=range.getBoundingClientRect(),point={x:r.left+r.width/2,y:r.top+r.height/2};
    if(point.x<0||point.y<0||point.x>=innerWidth||point.y>=innerHeight)continue;
    const hit=document.elementFromPoint(point.x,point.y);
    if(hit?.closest(".sentence")!==span)continue;
    return {...point,index:Number(span.dataset.index),hit:{tag:hit.tagName,class:hit.className}};
   }
  }
  throw new Error("outside close must hit a visible original sentence");
 }):{x:1,y:1};
 console.log(JSON.stringify({width,page,outsideClose:point}));
 await cdp.call("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:point.x,y:point.y});
 await cdp.call("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:point.x,y:point.y});
}
 await settled(cdp);
 assert(await cdp.evaluate("!document.querySelector('.feedback-card')&&document.querySelector('.feedback-button').getAttribute('aria-expanded')==='false'&&document.activeElement===document.querySelector('.feedback-button')"),"close "+method);
 if(page==="reader")assert(await cdp.evaluate(expanded?"document.querySelectorAll('.gloss-panel').length===1&&!!document.querySelector('.gloss-panel[data-sentence-index=\"0\"]')":"!document.querySelector('.gloss-panel')"),"gloss changed "+method);
 await unchanged();}
 if(page==="reader")assert(await cdp.evaluate("window.__g59.events.length===0"),"feedback emitted analytics");
 console.log(JSON.stringify({width,page,expanded,cardWithinViewport:true,copySuccess:true,copyFailure:true,closeMethods:3,maxCharDelta,feedbackAnalytics:page==="reader"?0:null}));
}
async function diagnoseExpansion(cdp,width){
 const selector='.sentence[data-index="0"]';
 const waitingSelector='.gloss-panel[data-state=done]';
 const clickInfo=await evalFn(cdp,s=>{
  const el=document.querySelector(s),r=el.getBoundingClientRect(),point={x:r.left+r.width/2,y:r.top+r.height/2};
  const hit=document.elementFromPoint(point.x,point.y);
  return {method:"Input.dispatchMouseEvent (bounding box center)",requestedIndex:0,selector:s,point,hit:hit?{tag:hit.tagName,class:hit.className,index:hit.getAttribute("data-index")}:null};
 },selector);
 console.log(JSON.stringify({diagnostic:"click",width,...clickInfo,waitingSelector,waitingState:"done",timeoutMs:15000}));
 await click(cdp,selector);
 const started=Date.now();
 for(let step=0;step<=20;step++){
  const remaining=started+step*500-Date.now();if(remaining>0)await sleep(remaining);
  const state=await evalFn(cdp,index=>{
   const p=document.querySelector('.gloss-panel[data-sentence-index="'+index+'"]');
   return {requestedPanel:!!p,state:p?.getAttribute("data-state")??null,textLength:p?.querySelector(".gloss-panel-text")?.textContent.length??0,
    allPanels:[...document.querySelectorAll(".gloss-panel")].map(p=>({index:p.getAttribute("data-sentence-index"),state:p.getAttribute("data-state"),textLength:p.querySelector(".gloss-panel-text")?.textContent.length??0}))};
  },0);
  console.log(JSON.stringify({diagnostic:"sample",width,sampleMs:step*500,actualMs:Date.now()-started,...state}));
 }
}
async function run(width,page){
 const profile=await mkdtemp(join(tmpdir(),"gloss-g60-")),port=await freePort();browserStartedAt=performance.now();
 const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--no-sandbox","--remote-debugging-port="+port,"--remote-allow-origins=*","--user-data-dir="+profile,"--no-first-run","--no-default-browser-check","--disable-sync","about:blank"],{stdio:["ignore","ignore","pipe"],windowsHide:true});
 let cdp,browserCdp;
 try{
 const target=await waitForValue(async()=>{const r=await fetch("http://127.0.0.1:"+port+"/json");return(await r.json()).find(t=>t.type==="page");},"Edge CDP");
 const version=await(await fetch("http://127.0.0.1:"+port+"/json/version")).json();cdp=new Cdp(target.webSocketDebuggerUrl);browserCdp=new Cdp(version.webSocketDebuggerUrl);
 await cdp.call("Page.enable");await cdp.call("Runtime.enable");await cdp.call("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
 await cdp.call("Page.addScriptToEvaluateOnNewDocument",{source:browserSource});await assertSinglePage(browserCdp,target.id,"start:single-page");
 if(page==="reader"){
 await navigate(cdp,ORIGIN+"/read/sample");await ready(cdp,".reader-body .sentence");await measureA(cdp,width);
 if(!BASELINE_ONLY){await layout(cdp,width,page);await cardCheck(cdp,width,page);if(DIAGNOSE_EXPANSION){await diagnoseExpansion(cdp,width);await assertSinglePage(browserCdp,target.id,"diagnostic:single-page");return;}await cdp.evaluate("window.__g60beforeExpansion=window.__g59.snapshot('.reader-body')");await evalFn(cdp,()=>document.querySelector('.sentence[data-index="0"]').click());await waitForValue(()=>cdp.evaluate("!!document.querySelector('.gloss-panel[data-state=done]')"),"sample gloss");await settled(cdp);await cardCheck(cdp,width,page,true);}
 }else{
 await navigate(cdp,ORIGIN+"/");await ready(cdp,".landing-secondary");
 if(page==="shelf"){
 await click(cdp,".landing-secondary");await ready(cdp,"textarea");
 await cdp.evaluate("(()=>{const t=document.querySelector('textarea');t.value='南郭子綦隐机而坐，仰天而嘘，荅焉似丧其耦。';[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='使用粘贴的文本').click();})()");
 await waitForValue(()=>cdp.evaluate("location.pathname.startsWith('/read/')&&location.pathname!='/read/sample'"),"paste imported");await navigate(cdp,ORIGIN+"/");await ready(cdp,".shelf-heading");
 }else await waitForValue(()=>cdp.evaluate("!!document.querySelector('.landing-demo-pointer-settled')"),"landing settled",15000);
 if(!BASELINE_ONLY){await layout(cdp,width,page);if(page==="landing"){await evalFn(cdp,()=>document.querySelector(".feedback-button").scrollIntoView({block:"center",behavior:"instant"}));await settled(cdp);}await cardCheck(cdp,width,page);}
 }await assertSinglePage(browserCdp,target.id,"finish:single-page");
 }finally{
 cdp?.close();browserCdp?.close();chrome.kill();if(chrome.exitCode===null)await Promise.race([new Promise(done=>chrome.once("exit",done)),sleep(5000)]);
 const resolved=resolve(profile);if(!resolved.startsWith(resolve(tmpdir(),"gloss-g60-")))throw new Error("Unexpected profile path");
 await rm(resolved,{recursive:true,force:true}).catch(error=>console.warn("Profile cleanup: "+error.code));}
}
for(const width of DIAGNOSE_DRIFT?[375]:DIAGNOSE_EXPANSION?[375,768]:WIDTHS)for(const page of BASELINE_ONLY||DIAGNOSE_EXPANSION||DIAGNOSE_DRIFT?["reader"]:["reader","shelf","landing"])await run(width,page);
console.log(DIAGNOSE_EXPANSION?"G-60 expansion diagnostics complete":BASELINE_ONLY?"G-60 baseline measurements complete (acceptance checks not run)":"G-60 checks passed");
