/**
 * Replays G-46 against `npm run dev:slow-gloss` after the invalid-key / HTTP 401 preflight.
 * Uses the real IntersectionObserver. The local mock supplies the 148-character slow gloss.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    } catch(error) { if(error.message?.includes("page hidden")||error.message?.includes("extra page"))throw error; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.activeGlossRequests = new Set();
    this.pageHidden=false;
    this.visibleScenarioUrl=null;
    this.onPageHidden=null;
    this.pending = new Map();
    this.ready = new Promise((done, fail) => { this.socket.onopen = done; this.socket.onerror = fail; });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if(message.method==="Runtime.bindingCalled"&&message.params.name==="__g46pageHidden") {
        const detail=JSON.parse(message.params.payload);
        // Navigation hides the outgoing document; monitor the current scenario document.
        if(detail.url===this.visibleScenarioUrl) {
          this.pageHidden=true;
          this.onPageHidden?.();
        }
      }
      if (message.method === "Network.requestWillBeSent" && message.params.request.url.includes("/api/gloss"))
        this.activeGlossRequests.add(message.params.requestId);
      if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed")
        this.activeGlossRequests.delete(message.params.requestId);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.fail(new Error(message.error.message)) : pending.done(message.result);
    };
  }
  async call(method, params = {}, allowHidden = false) {
    if(this.pageHidden&&!allowHidden)throw new Error("page hidden");
    await this.ready;
    const id = ++this.nextId;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 40000);
      this.pending.set(id, { done: value => { clearTimeout(timer); done(value); }, fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false, allowHidden = false) {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, allowHidden);
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

async function assertSinglePage(port, targetId) {
  const targets=await (await fetch("http://127.0.0.1:"+port+"/json")).json();
  const pages=targets.filter(target=>target.type==="page");
  if(pages.length!==1||pages[0].id!==targetId)throw new Error("extra page: "+JSON.stringify(pages.map(page=>({id:page.id,url:page.url}))));
}

async function runVisibleScenario(cdp, port, targetId, scenarioUrl, run) {
  await assertSinglePage(port,targetId);
  if(cdp.pageHidden||await cdp.evaluate("document.visibilityState==='hidden'"))throw new Error("page hidden");
  cdp.visibleScenarioUrl=scenarioUrl;
  let rejectHidden;
  const hidden=new Promise((resolve,reject)=>{rejectHidden=reject;});
  cdp.onPageHidden=()=>{console.error("page hidden");rejectHidden(new Error("page hidden"));};
  try { await Promise.race([run(),hidden]); }
  finally { cdp.onPageHidden=null;cdp.visibleScenarioUrl=null; }
}

const visibilityGuard = String.raw`addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden') {
    window.__g46record?.('page-hidden');
    window.__g46pageHidden(JSON.stringify({url:location.href}));
  }
});`;

const instrumentation = `(() => {
  window.__g46 = {observed:0,disconnected:0,glossAborts:0};
  const NativeObserver = window.IntersectionObserver;
  window.IntersectionObserver = class extends NativeObserver {
    observe(target) { if (target.matches?.('[data-reader-block], .gloss-panel')) window.__g46.observed++; return super.observe(target); }
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

const failureRecording = String.raw`(() => {
  window.__g46timeline = [];
  window.__g46index = 0;
  window.__g46requestAborts = [];
  window.__g46requestOrdinal = 0;
  window.__g46record = (kind, details = {}) => {
    const source = document.querySelector('.sentence[data-index="' + window.__g46index + '"]');
    window.__g46timeline.push({time:performance.now(),kind,index:window.__g46index,scrollY,
      sentenceRect:source?.getBoundingClientRect().toJSON()??null,...details});
  };
  const record = window.__g46record;
  for(const name of ['scrollTo','scrollBy']) {
    const native = window[name];
    window[name] = function(...args) {
      record(name,{args,stack:new Error().stack.split('\n').slice(0,4)});
      return native.apply(this,args);
    };
  }
  const nativeIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function(...args) {
    record('scrollIntoView',{args,calledIndex:this.dataset.index??null,stack:new Error().stack.split('\n').slice(0,4)});
    return nativeIntoView.apply(this,args);
  };
  addEventListener('scroll',()=>record('scroll-event'));
  record('fonts-initial',{status:document.fonts.status});
  document.fonts.addEventListener('loadingdone',()=>record('fonts-loadingdone',{status:document.fonts.status}));
  const NativeObserver = window.IntersectionObserver;
  let observerSerial = 0;
  const targetDetails = target => ({
    target:target.matches('.gloss-panel')?'panel':target.matches('[data-reader-block]')?'source-block':'other',
    para:target.dataset.para??null,sentenceIndex:target.dataset.sentenceIndex??null,
    dataIndex:target.dataset.index??target.querySelector('.sentence')?.dataset.index??null
  });
  window.IntersectionObserver = class extends NativeObserver {
    constructor(callback,options) {
      const observerId = ++observerSerial;
      record('observer-construct',{observerId,options:options??null});
      super((entries,observer)=>{
        for(const entry of entries) record('intersection',{
          observerId,...targetDetails(entry.target),isIntersecting:entry.isIntersecting,
          targetRect:entry.target.getBoundingClientRect().toJSON()});
        callback(entries,observer);
      },options);
      this.g46ObserverId = observerId;
    }
    observe(target) { record('observer-observe',{observerId:this.g46ObserverId,...targetDetails(target)});return super.observe(target); }
    unobserve(target) { record('observer-unobserve',{observerId:this.g46ObserverId,...targetDetails(target)});return super.unobserve(target); }
    disconnect() { record('observer-disconnect',{observerId:this.g46ObserverId});return super.disconnect(); }
  };
  let measuringObserver = null;
  const watchMeasuring = () => {
    const body=document.querySelector('.reader-body');
    if(!body||measuringObserver)return;
    record('measuring-initial',{value:body.getAttribute('data-measuring')});
    measuringObserver = new MutationObserver(records=>{
      for(let i=0;i<records.length;i++)record('measuring-change',{
        value:i+1<records.length?records[i+1].oldValue:body.getAttribute('data-measuring'),
        oldValue:records[i].oldValue});
    });
    measuringObserver.observe(body,{attributes:true,attributeFilter:['data-measuring'],attributeOldValue:true});
    appearanceObserver.disconnect();
  };
  const appearanceObserver = new MutationObserver(watchMeasuring);
  appearanceObserver.observe(document,{childList:true,subtree:true});
  watchMeasuring();
  window.__g46probe = async () => {
    record('probe-a',{visibilityState:document.visibilityState,hasFocus:document.hasFocus(),
      measuring:document.querySelector('.reader-body')?.getAttribute('data-measuring')??null});
    const frame = await new Promise(resolve=>{
      const started=performance.now();let raf;
      const timer=setTimeout(()=>{cancelAnimationFrame(raf);resolve({executed:false,elapsed:performance.now()-started});},500);
      raf=requestAnimationFrame(()=>{clearTimeout(timer);const elapsed=performance.now()-started;resolve({executed:elapsed<=500,elapsed});});
    });
    record('probe-b',frame);
    const scrollResult = await new Promise(resolve=>{
      const started=performance.now();
      const finish=received=>{clearTimeout(timer);removeEventListener('scroll',onScroll);const elapsed=performance.now()-started;resolve({received:received&&elapsed<=500,elapsed});};
      const onScroll=()=>finish(true),timer=setTimeout(()=>finish(false),500);
      addEventListener('scroll',onScroll);window.scrollBy(0,1);
    });
    record('probe-c',scrollResult);
    const source=document.querySelector('.sentence[data-index="'+window.__g46index+'"]');
    const para=source?.closest('[data-para]')?.dataset.para??'0';
    const targets=[...document.querySelectorAll('[data-reader-block][data-para="'+para+'"]'),
      ...[...document.querySelectorAll('.gloss-panel')].filter(p=>document.querySelector('.sentence[data-index="'+p.dataset.sentenceIndex+'"]')?.closest('[data-para]')?.dataset.para===para)];
    const targetsGeometry=targets.map(target=>({ ...targetDetails(target),
      rect:target.getBoundingClientRect().toJSON(),visibility:getComputedStyle(target).visibility,
      height:getComputedStyle(target).height}));
    const entries=[],observationStarted=performance.now();
    const fresh=new IntersectionObserver(values=>{
      for(const entry of values)entries.push({...targetDetails(entry.target),isIntersecting:entry.isIntersecting,receivedMs:performance.now()-observationStarted,
        top:entry.boundingClientRect.top,bottom:entry.boundingClientRect.bottom});
    });
    for(const target of targets)fresh.observe(target);
    await new Promise(resolve=>setTimeout(resolve,500));
    fresh.disconnect();
    record('probe-d',{entries:entries.filter(entry=>entry.receivedMs<=500),lateEntries:entries.filter(entry=>entry.receivedMs>500),targets:targetsGeometry});
  };
  const originalFetch = window.fetch;
  window.fetch = function(input,init) {
    const url = typeof input === 'string'?input:input?.url??'';
    if(url.includes('/api/gloss')) {
      const ordinal = ++window.__g46requestOrdinal;
      (init?.signal??input?.signal)?.addEventListener('abort',()=>{
        window.__g46requestAborts.push(ordinal);record('gloss-signal-abort',{ordinal});
      });
    }
    return originalFetch.apply(this,arguments);
  };
  addEventListener('gloss:analytics',event=>{
    if(event.detail.event==='gloss_dismiss_early') window.__g46.dismisses=(window.__g46.dismisses??0)+1;
  });
})();`;

async function clickSource(cdp,index) {
  await cdp.evaluate("window.__g46index="+index+";window.__g46record('script-scrollIntoView-before');document.querySelector('.sentence[data-index=\""+index+"\"]').scrollIntoView({block:'center',behavior:'instant'});window.__g46record('script-scrollIntoView-after');");
  await cdp.evaluate("window.__g46record('script-click-before');document.querySelector('.sentence[data-index=\""+index+"\"]').click();window.__g46record('script-click-after');");
}
async function targetCount(cdp,index) {
  return cdp.evaluate("(()=>{const para=document.querySelector('.sentence[data-index=\""+index+"\"]').closest('[data-para]').dataset.para;return document.querySelectorAll('[data-reader-block][data-para=\"'+para+'\"]').length+[...document.querySelectorAll('.gloss-panel')].filter(p=>document.querySelector('.sentence[data-index=\"'+p.dataset.sentenceIndex+'\"]').closest('[data-para]').dataset.para===para).length;})()");
}

async function waitForInitialPosition(cdp) {
  // At the initial top position scrollToSentence intentionally makes no native scroll call.
  await cdp.evaluate("document.fonts.ready", true);
  await waitFor(() => cdp.evaluate("(() => {const now=performance.now();const prior=window.__g46initialPositionWait;if(!prior||prior.y!==scrollY){window.__g46initialPositionWait={y:scrollY,since:now};return false;}if(now-prior.since<500)return false;window.__g46record('initial-position-ready',{condition:'document.fonts.ready then scrollY stable 500ms',stableMs:now-prior.since});return true;})()"), "fonts ready and 500ms stable scrollY");
}

async function openSentence(cdp, id, index) {
  await navigate(cdp, `${ORIGIN}/read/${id}`);
  if(await cdp.evaluate("document.visibilityState==='hidden'"))throw new Error("page hidden");
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.sentence[data-index="${index}"]')`), "sentence");
  await waitForInitialPosition(cdp);
  await clickSource(cdp,index);
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
    const para=source.closest('[data-para]').dataset.para;
    const targets=[...document.querySelectorAll('[data-reader-block][data-para="'+para+'"]'),
      ...[...document.querySelectorAll('.gloss-panel')].filter(p=>document.querySelector('.sentence[data-index="'+p.dataset.sentenceIndex+'"]').closest('[data-para]').dataset.para===para)];
    const bounds=()=>targets.map(t=>({kind:t.matches('.gloss-panel')?'panel':'body',index:t.dataset.sentenceIndex??t.querySelector('.sentence')?.dataset.index??null,bottom:t.getBoundingClientRect().bottom}));
    const lastBottom=()=>Math.max(...bounds().map(t=>t.bottom));
    const targetBoundsBefore=bounds();
    if (${JSON.stringify(direction)}==='source-out') window.scrollBy({top:source.getBoundingClientRect().bottom+15,behavior:'instant'});
    else if (${JSON.stringify(direction)}==='edge') window.scrollBy({top:lastBottom()-1,behavior:'instant'});
    else if (${JSON.stringify(direction)}==='panel-out') window.scrollBy({top:panel.getBoundingClientRect().bottom+20,behavior:'instant'});
    else if (${JSON.stringify(direction)}==='down') window.scrollBy({top:Math.max(...targetBoundsBefore.map(t=>t.bottom))+20,behavior:'instant'});
    else window.scrollTo({top:0,behavior:'instant'});
    const s=source.getBoundingClientRect(), p=panel.getBoundingClientRect();
    return {targetBoundsBefore,targetBoundsAfter:bounds(),lastBottom:lastBottom(),sourceTop:s.top,sourceBottom:s.bottom,panelTop:p.top,panelBottom:p.bottom,shown:panel.querySelector('.gloss-panel-text')?.textContent?.length ?? 0,state:panel.dataset.state};
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
  const expectedTargets = await targetCount(cdp,index);
  const direction = name === "busy-last-fragment" ? "edge" : name.endsWith("visible") ? "source-out" : name.endsWith("up") ? "up" : "down";
  if (name === "busy-down") {
    const intermediateGeometry = await scroll(cdp, index, "panel-out");
    await sleep(100);
    const intermediate = await cdp.evaluate(`(() => {
      const source=document.querySelector('.sentence[data-index="${index}"]'),para=source.closest('[data-para]').dataset.para;
      const continuation=[...document.querySelectorAll('.reader-para-cont[data-para="'+para+'"]')];
      return {continuationBottom:Math.max(...continuation.map(p=>p.getBoundingClientRect().bottom)),
        panel:!!document.querySelector('.gloss-panel[data-sentence-index="${index}"]'),...window.__g46};
    })()`);
    if (!(intermediate.continuationBottom > 0) || !intermediate.panel || intermediate.glossAborts !== before.glossAborts)
      throw new Error(name + ": visible continuation must retain panel and request: " + JSON.stringify(intermediate));
    console.log(JSON.stringify({scenario:name,stage:"panel-out-continuation-visible",geometry:intermediateGeometry,after:intermediate}));
  }
  const geometry = await scroll(cdp, index, direction);
  if (direction === "edge") {
    if (!(geometry.lastBottom > 0 && geometry.lastBottom <= 1.5 && geometry.sourceBottom < 0)) throw new Error(`${name}: expected one visible pixel: ${JSON.stringify(geometry)}`);
    await sleep(100);
    const visible = await cdp.evaluate(`({panel:!!document.querySelector('.gloss-panel[data-sentence-index="${index}"]'),...window.__g46})`);
    if (!visible.panel || visible.glossAborts !== before.glossAborts) throw new Error(`${name}: one visible pixel did not keep panel open`);
    const gone = await scroll(cdp, index, "down");
    await waitFor(() => cdp.evaluate(`!document.querySelector('.gloss-panel[data-sentence-index="${index}"]')`), "collapse after last pixel leaves");
    const after = await cdp.evaluate("({...window.__g46})");
    if (after.glossAborts !== before.glossAborts + 1 || after.observed !== expectedTargets || after.disconnected !== 1) throw new Error(`${name}: incorrect abort or observer lifecycle`);
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
    if (!after.panel || after.glossAborts !== before.glossAborts || after.observed !== expectedTargets || after.disconnected !== before.disconnected) throw new Error(`${name}: panel closed, gloss aborted, or observer rebuilt while visible`);
    console.log(JSON.stringify({scenario:name,geometry,after}));
    return;
  }
  if (direction === "down" && geometry.lastBottom > 0) throw new Error(`${name}: panel remains visible`);
  if (direction === "up" && geometry.sourceTop < 720) throw new Error(`${name}: source remains visible: ${JSON.stringify(geometry)}`);
  const anchor = direction === "down" ? await cdp.evaluate(`(() => {const el=[...document.querySelectorAll('.sentence')].find(e=>{const r=e.getBoundingClientRect();return r.top>=0 && r.top<innerHeight});return el?{index:el.dataset.index,top:el.getBoundingClientRect().top}:null;})()`) : null;
  await waitFor(() => cdp.evaluate(`!document.querySelector('.gloss-panel[data-sentence-index="${index}"]')`), `${name} auto-collapse`);
  const after = await cdp.evaluate("({...window.__g46})");
  if (name.startsWith("busy") && after.glossAborts !== before.glossAborts + 1) throw new Error(`${name}: streaming gloss was not aborted exactly once`);
  if (after.observed !== expectedTargets || after.disconnected !== 1) throw new Error(`${name}: observer registration/disconnection mismatch`);
  let anchorDelta = null;
  if (anchor) {
    const top = await cdp.evaluate(`document.querySelector('.sentence[data-index="${anchor.index}"]')?.getBoundingClientRect().top ?? null`);
    anchorDelta = top === null ? null : top - anchor.top;
    if (anchorDelta === null || Math.abs(anchorDelta) > 0.5) throw new Error(`${name}: visible sentence moved ${anchorDelta}px`);
  }
  console.log(JSON.stringify({scenario:name,geometry,after,anchorDelta}));
}

async function runConcurrent(cdp) {
  const id="g46-concurrent";
  await cdp.evaluate("localStorage.setItem('gloss:doc:"+id+"',"+JSON.stringify(JSON.stringify(fixture(id)))+")");
  await openSentence(cdp,id,0);
  await waitFor(()=>Promise.resolve(cdp.activeGlossRequests.size===1),"first network request");
  await clickSource(cdp,1);
  await waitFor(()=>Promise.resolve(cdp.activeGlossRequests.size===2),"two concurrent network requests");
  const before=await cdp.evaluate("({...window.__g46})");
  if(before.glossAborts!==0 || (before.dismisses??0)!==0) throw Error("concurrent: premature abort/dismiss");
  await ready(cdp,0,"busy");
  await ready(cdp,1,"busy");
  const geometry=await scroll(cdp,1,"edge");
  await sleep(100);
  if(!await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===2&&window.__g46.glossAborts===0")) throw Error("concurrent: last fragment visible must retain both");
  await scroll(cdp,1,"down");
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.gloss-panel').length===0"),"concurrent paragraph collapse");
  const after=await cdp.evaluate("({...window.__g46,requestAborts:window.__g46requestAborts})");
  if(after.glossAborts!==2 || new Set(after.requestAborts).size!==2 || (after.dismisses??0)!==0)
    throw Error("concurrent: each request must abort once and dismiss must remain zero");
  console.log(JSON.stringify({scenario:"concurrent",networkConcurrent:2,geometry,after}));
}

function classifyFailure(records, viewportHeight) {
  const a=records.findLast(r=>r.kind==="probe-a"),b=records.findLast(r=>r.kind==="probe-b");
  const c=records.findLast(r=>r.kind==="probe-c"),d=records.findLast(r=>r.kind==="probe-d");
  if(a?.measuring==="false"&&(b?.executed===false||c?.received===false))return "R";
  if(a?.measuring==="true")return "P";
  const prior=records.filter(r=>!a||r.time<a.time);
  const click=prior.findLast(r=>r.kind==="script-click-before");
  const scroll=prior.find(r=>r.time>(click?.time??Infinity)&&["scrollTo","scrollBy","scrollIntoView"].includes(r.kind)&&r.stack?.slice(2).some(line=>line.includes("<anonymous>")));
  const paragraph=String(Math.floor((a?.index??click?.index??0)/2));
  const observes=prior.filter(r=>r.kind==="observer-observe"&&
    (r.target==="source-block"&&r.para===paragraph||r.target==="panel"&&Math.floor(Number(r.sentenceIndex)/2)===Number(paragraph)));
  const ids=new Set(observes.map(r=>r.observerId));
  if(scroll&&prior.some(r=>r.kind==="observer-disconnect"&&ids.has(r.observerId)&&r.time<scroll.time&&!observes.some(next=>next.time>r.time)))return "P";
  if(d?.entries.some(entry=>{
    if(!entry.isIntersecting)return false;
    const target=d.targets.find(t=>t.target===entry.target&&t.para===entry.para&&t.dataIndex===entry.dataIndex&&t.sentenceIndex===entry.sentenceIndex);
    return target&&(target.rect.height===0||parseFloat(target.height)===0||target.visibility==="hidden"||target.rect.bottom<=0||target.rect.top>=viewportHeight);
  }))return "T";
  return "其他";
}

const profile = await mkdtemp(join(tmpdir(), "gloss-g46-"));
const server = createServer();
await new Promise(done => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise(done => server.close(done));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "about:blank"], { stdio: "ignore", windowsHide: true });
let cdp;
let currentScenario="startup",failureClassification=null,failureError=null;
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === "page"), "CDP target");
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await assertSinglePage(port,target.id);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Runtime.addBinding",{name:"__g46pageHidden"});
  await cdp.call("Network.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width:1280, height:720, deviceScaleFactor:1, mobile:false });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source:instrumentation + failureRecording + visibilityGuard });
  await navigate(cdp, ORIGIN);
  const cases = ["busy-visible", "done-visible", "busy-last-fragment", "busy-down", "done-down", "busy-up", "explain-visible"];
  for (const name of cases) {
    const id = `g46-${name}`;
    await cdp.evaluate(`localStorage.setItem('gloss:doc:${id}',${JSON.stringify(JSON.stringify(fixture(id)))})`);
  }
  for (const name of cases.filter(name => !process.env.G46_SCENARIO || process.env.G46_SCENARIO === name)) {
    currentScenario=name;
    await runVisibleScenario(cdp,port,target.id,ORIGIN+"/read/g46-"+name,()=>runCase(cdp, `g46-${name}`, name, name === "busy-up" ? 100 : 0));
  }
  if (!process.env.G46_SCENARIO || process.env.G46_SCENARIO === "concurrent") {
    currentScenario="concurrent";
    await runVisibleScenario(cdp,port,target.id,ORIGIN+"/read/g46-concurrent",()=>runConcurrent(cdp));
  }
  const diagnosticRecords=await cdp.evaluate("window.__g46timeline??[]");
  diagnosticRecords.sort((a,b)=>a.time-b.time);
  await writeFile(new URL("../tmp-g46-timeline.json", import.meta.url), JSON.stringify(diagnosticRecords, null, 2));
  console.log(JSON.stringify({timelineRecords:diagnosticRecords.length}));
  console.log("G-46 observer checks passed");
 } catch (error) {
  failureError=error;
  failureClassification="其他";
  if(cdp) {
    try {
      if(String(error.message).includes("Timed out:")||String(error.message).includes("CDP timeout:")||error.message==="page hidden")
        await cdp.evaluate("window.__g46probe()",true,true);
      const records=await cdp.evaluate("window.__g46timeline??[]",false,true);
      records.sort((a,b)=>a.time-b.time);
      failureClassification=classifyFailure(records,await cdp.evaluate("innerHeight",false,true));
      const timelinePath = new URL("../tmp-g46-timeline.json", import.meta.url);
      await writeFile(timelinePath, JSON.stringify(records, null, 2));
      console.log(JSON.stringify({timelinePath:timelinePath.pathname,records:records.length,scenario:currentScenario}));
      const click=records.findLastIndex(r=>r.kind==="script-click-before");
      const selected=records.length<=40?records:records.slice(Math.max(0,click-20),click).concat(records.slice(click,click+20));
      for(const record of selected) console.log(JSON.stringify(record));
    } catch(diagnosticError) { console.error(diagnosticError.stack??String(diagnosticError)); }
  }
  console.error(error.stack??String(error));
  process.exitCode=1;
} finally {
  cdp?.close();
  chrome.kill();
  if (chrome.exitCode === null) await Promise.race([new Promise(done => chrome.once("exit", done)), sleep(5000)]);
  const resolved = resolve(profile);
  if (!resolved.startsWith(resolve(tmpdir(), "gloss-g46-"))) throw new Error("Unexpected Chrome profile path");
  await rm(resolved, { recursive:true, force:true, maxRetries:10, retryDelay:200 }).catch(error=>{
    if(!failureError)throw error;
    console.error(error.stack??String(error));
  });
}
if(failureClassification!==null)console.log("G-46 failure classification: "+failureClassification+" ("+currentScenario+")");
