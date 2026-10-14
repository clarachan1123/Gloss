/** G-19a: invalid-key production service only; fresh isolated browser, zero /api/.
 * Positive drift is a hard stop. Negative control is explicitly isolated.
 * Run: node scripts/verify-g19.mjs (G19_ORIGIN defaults to :3469).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
const ORIGIN = process.env.G19_ORIGIN ?? "http://127.0.0.1:3469";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WIDTHS = (process.env.G19_WIDTHS??'375,506,768,1024,1280').split(',').map(Number);
if(WIDTHS.some(width=>![375,506,768,1024,1280].includes(width)))throw Error('Unsupported G19 width');
const KEY = "gloss:settings:reader-typography";
const DEFAULTS = { version: 1, fontSize: 17.5, lineHeight: 1.75, lineChars: 32, bodyFont: "sans", glossFont: "serif" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? "" : ": " + JSON.stringify(detail))); };
async function waitFor(fn, label) { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw Error("Timeout: " + label); }
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((r, j) => { this.socket.onopen = r; this.socket.onerror = j; });
    this.socket.onmessage = ({ data }) => { const m = JSON.parse(data), p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.j(Error(m.error.message)) : p.r(m.result); };
  }
  async call(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((r, j) => {
    const timer = setTimeout(() => { this.pending.delete(id); j(Error("CDP timeout: " + method)); }, 40000);
    this.pending.set(id, { r: v => { clearTimeout(timer); r(v); }, j: e => { clearTimeout(timer); j(e); } }); this.socket.send(JSON.stringify({ id, method, params }));
  }); }
  async evaluate(expression, awaitPromise = true) { const r = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
  close() { this.socket.close(); }
}
const evaluate = (c, fn, ...args) => c.evaluate(`(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(",")})`);
async function settle(c) { await c.evaluate("new Promise(r=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(r)),350))"); }
async function ready(c) { await waitFor(() => c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"11\"]')"), "reader"); await settle(c); }
function setup() {
  localStorage.setItem("gloss:analytics:optout", "1"); localStorage.setItem("gloss:sample:breathed", "1");
  window.__g19 = { events: [], rows: [], hidden: false };
  addEventListener("gloss:analytics", e => window.__g19.events.push(e.detail));
  addEventListener("visibilitychange", () => { if (document.hidden) window.__g19.hidden = true; });
  window.__g19.glyphs = () => {
    const out = [];
    for (const span of document.querySelectorAll('.reader-body .sentence')) {
      const node = span.firstChild, para = span.closest('[data-para]'); if (!(node instanceof Text) || !para) continue;
      let offset = 0;
      for (const char of node.data) { const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + char.length);
        const r = range.getBoundingClientRect(); out.push({ key: `${para.dataset.para}:${Number(span.dataset.offset)+offset}`, index: Number(span.dataset.index), char, x:r.x, y:r.y, bottom:r.bottom }); offset += char.length; }
    }
    return out;
  };
  window.__g19.rect = key => {
    const [para, offset] = key.split(':').map(Number);
    for (const span of document.querySelectorAll(`[data-para="${para}"] .sentence`)) {
      const start = Number(span.dataset.offset), node=span.firstChild;
      if (!(node instanceof Text) || offset < start || offset >= start+node.length) continue;
      const range=document.createRange(); range.setStart(node,offset-start); range.setEnd(node,offset-start+1); const r=range.getBoundingClientRect(); return { x:r.x,y:r.y,bottom:r.bottom,width:r.width,height:r.height };
    }
    throw Error('Lost reference '+key);
  };
  window.__g19.reference = () => {
    const bottom = Math.min(innerHeight, document.querySelector('.reader-typography-sheet')?.getBoundingClientRect().top ?? Infinity);
    const c=window.__g19.glyphs().find(c=>c.char.trim()&&c.y>=0&&c.bottom<=bottom); if(!c)throw Error('No visible original glyph'); return c;
  };
  const scrollTo=window.scrollTo;
  window.scrollTo=function(...args){const trace=window.__g19.trace;
    if(trace&&!trace.stop&&typeof args[0]==='object'&&args[0].top===0){const target=scrollY+window.__g19.rect(trace.ref.key).y-trace.ref.y;
      if(target<0)trace.targetScrollY=target;}
    return scrollTo.apply(this,args);};
  window.__g19.begin = (label, negative=false, key=null, allowTop=false) => {
    const state=window.__g19, ref=key?state.glyphs().find(g=>g.key===key):state.reference(), body=document.querySelector('.reader-body');
    const signature=()=>{const css=getComputedStyle(body);return JSON.stringify([css.fontSize,css.lineHeight,css.maxWidth,css.fontFamily,
      ...['--reader-font-size','--reader-line-height','--reader-line-chars','--reader-body-font','--reader-gloss-font'].map(name=>css.getPropertyValue(name)),
      getComputedStyle(body.querySelector('.gloss-panel')??body).fontFamily,state.rect(ref.key)]);};
    state.events=[];const trace={label,negative,ref,allowTop,targetScrollY:null,frames:[],changes:[],previous:null,signature:signature(),stop:false,raf:null,firstFailure:null};state.trace=trace;
    const tick=t=>{if(trace.stop)return; const r=state.rect(ref.key),sig=signature();
      const translate=getComputedStyle(body).translate;
      const translateAbs=translate==='none'?0:Math.max(...translate.split(/\s+/).map(value=>Math.abs(Number.parseFloat(value))));
      const frame={time:t,dt:trace.previous===null?null:t-trace.previous,key:ref.key,dy:r.y-ref.y,dx:r.x-ref.x,top:r.y,scrollY,
        translate,translateAbs,targetScrollY:trace.targetScrollY,maxScroll:document.scrollingElement.scrollHeight-innerHeight,
        value:getComputedStyle(body).fontSize,measuring:body.dataset.measuring,
        panels:[...body.querySelectorAll('.gloss-panel')].map(p=>({index:p.dataset.sentenceIndex,height:p.getBoundingClientRect().height}))};
      trace.previous=t;trace.frames.push(frame);if(sig!==trace.signature){trace.signature=sig;trace.changes.push(frame);}
      const boundary=allowTop&&scrollY===0&&trace.targetScrollY<0&&frame.dy===trace.targetScrollY;frame.topBoundaryException=boundary;
      const invalid=!(translateAbs<1)||(frame.dy!==0&&!boundary)||(label.startsWith('D13')&&frame.dx!==0);
      if(!negative&&trace.firstFailure===null&&invalid){
        trace.firstFailure=trace.frames.length-1;trace.failureReason=!(translateAbs<1)?'translate >=1px':(label.startsWith('D13')&&frame.dx!==0)?'D13 horizontal displacement':'nonzero displacement outside top exception';
        document.querySelector('input[type=range]:focus')?.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}));
      }
      if(trace.firstFailure!==null&&trace.frames.length>trace.firstFailure+3){trace.stop=true;return;}
      trace.raf=requestAnimationFrame(tick);};trace.raf=requestAnimationFrame(tick);
  };
  window.__g19.end = () => {
    const s=window.__g19,t=s.trace;t.stop=true;if(t.raf!==null)cancelAnimationFrame(t.raf);
    const values=t.changes.map(f=>f.dt).filter(v=>v!==null).sort((a,b)=>a-b), pct=p=>values[Math.max(0,Math.ceil(values.length*p)-1)]??null;
    return {scenario:t.label,negative:t.negative,key:t.ref.key,signedDisplacements:t.frames.map(f=>f.dy),maxAbsDelta:Math.max(0,...t.frames.map(f=>Math.abs(f.dy))),
      frames:t.frames.length,presentedFrames:t.changes.length,frameIntervals:t.frames.map(f=>f.dt),p50:pct(.5),p95:pct(.95),maxFrameMs:values.at(-1)??null,
      maxTranslate:Math.max(...t.frames.map(f=>f.translateAbs)),topBoundaryExceptions:t.frames.filter(f=>f.topBoundaryException).map(f=>({time:f.time,key:f.key,targetScrollY:f.targetScrollY,dy:f.dy,scrollY:f.scrollY,translateAbs:f.translateAbs})),firstFailure:t.firstFailure,failureReason:t.failureReason??null,failureFrames:t.firstFailure===null?[]:t.frames.slice(Math.max(0,t.firstFailure-3),t.firstFailure+4),
      events:s.events,hidden:s.hidden||document.hidden,panels:[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex),
      overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
  };
}
async function revealControls(c,width) {
  await evaluate(c,width=>{const selector=width<768?'.reader-typography-aa':'.settings-typography-toggle',button=document.querySelector(selector);
    if(button.getAttribute('aria-expanded')!=='true')button.click();},width); await settle(c);
}
async function align(c,index=11) {
  await evaluate(c,index=>{const glyph=window.__g19.glyphs().find(g=>g.index===index&&g.char.trim());window.scrollTo({top:scrollY+glyph.y-36,behavior:'instant'});},index); await settle(c);
}
async function change(c,key,value) {
  await evaluate(c,(key,value)=>{const prefix=innerWidth<768?'.reader-typography-sheet':'.col-right';
    const input=document.querySelector(`${prefix} input[data-typography="${key}"]${typeof value==='string'?`[value="${value}"]`:''}`);
    if(!input)throw Error('Missing typography input '+key); if(input.type==='radio')input.click();
    else {const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}},key,value);
  await settle(c);
}
function checkRow(width,result,negative=false) {
  console.log(JSON.stringify({width,...result,
    signedDisplacements:result.maxAbsDelta===0?{value:0,count:result.frames}:result.signedDisplacements,
    frameIntervals:{min:Math.min(...result.frameIntervals.filter(v=>v!==null)),max:Math.max(...result.frameIntervals.filter(v=>v!==null)),samples:result.frameIntervals.length-1}}));
  assert(!result.hidden,'Hidden measurement'); assert(result.overflow<=0,'Horizontal overflow',result);
  if(negative)assert(result.maxAbsDelta>0,'Negative control did not expose drift',result);
  else assert(result.firstFailure===null&&result.maxTranslate<1,'STOP: strict 0px, top exception, or translate failed',result);
  if(!result.scenario.startsWith('D13'))assert(result.events.filter(e=>e.event.startsWith('gloss_')||e.event.startsWith('sentence_')).length===0,'Unexpected reading event',result.events);
}
async function measured(c,width,label,operation,negative=false,key=null,allowTop=false) {
  await c.evaluate(`window.__g19.begin(${JSON.stringify(label)},${negative},${JSON.stringify(key)},${allowTop})`); await operation(); await settle(c);
  await c.evaluate("new Promise(r=>{let n=0;const tick=()=>{if(window.__g19.trace.stop||++n>=60)r();else requestAnimationFrame(tick)};requestAnimationFrame(tick)})");
  const result=await c.evaluate('window.__g19.end()');checkRow(width,result,negative);return result;
}
async function drag(c,key='fontSize') {
  const r=await evaluate(c,key=>{const prefix=innerWidth<768?'.reader-typography-sheet':'.col-right',el=document.querySelector(`${prefix} input[data-typography="${key}"]`);
    const r=el.getBoundingClientRect();return{x:r.left+8,y:r.top+r.height/2,width:r.width-16};},key);
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x,y:r.y});
  await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:r.x,y:r.y});
  let lastX=r.x;
  for(let i=0;i<=24;i++){if(await c.evaluate('window.__g19.trace?.firstFailure!==null&&window.__g19.trace?.firstFailure!==undefined'))break;
    lastX=r.x+r.width*i/24;await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:lastX,y:r.y});await sleep(25);}
  await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:lastX,y:r.y}); await settle(c);
}
async function samplerSelfCheck(c,width) {
  const result=await evaluate(c,async()=>{const s=window.__g19,ended=[];const frame=()=>new Promise(r=>requestAnimationFrame(r));
    for(let i=0;i<6;i++){s.begin(i%2?'selfcheck-B':'selfcheck-A');await frame();await frame();const trace=s.trace;s.end();const count=trace.frames.length;await frame();ended.push({label:trace.label,before:count,after:trace.frames.length});}
    await frame();return ended;});
  assert(result.every(r=>r.before===r.after),'Sampler callbacks leaked between scenes',result);console.log(JSON.stringify({width,samplerSelfCheck:result}));
}
async function open(c,index) {
  await align(c,index);
  await evaluate(c,index=>{const span=document.querySelector(`.sentence[data-index="${index}"]`),r=span.getClientRects()[0];span.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+1,clientY:r.top+1}));},index); await settle(c);
}
async function save(c,index) {
  await open(c,index); await waitFor(()=>c.evaluate(`!!document.querySelector('.gloss-panel[data-sentence-index="${index}"][data-state="done"]')`),'gloss done');
  await c.evaluate(`document.querySelector('.gloss-panel[data-sentence-index="${index}"] .action-row-save').click()`);await settle(c);
}
async function reload(c) { await c.call('Page.reload');await ready(c); }
async function layoutChecks(c,width) {
  const layout=await evaluate(c,width=>{
    const rect=el=>{const r=el.getBoundingClientRect();return{text:el.textContent,font:getComputedStyle(el).fontSize,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
    const aa=document.querySelector('.reader-typography-aa'),right=document.querySelector('.col-right');
    if(getComputedStyle(document.querySelector('.reader-body')).paddingBottom!==innerHeight+'px')throw Error('Reader 100lvh padding');
    if(width<768){const els=[document.querySelector('.reader-shelf-back'),...document.querySelectorAll('.mode-switch > span,.mode-options button'),document.querySelector('.feedback-button'),aa],boxes=els.map(rect);
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top))throw Error('STOP: top row does not fit '+JSON.stringify({width,boxes,i,j}));}
      if(Math.max(...boxes.map(b=>b.top))-Math.min(...boxes.map(b=>b.top))>2)throw Error('STOP: top row not one row '+JSON.stringify(boxes));
      if(getComputedStyle(right).display!=='none')throw Error('mobile right visible');return boxes;
    }
    if(rect(right).width<200)throw Error('right minimum');if(getComputedStyle(aa).display!=='none')throw Error('desktop Aa visible');return{grid:getComputedStyle(document.querySelector('.shell')).gridTemplateColumns};
  },width);console.log(JSON.stringify({width,layout}));
}
async function checks(c,width) {
  await layoutChecks(c,width);
  await revealControls(c,width);
  await evaluate(c,width=>{const scope=document.querySelector(width<768?'.reader-typography-sheet':'.col-right');
    if(scope.querySelectorAll('input[type=range]').length!==(width<768?2:3))throw Error('range count');
    for(const el of scope.querySelectorAll('input[type=range]'))if(el.nextElementSibling.getBoundingClientRect().top<=el.getBoundingClientRect().bottom)throw Error('band overlaps knob bounds');
    if(width<768&&scope.getBoundingClientRect().height>innerHeight*.5)throw Error('sheet taller than half');
  },width);
  await align(c);
  for(const [key,values] of [['fontSize',[15,21,17.5]],['lineHeight',[1.5,2.1,1.75]],...(width>=768?[['lineChars',[20,45,32]]]:[]),['bodyFont',['serif','sans']],['glossFont',['sans','serif']]]) {
    for(const value of values) await measured(c,width,`empty:${key}=${value}`,()=>change(c,key,value));
  }
  await measured(c,width,'empty:continuous-fontSize',()=>drag(c));
  await measured(c,width,'empty:continuous-lineHeight',()=>drag(c,'lineHeight'));
  if(width>=768)await measured(c,width,'empty:continuous-lineChars',()=>drag(c,'lineChars'));
  await measured(c,width,'empty:keyboard-step',async()=>{
    await evaluate(c,()=>document.querySelector(`${innerWidth<768?'.reader-typography-sheet':'.col-right'} [data-typography="fontSize"]`).focus({preventScroll:true}));
    for(let i=0;i<3;i++){if(await c.evaluate('window.__g19.trace.firstFailure!==null'))break;
      await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
      await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});await sleep(100);}
  });
  await measured(c,width,'reset',async()=>{await evaluate(c,()=>document.querySelector(`${innerWidth<768?'.reader-typography-sheet':'.col-right'} .reader-typography-reset`).click());await settle(c);});
  assert(await c.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`)===JSON.stringify(DEFAULTS),'restore all five');
  if(width<768){await c.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle(c);}
  await save(c,5);await open(c,6);await settle(c);await revealControls(c,width);await align(c,8);
  for(const [key,value] of [['fontSize',19],['lineHeight',1.9],...(width>=768?[['lineChars',25]]:[]),['bodyFont','serif'],['bodyFont','sans'],['glossFont','sans'],['glossFont','serif']]) {
    // A fresh first expansion prevents legitimate elapsed-reading completion from being attributed to a typography operation.
    await reload(c);await open(c,6);await revealControls(c,width);await align(c,8);
    const before=await c.evaluate('window.__g19.glyphs().map(g=>g.char).join("")');
    const panels=await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)");
    const clicked=await c.evaluate('window.__g19.glyphs().find(g=>g.index===6)');
    await measured(c,width,`expanded:${key}=${value}`,()=>change(c,key,value));
    assert(await c.evaluate('window.__g19.glyphs().map(g=>g.char).join("")')===before,'original integrity');
    assert(JSON.stringify(await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)"))===JSON.stringify(panels),'panels retained');
    console.log(JSON.stringify({width,scenario:`clickedGlyphAfter:${key}`,key:clicked.key,dy:(await c.evaluate(`window.__g19.rect(${JSON.stringify(clicked.key)})`)).y-clicked.y,notFailureCriterion:true}));
  }
  // D13 is a separate operation under the newly selected typography.
  if(width<768){await c.evaluate("document.querySelector('.reader-typography-aa').click()");await settle(c);}
  await c.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle(c);await align(c,8);
  await d13Sample(c,width,8,'D13-new-layout');
  await revealControls(c,width);await align(c,11);
  await measured(c,width,'retained:continuous-fontSize',()=>drag(c));
  await change(c,'fontSize',17.5);await reload(c);assert(await c.evaluate("getComputedStyle(document.querySelector('.reader-body')).fontSize")==='17.5px','refresh remembered');
  // Invalid stored values must reject the whole record, not normalize individual fields.
  for(const value of ['{',JSON.stringify({...DEFAULTS,fontSize:'18'}),JSON.stringify({...DEFAULTS,lineChars:33.5})]) {
    await evaluate(c,(key,value)=>localStorage.setItem(key,value),KEY,value);await reload(c);
    assert(await c.evaluate("getComputedStyle(document.querySelector('.reader-body')).fontSize")==='17.5px','invalid setting default');
  }
  await coverageChecks(c,width);
}
async function coverageChecks(c,width) {
  // Collapsed saved glosses must survive reflow too, including bubble presentation.
  for(const shape of ['inline','bubble'])for(const [key,value] of [['bodyFont','serif'],['bodyFont','sans'],['glossFont','sans'],['glossFont','serif']]) {
    await evaluate(c,shape=>{localStorage.setItem('gloss:settings:reading-mode','reading');localStorage.setItem('gloss:settings:gloss-shape',shape);},shape);
    await reload(c);await open(c,5);await open(c,6);await revealControls(c,width);await align(c,8);
    const panels=await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)");
    await measured(c,width,`collapsed-saved:${shape}:${key}=${value}`,()=>change(c,key,value));
    assert(JSON.stringify(await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)"))===JSON.stringify(panels),'expanded saved and temporary retained');
  }
  await c.evaluate("localStorage.setItem('gloss:settings:reading-mode','review');localStorage.setItem('gloss:settings:gloss-shape','inline')");await reload(c);
  await revealControls(c,width);await align(c,11);
  if(width<768){
    for(const kind of ['aa','outside','escape']){
      await revealControls(c,width);const panels=await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)");
      await evaluate(c,kind=>{window.__g19.events=[];if(kind==='aa')document.querySelector('.reader-typography-aa').click();
        else if(kind==='outside')document.querySelector('.reader-body').click();else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));},kind);await settle(c);
      assert(await c.evaluate("!document.querySelector('.reader-typography-sheet')"),'mobile sheet closed '+kind);
      assert(JSON.stringify(await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)"))===JSON.stringify(panels),'closing sheet retains gloss');
      assert(await c.evaluate("document.activeElement===document.querySelector('.reader-typography-aa')"),'focus returned to Aa');
      assert((await c.evaluate('window.__g19.events')).filter(e=>['gloss_abort','gloss_dismiss_early'].includes(e.event)).length===0,'sheet close events');
    }
  }
  const narrow={...DEFAULTS,lineChars:20};await evaluate(c,(key,value)=>localStorage.setItem(key,JSON.stringify(value)),KEY,narrow);await reload(c);
  assert(await c.evaluate("getComputedStyle(document.querySelector('.reader-body')).maxWidth")==='350px','stored hidden lineChars applies');
  await revealControls(c,width);await c.evaluate("document.querySelector(`${innerWidth<768?'.reader-typography-sheet':'.col-right'} .reader-typography-reset`).click()");await settle(c);
  assert(await c.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`)===JSON.stringify(DEFAULTS),'reset restores hidden field');
  await change(c,'fontSize',20);
  await c.call('Page.navigate',{url:ORIGIN+'/read/g19-owned'});
  await waitFor(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'"),'other book');await settle(c);
  assert(await c.evaluate("getComputedStyle(document.querySelector('.reader-body')).fontSize")==='20px','all books share typography');
  await c.evaluate("localStorage.removeItem('gloss:doc:g19-owned')");
  await c.call('Page.navigate',{url:ORIGIN+'/'});
  await waitFor(()=>c.evaluate("!!document.querySelector('.landing-demo-visible')"),'landing demo');await settle(c);
  const landing=await c.evaluate("(()=>{const s=getComputedStyle(document.querySelector('.landing-demo-visible'));return{font:s.fontSize,line:s.lineHeight,max:s.maxWidth,gloss:getComputedStyle(document.querySelector('.landing-demo-measure')).fontFamily,padding:getComputedStyle(document.querySelector('.landing-demo-visible')).paddingBottom}})()");
  assert(landing.padding==='0px','LandingDemo padding unchanged from main',landing);
  assert(landing.font==='17.5px'&&landing.line==='30.625px'&&landing.max==='560px','LandingDemo fallback independent',landing);
  console.log(JSON.stringify({width,coverage:{collapsedSavedBothShapes:true,sheetClosures:width<768?3:0,hiddenLineChars:true,allBooks:true,landingFallback:landing}}));
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
}
async function performanceChecks(c,width) {
  for(const savedCount of [0,3,10]) {
    await c.evaluate(`localStorage.removeItem('gloss:saved:sample');localStorage.removeItem('gloss:explain:sample');localStorage.removeItem(${JSON.stringify(KEY)})`);await reload(c);
    for(let i=0;i<savedCount;i++)await save(c,i);
    await open(c,10);await revealControls(c,width);await align(c,11);
    await measured(c,width,`performance:saved=${savedCount},temporary=1`,()=>drag(c));
  }
}
async function ownedShelfCheck(c,width) {
  await evaluate(c,async()=>{
    const sample=await(await fetch('/samples/shan-yu-e.json')).json();
    localStorage.setItem('gloss:doc:g19-owned',JSON.stringify({version:1,docId:'g19-owned',paragraphs:sample.paragraphs,headings:[],footnotes:[],
      meta:{format:'txt',fileName:'G19验证书.txt',charCount:sample.paragraphs.join('').length},savedAt:1}));
    localStorage.setItem('gloss:structure:g19-owned',JSON.stringify({version:1,prompt:'structure-v1',structure:'本地验证夹具结构。',savedAt:1}));
  });
  await c.call('Page.navigate',{url:ORIGIN+'/read/g19-owned'});await ready(c);
  const result=await evaluate(c,()=>{const col=document.querySelector('.col-left'),available=col.clientWidth-32;
    const elements=[document.querySelector('.reader-shelf-back'),document.querySelector('.mode-label'),...document.querySelectorAll('.mode-option'),document.querySelector('.feedback-button'),document.querySelector('.reader-typography-aa')];
    return{available,boxes:elements.map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent,font:getComputedStyle(el).fontSize,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}})};
  });
  console.log(JSON.stringify({width,ownedShelfLayout:result}));
  assert(result.boxes[0].text==='← 回到书架','Owned document shelf link');
  if(width<768){assert(Math.max(...result.boxes.map(b=>b.top))-Math.min(...result.boxes.map(b=>b.top))<=2,'STOP: owned book top row not one row',result);
    for(let i=0;i<result.boxes.length;i++)for(let j=i+1;j<result.boxes.length;j++){const a=result.boxes[i],b=result.boxes[j];
      assert(Math.min(a.right,b.right)<=Math.max(a.left,b.left)||Math.min(a.bottom,b.bottom)<=Math.max(a.top,b.top),'STOP: owned book top row overlap',{result,i,j});}
    assert(result.boxes.at(-1).right<=documentClientRight(result),'STOP: owned book top overflow',result);
  }
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
}
function documentClientRight(result){return result.available+16;}
async function negativeControl(c,width) {
  await c.evaluate("localStorage.removeItem('gloss:saved:sample');localStorage.removeItem('gloss:settings:reader-typography')");await reload(c);await revealControls(c,width);await align(c);
  await c.evaluate("window.__g19.scrollBy=window.scrollBy;window.__g19.scrollTo=window.scrollTo;window.scrollBy=()=>{};window.scrollTo=()=>{};window.__g19.disable=new MutationObserver(()=>{const b=document.querySelector('.reader-body');if(b.style.translate)b.style.translate=''});window.__g19.disable.observe(document.querySelector('.reader-body'),{attributes:true,attributeFilter:['style']})");
  await measured(c,width,'negative:compensation-disabled',()=>change(c,'fontSize',21),true);
  await c.evaluate('window.__g19.disable.disconnect();window.scrollBy=window.__g19.scrollBy;window.scrollTo=window.__g19.scrollTo');
}
async function d13Sample(c,width,index,label) {
  const glyph=await evaluate(c,index=>window.__g19.glyphs().find(g=>g.index===index&&g.char.trim()),index);
  return measured(c,width,label,()=>evaluate(c,glyph=>{const r=window.__g19.rect(glyph.key),offset=Number(glyph.key.split(':')[1]);
    const span=[...document.querySelectorAll(`.sentence[data-index="${glyph.index}"]`)].find(s=>Number(s.dataset.offset)<=offset&&Number(s.dataset.offset)+s.textContent.length>offset);
    span.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+1,clientY:r.y+1}));},glyph),false,glyph.key);
}
async function fixedRegressions(c,width) {
  if(width!==375)return;
  await c.evaluate("localStorage.removeItem('gloss:saved:sample');localStorage.removeItem('gloss:settings:reader-typography')");await reload(c);
  await save(c,5);await revealControls(c,width);await change(c,'fontSize',19);await change(c,'lineHeight',1.9);await reload(c);
  await open(c,8);await revealControls(c,width);await align(c,11);
  await measured(c,width,'fixed:retained-continuous-fontSize',()=>drag(c));
  await change(c,'fontSize',19);await align(c,11);
  for(const font of ['serif','sans'])await measured(c,width,'fixed:retained-bodyFont='+font,()=>change(c,'bodyFont',font));
}
async function boundaryChecks(c,width) {
  if(width!==375&&width!==1280)return;
  await c.evaluate("localStorage.removeItem('gloss:saved:sample');localStorage.removeItem('gloss:settings:reader-typography')");await reload(c);await revealControls(c,width);
  const last=await c.evaluate("(()=>{const g=window.__g19.glyphs();const para=Math.max(...g.map(x=>Number(x.key.split(':')[0])));return g.find(x=>x.key.startsWith(para+':')).index})()");
  await align(c,last);
  await measured(c,width,'book-end:fontSize-drag',()=>drag(c));
  await measured(c,width,'book-end:lineHeight-drag',()=>drag(c,'lineHeight'));
  for(const [key,font] of [['bodyFont','serif'],['bodyFont','sans'],['glossFont','sans'],['glossFont','serif']])await measured(c,width,'book-end:'+key+'='+font,()=>change(c,key,font));
  if(width<768){await c.evaluate("document.querySelector('.reader-typography-aa').click()");await settle(c);}
  await save(c,last);await align(c,last+1);await d13Sample(c,width,last+1,'D13-book-end-saved');
  const high={...DEFAULTS,fontSize:21,lineHeight:2.1};
  await evaluate(c,(key,value)=>{localStorage.removeItem('gloss:saved:sample');localStorage.setItem(key,JSON.stringify(value));},KEY,high);await reload(c);await revealControls(c,width);
  await c.evaluate("window.scrollTo({top:0,behavior:'instant'})");await settle(c);
  await measured(c,width,'book-start:fontSize-21-to-15',()=>change(c,'fontSize',15),false,null,true);
  await c.evaluate("window.scrollTo({top:0,behavior:'instant'})");await settle(c);
  await measured(c,width,'book-start:lineHeight-2.1-to-1.5',()=>change(c,'lineHeight',1.5),false,null,true);
}

async function actualOwnedImport(c,width) {
  await c.call('Page.navigate',{url:ORIGIN+'/'});await waitFor(()=>c.evaluate("!!document.querySelector('.landing-secondary')"),'import entry');
  await c.evaluate("(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('gloss:doc:')){const id=key.slice(10);set.call(this,'gloss:structure:'+id,JSON.stringify({version:1,prompt:'structure-v1',structure:'本地导入夹具结构。',savedAt:Date.now()}));window.__g19.importedId=id;}return set.call(this,key,value);};document.querySelector('.landing-secondary').click();})()");
  await waitFor(()=>c.evaluate("!!document.querySelector('input[type=file]')"),'file input');await c.call('DOM.enable');
  const doc=await c.call('DOM.getDocument'),input=await c.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});
  await c.call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[resolve('C:/Users/23750/projects/gloss/test-fixtures/政治经济学批判-序言.docx')]});
  await waitFor(()=>c.evaluate("(()=>{if(location.pathname.startsWith('/read/'))return true;const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始阅读');b?.click();return false;})()"),'imported reader');await ready(c);
  const result=await c.evaluate("(()=>{const col=document.querySelector('.col-left');return{available:col.clientWidth-32,boxes:[document.querySelector('.reader-shelf-back'),document.querySelector('.mode-label'),...document.querySelectorAll('.mode-option'),document.querySelector('.feedback-button'),document.querySelector('.reader-typography-aa')].map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent,font:getComputedStyle(el).fontSize,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}}),imported:JSON.parse(localStorage.getItem('gloss:doc:'+location.pathname.split('/').at(-1))).meta.fileName}})()");
  assert(result.imported==='政治经济学批判-序言.docx','Real fixture imported',result);assert(result.boxes[0].text==='← 回到书架','Actual own book shelf link');
  assert(Math.max(...result.boxes.map(b=>b.top))-Math.min(...result.boxes.map(b=>b.top))<=2,'STOP: actual own book top row not one row',result);
  for(let i=0;i<result.boxes.length;i++)for(let j=i+1;j<result.boxes.length;j++){const a=result.boxes[i],b=result.boxes[j];assert(Math.min(a.right,b.right)<=Math.max(a.left,b.left)||Math.min(a.bottom,b.bottom)<=Math.max(a.top,b.top),'STOP: actual own book top overlap',{result,i,j});}
  assert(result.boxes.at(-1).right<=result.available+16,'STOP: actual own book top overflow',result);console.log(JSON.stringify({width,actualOwnedImport:result}));
}

async function performanceHarness(c,profile) {
  const mode=process.env.G19_PERF_MODE;
  if(mode==='populate') {
    await c.call('Page.navigate',{url:ORIGIN+'/'});await waitFor(()=>c.evaluate("!!document.querySelector('.landing-secondary')"),'performance import');
    await c.evaluate("(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('gloss:doc:')){const id=key.slice(10);set.call(this,'gloss:structure:'+id,JSON.stringify({version:1,prompt:'structure-v1',structure:'本地性能夹具结构。',savedAt:Date.now()}));set.call(this,'gloss:g19-perf:doc',id);}return set.call(this,key,value);};document.querySelector('.landing-secondary').click();})()");
    await waitFor(()=>c.evaluate("!!document.querySelector('input[type=file]')"),'performance file input');await c.call('DOM.enable');
    const doc=await c.call('DOM.getDocument'),input=await c.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});
    await c.call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[join(tmpdir(),'gloss-preface-perf.txt')]});
    await waitFor(()=>c.evaluate("(()=>{if(location.pathname.startsWith('/read/'))return true;[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始阅读')?.click();return false;})()"),'performance reader');await ready(c);
    const metadata=await c.evaluate("(()=>{const id=localStorage.getItem('gloss:g19-perf:doc'),doc=JSON.parse(localStorage.getItem('gloss:doc:'+id));const index=Number([...document.querySelectorAll('[data-para=\"1\"] .sentence')].at(-1).dataset.index);localStorage.setItem('gloss:g19-perf:index',String(index));return{id,index,paragraphs:doc.paragraphs.length,sentences:document.querySelectorAll('.sentence').length}})()");
    assert(metadata.paragraphs===450,'Same 450 paragraph sample',metadata);await evaluate(c,index=>{const s=document.querySelector(`.sentence[data-index="${index}"]`);s.scrollIntoView({block:'center',behavior:'instant'});s.click();},metadata.index);
    await waitFor(()=>c.evaluate(`document.querySelector('.gloss-panel[data-sentence-index="${metadata.index}"]')?.dataset.state==='done'&&document.querySelector('.gloss-panel[data-sentence-index="${metadata.index}"] .gloss-panel-text')?.textContent.length>=148`),'complete local mock answer');
    await waitFor(()=>c.evaluate("new Promise((r,j)=>{const o=indexedDB.open('gloss-auto-cache',1);o.onerror=()=>j(Error('cache'));o.onsuccess=()=>{const db=o.result,req=db.transaction('ai-gloss-auto-cache','readonly').objectStore('ai-gloss-auto-cache').count();req.onsuccess=()=>{r(req.result);db.close();};};})"),'cache entry');
    const count=await c.evaluate("new Promise(r=>{const o=indexedDB.open('gloss-auto-cache',1);o.onsuccess=()=>{const db=o.result,req=db.transaction('ai-gloss-auto-cache','readonly').objectStore('ai-gloss-auto-cache').count();req.onsuccess=()=>{r(req.result);db.close();};};})");
    console.log(JSON.stringify({performancePopulation:{profile,origin:ORIGIN,...metadata,cacheEntries:count}}));return;
  }
  const id=await c.evaluate("localStorage.getItem('gloss:g19-perf:doc')");assert(id,'Persistent performance document');
  await c.call('Page.navigate',{url:ORIGIN+'/read/'+id});await ready(c);
  await waitFor(()=>c.evaluate("performance.getEntriesByName('gloss:preload:end').length>0"),'cross-session preload');
  await c.evaluate(await readFile(resolve('C:/Users/23750/projects/gloss/scripts/perf/page-measure.js'),'utf8'));
  const preload=await c.evaluate('window.__glossPerf.preload()'),index=await c.evaluate("Number(localStorage.getItem('gloss:g19-perf:index'))"),samples=[];
  for(let i=0;i<43;i++) {
    await c.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle(c);
    await evaluate(c,index=>document.querySelector(`.sentence[data-index="${index}"]`).scrollIntoView({block:'center',behavior:'instant'}),index);await settle(c);
    const sample=await c.evaluate(`window.__glossPerf.click(${index})`);
    await waitFor(()=>c.evaluate(`document.querySelector('.gloss-panel[data-sentence-index="${index}"]')?.dataset.state==='done'&&document.querySelector('.gloss-panel[data-sentence-index="${index}"] .gloss-panel-text')?.textContent.length>=148`),'complete cached mock answer');
    if(i>=3)samples.push(sample);
  }
  const summary=await evaluate(c,samples=>window.__glossPerf.summarize(samples),samples);
  console.log(JSON.stringify({performance:{label:process.env.G19_PERF_LABEL,profile,origin:ORIGIN,condition:'cross-session-cache-hit',warmups:3,preload,...summary,samples}}));
  assert(JSON.stringify(summary.rerenderDistribution)===JSON.stringify({'1':40}),'Performance paragraph distribution',summary);assert(preload.rerenderedParagraphs===0,'Preload paragraph count',preload);
}

async function run(width) {
  const persistent=!!process.env.G19_PERF_MODE,profile=persistent?(process.env.G19_PERF_PROFILE??await mkdtemp(join(tmpdir(),'gloss-g19-perf-'))):await mkdtemp(join(tmpdir(),'gloss-g19-edge-')),port=await freePort();
  if(persistent)console.log(JSON.stringify({performanceProfile:{profile,origin:ORIGIN}}));
  assert(resolve(profile).startsWith(resolve(tmpdir(),persistent?'gloss-g19-perf-':'gloss-g19-edge-')),'Safe browser profile');
  const edge=spawn(EDGE,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let c;const api=[];
  try {
    let target;await waitFor(async()=>{const r=await fetch('http://127.0.0.1:'+port+'/json').catch(()=>null);if(!r)return false;target=(await r.json()).find(t=>t.type==='page');return!!target;},'Edge');
    c=new Cdp(target.webSocketDebuggerUrl);c.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))api.push(m.params.request.url);});
    await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${setup.toString()})();`});await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
    if(process.env.G19_LAYOUT_ONLY==='1'){await layoutChecks(c,width);await ownedShelfCheck(c,width);}
    else if(process.env.G19_PERF_MODE)await performanceHarness(c,profile);
    else if(process.env.G19_OWNED_IMPORT==='1')await actualOwnedImport(c,width);
    else if(process.env.G19_NEGATIVE_CONTROL==='1')await negativeControl(c,width);
    else if(process.env.G19_BASELINE_LANDING==='1') {
      await c.call('Page.navigate',{url:ORIGIN+'/'});await waitFor(()=>c.evaluate("!!document.querySelector('.landing-demo-visible')"),'main LandingDemo');await settle(c);
      const padding=await c.evaluate("(()=>{const b=document.querySelector('.landing-demo-visible');return{paddingBottom:getComputedStyle(b).paddingBottom,readerSpecificClass:b.classList.contains('reader-body-reader')}})()");
      assert(padding.paddingBottom==='0px'&&!padding.readerSpecificClass,'Main LandingDemo padding',padding);console.log(JSON.stringify({width,baselineLandingPadding:padding}));
    } else {await samplerSelfCheck(c,width);await ownedShelfCheck(c,width);await checks(c,width);await fixedRegressions(c,width);await boundaryChecks(c,width);if(width===375||width===1280)await performanceChecks(c,width);}
    if(process.env.G19_PERF_MODE!=='populate')assert(api.length===0,'Zero /api/ requests',api);console.log(JSON.stringify({width,apiRequests:api.length,passed:true}));
  } catch (error) {
    console.log(JSON.stringify({width,stopped:true,apiRequests:api.length,error:error.message}));
    throw error;
  } finally {
    c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);
    const absolute=resolve(profile);assert(absolute.startsWith(resolve(tmpdir(),persistent?'gloss-g19-perf-':'gloss-g19-edge-')),'Safe cleanup');if(!persistent)await rm(absolute,{recursive:true,force:true});
  }
}
if(process.env.G19_PERF_MODE||process.env.G19_NEGATIVE_CONTROL==='1')await run(1280);else for(const width of WIDTHS)await run(width);
console.log('G-19 typography checks passed');
