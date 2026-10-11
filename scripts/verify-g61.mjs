import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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



const countChars = text => Array.from(text.replace(/\s/g, '')).length;
const original = await readFile(new URL('../test-fixtures/社会哲学概论-全书.txt', import.meta.url), 'utf8');
const percentile = (xs, p) => [...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
function sample(target) {
  let text = '';
  while(countChars(text) < target) text += original + '\n';
  let count = 0, result = '';
  for(const char of text) { if(count >= target) break; result += char; if(!/\s/.test(char)) count++; }
  return result;
}
const browserSource = `
window.__g61={structure:[], firstScreen:null, navigationStart:null, events:[]};
addEventListener('gloss:analytics',e=>{__g61.events.push(e.detail);if(e.detail.event==='doc_parse_complete')__g61.navigationStart=performance.now();});
const push=history.pushState.bind(history);
history.pushState=function(...args){if(String(args[2]).includes('/read/')&&__g61.navigationStart===null)__g61.navigationStart=performance.now();return push(...args);};
(function visible(){const s=document.querySelector('.reader-body .sentence');if(__g61.navigationStart!==null&&__g61.firstScreen===null&&s){const r=s.getBoundingClientRect();if(getComputedStyle(s).visibility==='visible'&&r.height>0&&r.bottom>0&&r.top<innerHeight)__g61.firstScreen=performance.now()-__g61.navigationStart;}requestAnimationFrame(visible);})();
const realFetch=fetch.bind(window);
window.fetch=async function(input,options){const url=String(input);if(url.includes('/api/gloss'))return new Response('data: {"type":"done"}\\n\\n',{headers:{'Content-Type':'text/event-stream'}});
if(url.includes('/api/analytics'))return new Response(null,{status:204});
if(url.includes('/api/structure')){const body=JSON.parse(options.body);const entry={body,status:null};__g61.structure.push(entry);const response=await realFetch(input,options);entry.status=response.status;return response;}return realFetch(input,options);};
window.__g61.click=async function(index){
const s=document.querySelector('.sentence[data-index="'+index+'"]');if(!s)throw new Error('Missing sentence '+index);s.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
return await new Promise((resolve,reject)=>{const start=performance.now();const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Panel timeout'));},3000);const observer=new MutationObserver(()=>{if(document.querySelector('.gloss-panel[data-sentence-index="'+index+'"]')){clearTimeout(timer);observer.disconnect();resolve(performance.now()-start);}});observer.observe(document.querySelector('.reader-body'),{childList:true,subtree:true});s.click();});};
window.__g61.close=async function(index){document.querySelector('.sentence[data-index="'+index+'"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));};
window.__g61.line=function(index){const s=document.querySelector('.sentence[data-index="'+index+'"]');s.scrollIntoView({block:'center',behavior:'instant'});const node=s.firstChild;const chars=[];let offset=0;for(const char of node.data){const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+char.length);const r=range.getBoundingClientRect();if(r.top>=0&&r.bottom<=innerHeight)chars.push({offset,char,x:r.left,y:r.top});offset+=char.length;}if(!chars.length)throw new Error('No visible characters');const y=chars[0].y;return chars.filter(c=>Math.abs(c.y-y)<1);};
window.__g61.compare=function(index,before){let max=0;for(const char of before){const spans=[...document.querySelectorAll('.sentence[data-index="'+index+'"]')];const s=spans.find(s=>Number(s.dataset.offset)<=Number(spans[0].dataset.offset)+char.offset&&Number(s.dataset.offset)+s.textContent.length>Number(spans[0].dataset.offset)+char.offset);if(!s)throw new Error('Lost source character');const offset=Number(spans[0].dataset.offset)+char.offset-Number(s.dataset.offset);const range=document.createRange();range.setStart(s.firstChild,offset);range.setEnd(s.firstChild,offset+char.char.length);const r=range.getBoundingClientRect();max=Math.max(max,Math.abs(r.left-char.x),Math.abs(r.top-char.y));}return max;};
`;
async function runGroup(cdp, target) {
  const firstScreens=[];
  let docStats;
  for(let repeat=0;repeat<3;repeat++){
    await navigate(cdp,ORIGIN+'/');
    await cdp.evaluate("localStorage.clear()",false,'clear isolated storage');
    await cdp.call('Page.reload');
    await waitForValue(()=>cdp.evaluate("document.readyState==='complete' && !!document.querySelector('.import-spine,.landing-secondary')"),'shelf hydration');
    await cdp.evaluate("document.querySelector('.import-spine,.landing-secondary').click()",false,'open import');
    await waitForValue(()=>cdp.evaluate("!!document.querySelector('textarea')"),'paste input');
    await cdp.evaluate(`document.querySelector('textarea').value=${JSON.stringify(sample(target))};__g61.structure=[];__g61.navigationStart=null;__g61.firstScreen=null;document.querySelector('textarea').closest('section').querySelector('button').click()`,false,'paste import');
    await waitForValue(()=>cdp.evaluate("location.pathname.startsWith('/read/')&&__g61.firstScreen!==null"),'first visible sentence');
    firstScreens.push(await cdp.evaluate('__g61.firstScreen'));
    await waitForValue(()=>cdp.evaluate('__g61.structure.length>0&&__g61.structure.at(-1).status!==null'),'structure response');
    docStats=await cdp.evaluate(`(()=>{const id=location.pathname.split('/').pop(),raw=localStorage.getItem('gloss:doc:'+id),doc=JSON.parse(raw),event=__g61.events.filter(e=>e.event==='doc_parse_complete').at(-1);const structures=__g61.structure.map(e=>({bodyChars:Array.from(e.body.paragraphs.join('').replace(/\\s/g,'')).length,headingChars:Array.from(e.body.headings.join('').replace(/\\s/g,'')).length,status:e.status}));return{chars:doc.meta.charCount,paragraphs:doc.paragraphs.length,sentences:document.querySelectorAll('.sentence[data-index]').length,storageUtf8Bytes:new TextEncoder().encode(raw).length,storageUtf16Bytes:raw.length*2,structures,parseCharsBucket:event?.parseCharsBucket,sentenceCountBucket:event?.sentenceCountBucket};})()`);
    await sleep(500);
  }
  const clicks=[],displacements=[];
  const starts=[10,Math.floor(docStats.sentences/2),docStats.sentences-50];
  for(const start of starts){
    const values=[];
    for(let i=0;i<40;i++){values.push(await cdp.evaluate(`__g61.click(${start+i})`,true,'click to panel'));await cdp.evaluate(`__g61.close(${start+i})`,true,'close panel');}
    clicks.push({n:values.length,p90:percentile(values,.9),max:Math.max(...values),values});
    const before=await cdp.evaluate(`__g61.line(${start})`);
    await cdp.evaluate(`__g61.click(${start})`,true);
    await sleep(100);
    displacements.push(await cdp.evaluate(`__g61.compare(${start},${JSON.stringify(before)})`));
    await cdp.evaluate(`__g61.close(${start})`,true);
  }
  const report={target,...docStats,firstScreens,firstScreenMedian:percentile(firstScreens,.5),clicks,displacements};
  console.log(JSON.stringify(report));
  return report;
}
const profile=await mkdtemp(join(tmpdir(),'gloss-g61-'));
const port=await freePort();browserStartedAt=performance.now();
const edge=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox',`--remote-debugging-port=${port}`,'--remote-allow-origins=*',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let cdp,browserCdp;
try{
  const target=await waitForValue(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json`);return(await response.json()).find(t=>t.type==='page');},'Edge CDP');
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();browserCdp=new Cdp(version.webSocketDebuggerUrl);cdp=new Cdp(target.webSocketDebuggerUrl);
  await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:browserSource});await assertSinglePage(browserCdp,target.id,'setup single page');
  const reports=[];for(const size of [90_000,199_500])reports.push(await runGroup(cdp,size));
  await assertSinglePage(browserCdp,target.id,'finish single page');
  const errors=[];for(const r of reports){if(r.firstScreenMedian>2000)errors.push(r.target+' first screen');if(r.clicks.some(g=>g.p90>50))errors.push(r.target+' click P90');if(r.displacements.some(d=>d>=.5))errors.push(r.target+' displacement');if(r.structures.some(s=>s.bodyChars>50000||s.bodyChars+s.headingChars>50000||s.status===400))errors.push(r.target+' structure');if(r.chars!==r.target)errors.push(r.target+' actual chars');}
  if(errors.length)throw new Error('G-61 failed: '+errors.join(', '));
}finally{
  cdp?.close();browserCdp?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(done=>edge.once('exit',done)),sleep(5000)]);
  const resolved=resolve(profile);if(!resolved.startsWith(resolve(tmpdir(),'gloss-g61-')))throw new Error('Unexpected profile path');await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
console.log('G-61 checks passed');