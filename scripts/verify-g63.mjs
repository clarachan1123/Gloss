import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = "http://127.0.0.1:3464";
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





const assert=(ok,label)=>{if(!ok)throw Error(label);};
const evalFn=(cdp,fn,...args)=>cdp.evaluate("("+fn.toString()+")("+args.map(a=>JSON.stringify(a)).join(",")+")",true);
function pageSetup() {
  window.__g63={calls:[],operationIndex:null};
  const native=window.scrollBy;
  window.scrollBy=function(...args) {
    const options=args[0],g6=options?.behavior==='smooth';
    let expected=null;
    if(g6) {
      const index=window.__g63.operationIndex,source=document.querySelector('.sentence[data-index="'+index+'"]'),panel=document.querySelector('.gloss-panel[data-sentence-index="'+index+'"]');
      if(source&&panel) {
        const top=(source.getClientRects()[0]??source.getBoundingClientRect()).top,bottom=panel.getBoundingClientRect().bottom;
        expected=top<16?top-16:bottom>innerHeight-16?Math.min(bottom-(innerHeight-16),top-16):0;
      }
    }
    window.__g63.calls.push({top:options?.top??args[1]??0,g6,expected});
    return native.apply(this,args);
  };
}
function snapshot(includePlaceholders=false) {
  const chars=[];
  for(const span of document.querySelectorAll(includePlaceholders?'.reader-body .sentence,.reader-body .reader-tail-placeholder':'.reader-body .sentence')) {
    const node=span.firstChild,para=span.closest('[data-para]');
    if(!(node instanceof Text)||!para)continue;
    const placeholder=span.classList.contains('reader-tail-placeholder');
    if(placeholder&&!includePlaceholders)continue;
    let start=Number(span.dataset.offset);
    if(placeholder){start=Number(para.dataset.blockStart);for(let previous=span.previousElementSibling;previous;previous=previous.previousElementSibling)start+=previous.textContent.length;}
    let offset=0;
    for(const char of node.data) {
      const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+char.length);
      const r=range.getBoundingClientRect();
      chars.push({key:para.dataset.para+':'+(start+offset),para:Number(para.dataset.para),
        index:placeholder?-1:Number(span.dataset.index),offset:start+offset,char,x:r.left,y:r.top,bottom:r.bottom});
      offset+=char.length;
    }
  }
  return chars;
}
function structure(para) {
  return [...document.querySelectorAll('.reader-body [data-reader-block][data-para="'+para+'"],.reader-body .gloss-panel')]
    .filter(el=>el.matches('[data-reader-block]')||document.querySelector('.sentence[data-index="'+el.dataset.sentenceIndex+'"]')?.closest('[data-para]')?.dataset.para===String(para))
    .map(el=>el.matches('.gloss-panel')?{panel:Number(el.dataset.sentenceIndex)}:
      {block:true,start:el.dataset.blockStart,end:el.dataset.blockEnd,
        first:el.querySelector('.sentence')?.dataset.offset??null,
        last:(()=>{const span=[...el.querySelectorAll('.sentence')].at(-1);return span?Number(span.dataset.offset)+span.textContent.length:null;})()});
}
function integrity(para,expected) {
  const spans=[...document.querySelectorAll('.reader-body [data-para="'+para+'"] .sentence')];
  if(spans.map(s=>s.textContent).join('')!==expected)throw Error('original text not present exactly once: '+para);
  let offset=0;
  for(const span of spans){if(Number(span.dataset.offset)!==offset)throw Error('offset gap or overlap: '+para+':'+offset);offset+=span.textContent.length;}
  if(document.querySelector('.reader-tail-placeholder.sentence,.reader-tail-placeholder[data-index],.reader-tail-placeholder[data-offset]'))throw Error('placeholder identity');
}
async function ready(cdp) {
  await waitForValue(()=>cdp.evaluate("!!document.querySelector('.sentence[data-index=\"11\"]')&&document.querySelector('.reader-body')?.dataset.measuring==='false'"),'reader ready');
  await cdp.evaluate('document.fonts.ready',true);
  await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',true);
}
async function settle(cdp){await cdp.evaluate('new Promise(r=>setTimeout(()=>requestAnimationFrame(r),300))',true);}
async function closeAll(cdp){await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle(cdp);}
function delta(before,after,label) {
  let max=0;
  for(const c of before){const matches=after.filter(n=>n.key===c.key&&n.char===c.char);assert(matches.length,label+' missing '+c.key);
    max=Math.max(max,Math.min(...matches.map(n=>Math.max(Math.abs(n.x-c.x),Math.abs(n.y-c.y)))));}
  assert(max<0.5,label+' glyph drift '+max);return max;
}
async function click(cdp,index,which,metrics,expected,allowG6=false) {
  const point=await evalFn(cdp,(index,which,snapshot)=>{
    const chars=eval('('+snapshot+')')().filter(c=>c.index===index&&c.char.trim());
    const selected=which==='middle'?chars[Math.floor(chars.length/2)]:chars[0];
    if(!selected)throw Error('missing click char '+index);
    window.scrollTo({top:scrollY+selected.y-innerHeight*0.4,behavior:'instant'});
    return {key:selected.key,offset:selected.offset};
  },index,which,snapshot.toString());
  await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',true);
  const result=await evalFn(cdp,async(index,key,snapshotText,structureText)=>{
    const snap=eval('('+snapshotText+')'),shape=eval('('+structureText+')');
    const before=snap(),selected=before.find(c=>c.key===key),para=selected.para;
    const closedPanels=[...document.querySelectorAll('.gloss-panel')].filter(p=>!p.classList.contains('gloss-panel-saved')&&document.querySelector('.sentence[data-index="'+p.dataset.sentenceIndex+'"]')?.closest('[data-para]')?.dataset.para!==String(para));
    const closedIndices=closedPanels.map(p=>p.dataset.sentenceIndex);
    const cross=closedPanels.length?{panelHeightBefore:closedPanels.reduce((sum,p)=>sum+p.getBoundingClientRect().height,0),scrollBefore:scrollY}:null;
    const spans=[...document.querySelectorAll('.reader-body [data-para="'+para+'"] .sentence')];
    const span=spans.find(s=>Number(s.dataset.offset)<=selected.offset&&Number(s.dataset.offset)+s.textContent.length>selected.offset);
    const range=document.createRange(),local=selected.offset-Number(span.dataset.offset);
    range.setStart(span.firstChild,local);range.setEnd(span.firstChild,local+selected.char.length);
    const r=range.getBoundingClientRect();
    const panelsBefore=[...document.querySelectorAll('.gloss-panel')].map(p=>({index:Number(p.dataset.sentenceIndex),saved:p.classList.contains('gloss-panel-saved'),para:Number(document.querySelector('.sentence[data-index="'+p.dataset.sentenceIndex+'"]')?.closest('[data-para]')?.dataset.para),height:p.getBoundingClientRect().height,top:p.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom,action:!!p.querySelector('.action-row')}));
    const layoutBefore={blockTop:span.closest('[data-reader-block]')?.getBoundingClientRect().top??null,scrollY,translate:document.querySelector('.reader-body').style.translate};
    window.__g63.calls=[];window.__g63.operationIndex=index;
    const start=performance.now();
    span.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
    const first=await new Promise(resolve=>requestAnimationFrame(()=>{
      const elapsed=performance.now()-start;
      const currentSpan=[...document.querySelectorAll('.reader-body [data-para="'+para+'"] .sentence')].find(s=>Number(s.dataset.offset)<=selected.offset&&Number(s.dataset.offset)+s.textContent.length>selected.offset);
      const panelsAfter=[...document.querySelectorAll('.gloss-panel')].map(p=>({index:Number(p.dataset.sentenceIndex),saved:p.classList.contains('gloss-panel-saved'),para:Number(document.querySelector('.sentence[data-index="'+p.dataset.sentenceIndex+'"]')?.closest('[data-para]')?.dataset.para),height:p.getBoundingClientRect().height,top:p.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom,action:!!p.querySelector('.action-row')}));
      resolve({panelsAfter,layoutAfter:{blockTop:currentSpan?.closest('[data-reader-block]')?.getBoundingClientRect().top??null,scrollY,translate:document.querySelector('.reader-body').style.translate},elapsed,measuring:document.querySelector('.reader-body').dataset.measuring,shape:shape(para),after:snap(true),calls:window.__g63.calls.slice(),cross:cross?{...cross,panelHeightAfter:closedIndices.reduce((sum,i)=>sum+(document.querySelector('.gloss-panel[data-sentence-index="'+i+'"]')?.getBoundingClientRect().height??0),0),scrollAfter:scrollY,translate:document.querySelector('.reader-body').style.translate}:null});
    }));
    await new Promise(resolve=>setTimeout(resolve,1000));
    return {before,selected,panelsBefore,layoutBefore,first,laterShape:shape(para)};
  },index,point.key,snapshot.toString(),structure.toString());
  assert(result.first.measuring==='false','measurement not finished by first rAF');
  assert(JSON.stringify(result.first.shape)===JSON.stringify(result.laterShape),'structure changed after first rAF');
  assert(result.first.elapsed<=100,'first rAF exceeded 100ms: '+result.first.elapsed);
  metrics.rAF=Math.max(metrics.rAF,result.first.elapsed);
  const selectedAfter=result.first.after.find(c=>c.key===result.selected.key&&c.index===result.selected.index);
  if(result.first.cross)console.log(JSON.stringify({cross:true,width:metrics.width,index,dx:selectedAfter.x-result.selected.x,dy:selectedAfter.y-result.selected.y,...result.first.cross}));
  if(index===7&&result.panelsBefore.some(p=>p.index===5&&p.saved)&&result.first.panelsAfter.some(p=>p.index===5)&&result.before.filter(c=>c.para===2).length) {
    const panel=result.panelsBefore.find(p=>p.index===5),afterPanel=result.first.panelsAfter.find(p=>p.index===5);
    const shifts=result.before.filter(c=>c.para===result.selected.para&&c.y<=result.selected.y+0.5).map(c=>{
      const matches=result.first.after.filter(n=>n.key===c.key&&n.char===c.char);
      const n=matches.sort((a,b)=>Math.max(Math.abs(a.x-c.x),Math.abs(a.y-c.y))-Math.max(Math.abs(b.x-c.x),Math.abs(b.y-c.y)))[0];
      return {...c,dx:n.x-c.x,dy:n.y-c.y};
    });
    const worst=shifts.toSorted((a,b)=>Math.max(Math.abs(b.dx),Math.abs(b.dy))-Math.max(Math.abs(a.dx),Math.abs(a.dy)))[0];
    const above=shifts.filter(c=>c.y<panel.top),between=shifts.filter(c=>c.y>=panel.bottom);
    console.log(JSON.stringify({savedDiagnostic:true,width:metrics.width,clicked:{dx:selectedAfter.x-result.selected.x,dy:selectedAfter.y-result.selected.y},worst:{para:worst.para,offset:worst.offset,char:worst.char,dx:worst.dx,dy:worst.dy},panel5:{before:panel,after:afterPanel},layout:{before:result.layoutBefore,after:result.first.layoutAfter},above:{minY:Math.min(...above.map(c=>c.dy)),maxY:Math.max(...above.map(c=>c.dy)),maxX:Math.max(...above.map(c=>Math.abs(c.dx)))},between:{maxX:Math.max(...between.map(c=>Math.abs(c.dx))),maxY:Math.max(...between.map(c=>Math.abs(c.dy)))}}));
  }
  assert(Math.abs(selectedAfter.x-result.selected.x)<0.5,'clicked glyph x moved');
  const g6=result.first.calls.filter(c=>c.g6);
  if(allowG6){assert(g6.length===1&&Math.abs(g6[0].top-g6[0].expected)<0.5&&g6[0].top!==0,'G6 request must equal adjustment');metrics.g6=g6[0];}
  else {
    assert(g6.every(c=>c.top===0),'unexpected G6 '+JSON.stringify(g6));
    const upper=result.before.filter(c=>c.para===result.selected.para&&c.y<=result.selected.y+0.5);
    // A: a saved panel's action row may disappear. Preserve the click and the text below
    // the nearest resized panel; text above it must move by precisely the height removed.
    const resized=result.panelsBefore.filter(p=>p.para===result.selected.para&&p.bottom<=result.selected.y+0.5)
      .map(p=>({before:p,after:result.first.panelsAfter.find(n=>n.index===p.index)}))
      .filter(p=>p.after&&Math.abs(p.before.height-p.after.height)>0.001)
      .sort((a,b)=>b.before.bottom-a.before.bottom)[0];
    assert(Math.abs(selectedAfter.y-result.selected.y)<0.5,'clicked glyph y moved');
    if(resized){
      const expectedShift=resized.before.height-resized.after.height;
      const below=upper.filter(c=>c.y>=resized.before.bottom);
      const above=upper.filter(c=>c.y<resized.before.top);
      const correctedAbove=above.map(c=>({...c,y:c.y+expectedShift}));
      const max=Math.max(delta(below,result.first.after,'click '+index+' below resized panel'),
        delta(correctedAbove,result.first.after,'click '+index+' above resized panel height compensation'));
      metrics.max=Math.max(metrics.max,max);
    }else metrics.max=Math.max(metrics.max,delta(upper,result.first.after,'click '+index));
  }
  await evalFn(cdp,integrity,2,expected);
  return result;
}
async function checks(cdp,width) {
  const metrics={width,max:0,g:null,rAF:0,g6:null};
  const expected=await evalFn(cdp,()=>[...document.querySelectorAll('[data-para="2"] .sentence')].map(s=>s.textContent).join(''));
  // Test-only outside padding allows every requested point to be positioned at 40% without scroll clamping.
  await evalFn(cdp,()=>{for(const place of ['before','after']){const pad=document.createElement('div');pad.dataset.g63Padding=place;pad.style.height='1000px';const body=document.querySelector('.reader-body');if(place==='before')body.before(pad);else body.after(pad);}});
  for(const which of ['first','middle']) {
    await closeAll(cdp);
    for(const [index,point] of [[5,'first'],[6,which],[8,'first'],[4,'first']])await click(cdp,index,point,metrics,expected);
    const opened=await evalFn(cdp,()=>[...document.querySelectorAll('.gloss-panel')].map(p=>Number(p.dataset.sentenceIndex)).sort((a,b)=>a-b));
    assert(JSON.stringify(opened)===JSON.stringify([4,5,6,8]),'same paragraph panels');
    await click(cdp,6,'first',metrics,expected);
    const retained=await evalFn(cdp,()=>[...document.querySelectorAll('.gloss-panel')].map(p=>Number(p.dataset.sentenceIndex)).sort((a,b)=>a-b));
    assert(JSON.stringify(retained)===JSON.stringify([4,5,8]),'single close retained wrong panels');
  }
  await click(cdp,0,'first',metrics,expected);
  assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===1"),'cross paragraph did not batch close');
  await click(cdp,1,'first',metrics,expected);await click(cdp,5,'first',metrics,expected);
  assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===1"),'reverse cross paragraph did not batch close');
  for(const kind of ['escape','blank']) {
    await click(cdp,7,'first',metrics,expected);
    const before=await evalFn(cdp,snapshot),anchor=before.find(c=>c.y>=0&&c.y<900&&c.char.trim());
    assert(anchor,'missing viewport top anchor');
    await cdp.evaluate(kind==='escape'?"document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))":"document.querySelector('.reader-body').click()");
    await settle(cdp);assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===0"),'all temporary close '+kind);
    metrics.max=Math.max(metrics.max,delta([anchor],await evalFn(cdp,snapshot),kind));
    await evalFn(cdp,integrity,2,expected);
    if(kind==='escape')await click(cdp,5,'first',metrics,expected);
  }
  await click(cdp,5,'first',metrics,expected);await click(cdp,9,'first',metrics,expected);
  // The sample ends at paragraph 3. Add local reference text below it solely to make full upward exit and compensation measurable.
  await evalFn(cdp,()=>{const body=document.querySelector('.reader-body');for(let n=0;n<30;n++){const p=document.createElement('p');p.dataset.para=String(1000+n);p.dataset.g63Reference='';p.className='reader-para';const span=document.createElement('span');span.className='sentence';span.dataset.index=String(1000+n);span.dataset.offset='0';span.textContent='下方验证参照文字。';p.append(span);body.append(p);}});
  await evalFn(cdp,()=>{const tail=[...document.querySelectorAll('[data-reader-block][data-para="2"]')].at(-1);window.scrollTo({top:scrollY+tail.getBoundingClientRect().top+3,behavior:'instant'});});
  await settle(cdp);assert(await cdp.evaluate("document.querySelectorAll('.gloss-panel').length===2"),'continuation visible closed paragraph');
  const auto=await evalFn(cdp,async(snapshotText)=>{
    const targets=[...document.querySelectorAll('[data-reader-block][data-para="2"],.gloss-panel')],bottom=Math.max(...targets.map(t=>t.getBoundingClientRect().bottom));
    window.scrollBy({top:bottom+20,behavior:'instant'});
    const snap=eval('('+snapshotText+')'),before=snap(),anchor=before.find(c=>c.para>=1000&&c.y>=0&&c.y<innerHeight);
    if(!anchor)throw Error('missing auto-collapse reference');
    await new Promise(r=>setTimeout(()=>requestAnimationFrame(r),300));
    return {anchor,after:snap(),panels:document.querySelectorAll('.gloss-panel').length};
  },snapshot.toString());
  assert(auto.panels===0,'full paragraph exit retained temporary panels');
  const changed=auto.after.find(c=>c.key===auto.anchor.key);
  metrics.g=Math.max(Math.abs(changed.x-auto.anchor.x),Math.abs(changed.y-auto.anchor.y));assert(metrics.g<1,'auto-collapse drift '+metrics.g);
  await cdp.call('Page.reload');await ready(cdp);
  await click(cdp,5,'first',metrics,expected);
  await evalFn(cdp,()=>document.querySelector('.gloss-panel[data-sentence-index="5"] .action-row-save').click());await settle(cdp);
  for(const index of [7,9])await click(cdp,index,'first',metrics,expected);
  for(const label of ['收起','显示']) {
    await evalFn(cdp,label=>[...document.querySelectorAll('.mode-option')].find(b=>b.textContent.trim()===label).click(),label);await settle(cdp);
    await evalFn(cdp,integrity,2,expected);
    if(label==='收起')assert(await cdp.evaluate("[...document.querySelectorAll('.sentence[data-index=\"5\"]')].every(s=>s.classList.contains('sentence-saved-collapsed'))"),'collapsed underline');
  }
  const copied=await evalFn(cdp,()=>{
    const first=document.querySelector('.sentence[data-index="5"]'),last=[...document.querySelectorAll('[data-para="2"] .sentence')].at(-1),range=document.createRange();
    range.setStart(first.firstChild,0);range.setEnd(last.firstChild,last.firstChild.length);
    const selection=getSelection(),normalize=text=>text.replace(/\r?\n/g,'');
    selection.removeAllRanges();selection.addRange(range);const selected=normalize(selection.toString());
    let original='',pieces='',placeholder='';
    for(const el of document.querySelectorAll('.reader-body .sentence,.reader-body .reader-tail-placeholder,.reader-body .gloss-panel')){
      if(!range.intersectsNode(el))continue;
      const part=document.createRange();part.selectNodeContents(el);selection.removeAllRanges();selection.addRange(part);
      const text=normalize(selection.toString());
      if(el.matches('.sentence')){original+=el.textContent;if(text!==el.textContent)throw Error('original text became unselectable');}
      if(el.matches('.reader-tail-placeholder'))placeholder+=text;
      pieces+=text;
    }
    selection.removeAllRanges();
    return {selected,pieces,original,placeholder,suffix:[...document.querySelectorAll('[data-para="2"] .sentence')].filter(s=>Number(s.dataset.index)>=5).map(s=>s.textContent).join('')};
  });
  assert(copied.placeholder==='','transparent placeholder must not enter Selection text');
  assert(copied.original===copied.suffix&&copied.selected===copied.pieces,'selected original characters must occur in order exactly once across continuation blocks');
  await cdp.call('Page.reload');await ready(cdp);await evalFn(cdp,integrity,2,expected);
  assert(await cdp.evaluate("!!document.querySelector('.gloss-panel-saved[data-sentence-index=\"5\"]')"),'saved refresh');
  // Independent G6 calculation is sampled by the scrollBy wrapper at the request instant.
  await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:190,deviceScaleFactor:1,mobile:false});await settle(cdp);
  await click(cdp,10,'first',metrics,expected,true);
  console.log(JSON.stringify({width,maxAbsDeltaXY:metrics.max,autoCollapseMaxAbsDeltaXY:metrics.g,firstRAFMaxMs:metrics.rAF,g6:metrics.g6}));
}
async function run(width) {
  const profile=await mkdtemp(join(tmpdir(),'gloss-g63-')),port=await freePort();browserStartedAt=performance.now();
  const edge=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let cdp,browser;
  try{
    const target=await waitForValue(async()=>{const r=await fetch('http://127.0.0.1:'+port+'/json');return(await r.json()).find(t=>t.type==='page');},'Edge CDP');
    const version=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();
    cdp=new Cdp(target.webSocketDebuggerUrl);browser=new Cdp(version.webSocketDebuggerUrl);
    await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:'('+pageSetup.toString()+')();'});
    await assertSinglePage(browser,target.id,'start:single-page');await navigate(cdp,ORIGIN+'/read/sample');await ready(cdp);
    await checks(cdp,width);await assertSinglePage(browser,target.id,'finish:single-page');
  }finally{
    cdp?.close();browser?.close();edge.kill();
    if(edge.exitCode===null)await Promise.race([new Promise(done=>edge.once('exit',done)),sleep(5000)]);
    const resolved=resolve(profile);if(!resolved.startsWith(resolve(tmpdir(),'gloss-g63-')))throw Error('Unexpected profile');
    await rm(resolved,{recursive:true,force:true}).catch(error=>console.warn('Profile cleanup: '+error.code));
  }
}
for(const width of [375,506,768,1024,1280])await run(width);
console.log('G-63 checks passed');
