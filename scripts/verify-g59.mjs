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


// Each width and each landing run gets a fresh profile; all coordinates are page coordinates.
const WIDTHS = [375, 506, 768, 1024, 1280];
const browserSource = `
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
    placeholders:[...scope.querySelectorAll('.reader-tail-placeholder')].map(p=>({text:p.textContent,valid:p.getAttribute('aria-hidden')==='true'&&p.hasAttribute('inert')&&!p.matches('.sentence,[data-index],[data-offset],.sentence-breathe,.sentence-gloss-hover')}))};
};
(function watchLanding(){
  const scope=document.querySelector('.landing-demo-visible');
  if(scope && !scope.querySelector('.landing-demo-panel-slot') && scope.querySelectorAll('.sentence').length===4 && !window.__g59.landingBefore)
    window.__g59.landingBefore=window.__g59.snapshot('.landing-demo-visible');
  if(!window.__g59.landingBefore) requestAnimationFrame(watchLanding);
})();`;
function fail(kind, width, index, char, dx, dy, detail) {
  throw new Error(JSON.stringify({assertion:kind,width,index,char,deltaX:dx,deltaY:dy,detail}));
}
function boundary(before, index) {
  const own = before.chars.filter(c=>c.index===index);
  if(!own.length) throw new Error('Missing baseline sentence '+index);
  const last = [...own].reverse().find(c=>c.char.trim());
  const end = last.offset+last.char.length;
  const paraEnd = Math.max(...before.chars.filter(c=>c.para===last.para).map(c=>c.offset+c.char.length));
  const next = before.chars.find(c=>c.para===last.para && c.offset>=end && c.char.trim() && c.y>last.y+last.lineHeight/2);
  return {para:last.para,end,split:next?.offset??null,paraEnd};
}
function compare(before, after, index, width, kind='open') {
  const b=boundary(before,index), split=b.split??b.paraEnd;
  const tail=before.chars.filter(c=>c.para===b.para&&c.offset>=b.end&&c.offset<split);
  const hasTail=tail.some(c=>c.char.trim());
  const map=new Map(); for(const c of after.chars){const list=map.get(c.key)??[];list.push(c);map.set(c.key,list);}
  let maxX=0,maxY=0,lowerShift=null,lowerX=0,lowerYError=0;
  const upper=before.chars.filter(c=>c.para<b.para || (c.para===b.para&&c.offset<b.end));
  for(const c of kind==='closed'?before.chars:upper){
    const matches=map.get(c.key)??[];if(matches.length!==1)fail(kind==='closed'?'c':'a',width,index,c.char,null,null,'real character count '+matches.length);
    const n=matches[0],dx=n.x-c.x,dy=n.y-c.y;maxX=Math.max(maxX,Math.abs(dx));maxY=Math.max(maxY,Math.abs(dy));
    if(Math.abs(dx)>=0.5||Math.abs(dy)>=0.5)fail(kind==='closed'?'c':'a',width,index,c.char,dx,dy,c.key);
  }
  if(kind==='closed')return {maxX,maxY};
  if(after.placeholders.some(p=>!p.valid))fail('b',width,index,'placeholder',null,null,'placeholder has sentence identity');
  const panels=after.panels.filter(p=>boundary(before,p.index).split===b.split && boundary(before,p.index).para===b.para);
  const bottom=Math.max(...panels.map(p=>p.bottom));
  if(!panels.length)fail('b',width,index,'panel',null,null,'group panel missing');
  if(hasTail){for(const c of tail){
    const matches=map.get(c.key)??[];
    if(matches.length!==1 || !matches[0].tail || matches[0].y<bottom)fail('b',width,index,c.char,null,null,'tail must appear once in tail line below final panel: '+c.key);
  }} else if(after.chars.some(c=>c.para===b.para&&c.tail&&c.offset>=b.end&&c.offset<split))fail('b',width,index,'empty tail',null,null,'unexpected tail line');
  for(const c of before.chars.filter(c=>c.para>b.para||(c.para===b.para&&c.offset>=split))){
    const matches=map.get(c.key)??[];if(matches.length!==1)fail('b',width,index,c.char,null,null,'lower character count '+matches.length);
    const n=matches[0],dx=n.x-c.x,dy=n.y-c.y;
    if(lowerShift===null)lowerShift=dy;
    lowerX=Math.max(lowerX,Math.abs(dx));lowerYError=Math.max(lowerYError,Math.abs(dy-lowerShift));
    if(Math.abs(dx)>=0.5||Math.abs(dy-lowerShift)>=0.5)fail('b',width,index,c.char,dx,dy,'lower paragraph line geometry changed');
  }
  return {maxX,maxY,lowerX,lowerYError,noTail:!hasTail};
}
async function settled(cdp) {
  await cdp.evaluate("new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),300))",true,'wait:animation');
}
async function readyReader(cdp) {
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.reader-body .sentence[data-index=\"11\"]') && !document.querySelector('.reader-body-measuring') && getComputedStyle(document.querySelector('.reader-body')).visibility==='visible'",false,'wait:reader'),'reader');
  await cdp.evaluate('document.fonts.ready',true,'wait:fonts'); await settled(cdp);
}
async function snap(cdp,scope='.reader-body'){return cdp.evaluate(`window.__g59.snapshot(${JSON.stringify(scope)})`,false,'snapshot');}
async function clickSentence(cdp,index,selector='.reader-body .sentence'){
  await cdp.evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)}+'[data-index="${index}"]');if(!s)throw new Error('Missing sentence');s.scrollIntoView({block:'center',behavior:'instant'});s.click();})()`,false,'click:sentence');
  await waitForValue(()=>cdp.evaluate(`!!document.querySelector('.reader-body .gloss-panel[data-sentence-index="${index}"][data-state="done"]')`,false,'wait:complete'),'complete gloss');await settled(cdp);
}
async function clickButton(cdp,scope,label){
  await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw new Error('Missing enabled button '+${JSON.stringify(label)});b.click();})()`,false,'click:button:'+label);await settled(cdp);
}
async function reload(cdp){await cdp.call('Page.reload',{},'reader:refresh');await waitForValue(()=>cdp.evaluate("document.readyState==='complete'&&!!window.__g59",false,'wait:refresh'),'refresh');await readyReader(cdp);}
async function gutterMetrics(cdp) {
  return cdp.evaluate("({clientWidth:document.documentElement.clientWidth,innerWidth:window.innerWidth,scrollOverflow:document.documentElement.scrollHeight>window.innerHeight,left:document.querySelector('.reader-body').getBoundingClientRect().left})",false,'diagnostic:gutter');
}
async function runReader(cdp,width){
  await navigate(cdp,ORIGIN+'/read/sample');
  await readyReader(cdp);
  let totalX=0,totalY=0,noTail=0;
  const baselines=[];
  for(let index=0;index<12;index++){
    const before=await snap(cdp);baselines.push(before);
    const gutterBefore=width===1024&&index===0 ? await gutterMetrics(cdp) : null;
    await clickSentence(cdp,index);
    if(gutterBefore) console.log(JSON.stringify({diagnostic:'gutter',width,index,before:gutterBefore,after:await gutterMetrics(cdp)}));
    const result=compare(before,await snap(cdp),index,width);
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",false,'collapse:escape');await settled(cdp);
    if(await cdp.evaluate("!!document.querySelector('.gloss-panel')",false,'collapse:check'))throw new Error('Panel still mounted after collapse');
    const closed=compare(before,await snap(cdp),index,width,'closed');
    totalX=Math.max(totalX,result.maxX,result.lowerX,closed.maxX);totalY=Math.max(totalY,result.maxY,closed.maxY);
    noTail+=Number(result.noTail);
    console.log(JSON.stringify({width,index,maxAbsDeltaX:Math.max(result.maxX,result.lowerX,closed.maxX),maxAbsDeltaY:Math.max(result.maxY,closed.maxY),lowerDeltaYError:result.lowerYError,tail:result.noTail?'无尾巴':'尾行'}));
  }
  await clickSentence(cdp,10);await clickButton(cdp,'.gloss-panel[data-sentence-index="10"]','留下');
  await reload(cdp);await clickSentence(cdp,10);
  compare(baselines[10],await snap(cdp),10,width);
  await clickButton(cdp,'.mode-switch','复习态');compare(baselines[10],await snap(cdp),10,width);
  await clickButton(cdp,'[aria-label="白话显示形态"]','气泡');compare(baselines[10],await snap(cdp),10,width);
  const b=boundary(baselines[10],10);
  const tailText=baselines[10].chars.filter(c=>c.para===b.para&&c.offset>=b.end&&c.offset<(b.split??b.paraEnd)).map(c=>c.char).join('');
  if(tailText.trim()){
    const selected=await cdp.evaluate(`(()=>{const first=document.querySelector('.sentence[data-index="10"]'),line=document.querySelector('.reader-tail-line'),last=line?.querySelector('.sentence:last-child');if(!first||!last)throw new Error('Missing selection endpoints');const range=document.createRange();range.setStart(first.firstChild,0);range.setEnd(last.firstChild,last.firstChild.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const text=selection.toString();selection.removeAllRanges();return text;})()`,false,'copy:selection');
    if(selected.split(tailText).length-1!==1)fail('copy',width,10,tailText,null,null,'tail substring count in Selection is not one');
  }
  // Remove this saved item via its action row, then compare a same-line saved/transient pair.
  await cdp.evaluate("localStorage.clear()",false,'fixture:clear-saved');await reload(cdp);
  const original=await snap(cdp);
  let pair=null;
  for(let i=0;i<11&&!pair;i++)for(let j=i+1;j<12;j++){
    const a=boundary(original,i),b=boundary(original,j);
    if(a.para===b.para&&a.split===b.split){pair=[i,j];break;}
  }
  if(!pair)throw new Error('No same-split pair at width '+width);
  await clickSentence(cdp,pair[0]);await clickButton(cdp,`.gloss-panel[data-sentence-index="${pair[0]}"]`,'留下');
  await clickButton(cdp,'.mode-switch','复习态');await clickSentence(cdp,pair[1]);
  const mixed=await snap(cdp);compare(original,mixed,pair[1],width);
  const group=boundary(original,pair[1]);
  const lineCount=await cdp.evaluate(`document.querySelectorAll('[data-para="${group.para}"].reader-tail-line').length`,false,'group:tail-line-count');
  const expected=original.chars.some(c=>c.para===group.para&&c.offset>=group.end&&c.offset<(group.split??group.paraEnd)&&c.char.trim());
  if(lineCount!==Number(expected))fail('group',width,pair[1],'tail line',null,null,'tail line count '+lineCount);
  // Fresh document visit resets per-session click counts; first tail click must be sentence_click.
  await cdp.evaluate('localStorage.clear()',false,'fixture:clear');await reload(cdp);
  const tailOwner=baselines.findIndex((before,index)=>{const b=boundary(before,index);return before.chars.some(c=>c.para===b.para&&c.offset>=b.end&&c.offset<(b.split??b.paraEnd)&&c.char.trim()&&c.index!==index);});
  if(tailOwner<0)throw new Error('No clickable tail at width '+width);
  await clickSentence(cdp,tailOwner);
  const tailIndex=await cdp.evaluate("Number(document.querySelector('.reader-tail-line .sentence').dataset.index)",false,'tail:index');
  await cdp.evaluate("window.__g59.events=[]; const s=document.querySelector('.reader-tail-line .sentence');s.click()",false,'tail:click');
  await waitForValue(()=>cdp.evaluate(`!!document.querySelector('.gloss-panel[data-sentence-index="${tailIndex}"][data-state="done"]')`,false,'tail:complete'),'tail gloss');await settled(cdp);
  const events=await cdp.evaluate('window.__g59.events',false,'tail:events');
  if(!events.some(e=>e.event==='sentence_click'&&e.sentenceIndex===tailIndex))fail('analytics',width,tailIndex,'tail first character',null,null,'sentence_click index mismatch');
  console.log(JSON.stringify({width,maxAbsDeltaX:totalX,maxAbsDeltaY:totalY,noTailCount:noTail,savedRefresh:true,review:true,bubble:true,sameSplitPair:pair,selection:tailText.trim()?'passed':'无尾巴',tailClickIndex:tailIndex}));
}
async function runLanding(cdp,width){
  await navigate(cdp,ORIGIN+'/');
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.landing-demo-visible')",false,'landing:ready'),'landing ready');
  await cdp.evaluate("document.querySelector('.landing-demo-stage').scrollIntoView({block:'center',behavior:'instant'})",false,'landing:scroll');
  await waitForValue(()=>cdp.evaluate("!!window.__g59.landingBefore",false,'landing:baseline'),'landing baseline');
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.landing-demo-pointer-settled')",false,'landing:settled'),'landing playback');
  const before=await cdp.evaluate('window.__g59.landingBefore',false,'landing:before');
  const result=compare(before,await snap(cdp,'.landing-demo-visible'),10,width);
  // Replay belongs to Landing, outside LandingDemo. Require one visible, enabled button.
  await waitForValue(()=>cdp.evaluate(`(()=>{
    const buttons=[...document.querySelectorAll('.landing-page button')].filter(button=>button.innerText.trim()==='再看一遍');
    if(buttons.length!==1)throw new Error('Expected exactly one replay button, got '+buttons.length);
    const button=buttons[0],style=getComputedStyle(button),rect=button.getBoundingClientRect();
    return style.display!=='none'&&style.visibility==='visible'&&rect.width>0&&rect.height>0&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&!!document.querySelector('.landing-demo-pointer-settled');
  })()`,false,'landing:replay-button-ready'),'one visible enabled replay button',15_000);
  await cdp.evaluate(`(()=>{
    const buttons=[...document.querySelectorAll('.landing-page button')].filter(button=>button.innerText.trim()==='再看一遍');
    if(buttons.length!==1)throw new Error('Expected exactly one replay button');
    const button=buttons[0],style=getComputedStyle(button),rect=button.getBoundingClientRect();
    if(style.display==='none'||style.visibility!=='visible'||rect.width<=0||rect.height<=0||button.disabled||button.getAttribute('aria-disabled')==='true')throw new Error('Replay button is not visible and enabled');
    button.click();
  })()`,false,'landing:replay-click');
  await settled(cdp);
  const replay=await snap(cdp,'.landing-demo-visible');compare(before,replay,10,width,'closed');
  if(replay.chars.some(c=>c.tail)||replay.placeholders.length)throw new Error('Landing replay did not restore complete paragraph');
  if(replay.chars.map(c=>c.char).join('')!==before.chars.map(c=>c.char).join(''))throw new Error('Landing replay original text mismatch');
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.landing-demo-pointer-settled')",false,'landing:replay-settled'),'landing replay playback');
  const replayResult=compare(before,await snap(cdp,'.landing-demo-visible'),10,width);
  console.log(JSON.stringify({landingReplay:true,width,maxAbsDeltaX:replayResult.maxX,maxAbsDeltaY:replayResult.maxY,noTail:replayResult.noTail}));
  console.log(JSON.stringify({landing:true,width,maxAbsDeltaX:result.maxX,maxAbsDeltaY:result.maxY,noTail:result.noTail,replay:true}));
}
async function runBrowser(width,landing){
  const profile=await mkdtemp(join(tmpdir(),'gloss-g59-'));
  const port=await freePort();browserStartedAt=performance.now();
  const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox',`--remote-debugging-port=${port}`,'--remote-allow-origins=*',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let cdp,browserCdp;
  try{
    const target=await waitForValue(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json`);return(await response.json()).find(t=>t.type==='page');},'Edge CDP');
    const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();browserCdp=new Cdp(version.webSocketDebuggerUrl);cdp=new Cdp(target.webSocketDebuggerUrl);
    await cdp.call('Page.enable');await cdp.call('Runtime.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:browserSource});
    await assertSinglePage(browserCdp,target.id,'setup:single-page');
    if(landing)await runLanding(cdp,width);else await runReader(cdp,width);
    await assertSinglePage(browserCdp,target.id,'finish:single-page');
  }finally{
    cdp?.close();browserCdp?.close();chrome.kill();
    if(chrome.exitCode===null)await Promise.race([new Promise(done=>chrome.once('exit',done)),sleep(5000)]);
    const resolved=resolve(profile);if(!resolved.startsWith(resolve(tmpdir(),'gloss-g59-')))throw new Error('Unexpected profile path');
    await rm(resolved,{recursive:true,force:true}).catch(error=>console.warn('Profile cleanup: '+error.code));
  }
}
for(const width of WIDTHS)await runBrowser(width,false);
for(const width of WIDTHS)await runBrowser(width,true);
console.log('Ctrl+F 未验证（待 Claude 在预览站人工核）');
console.log('G-59 layout checks passed');
