import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ORIGIN = process.env.G62_ORIGIN ?? "http://127.0.0.1:3466";
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

const WIDTHS = [375, 506, 768, 1024, 1280, 1920];
// Independent expected output; changing the demo constant alone cannot make this check pass.
const EXPECTED_EXPLANATION = "作者在这里不是要证明无产阶级道德说本身绝对正确，而是先限定立场：只有站在劳动群众一边，才能把它判为现时最正确的标准。这个“只能”把判断权从普遍真理挪到阶级观点上，正好呼应全文否定绝对善恶的结论。破折号里的“促进社会进化”是给出取舍尺度，说明正确与否只看是否推动进化，而不是看它是否永久不变。";
function pageSetup() {
  localStorage.setItem('gloss:analytics:optout', '1');
  window.__g62 = {frames:[], commits:[], hidden:document.hidden, armed:false, firstVisible:null};
  addEventListener('visibilitychange', () => { if(document.hidden) window.__g62.hidden=true; });
  const rect = el => {
    if(!el)return null; const r=el.getBoundingClientRect();
    return {x:r.left,y:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
  };
  function glyphs(scope) {
    const chars=[];
    if(!scope)return chars;
    for(const span of scope.querySelectorAll('.sentence')) {
      const walker=document.createTreeWalker(span,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode;let offset=0;
        for(const char of node.data) {
          const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+char.length);
          chars.push({char,index:Number(span.dataset.index),offset:Number(span.dataset.offset)+offset,...rect(range)});
          offset+=char.length;
        }
      }
    }
    return chars;
  }
  function sample() {
    const visible=document.querySelector('.landing-demo-visible');
    if(!visible)return null;
    const measuring=document.querySelector('.landing-demo-measure .landing-demo-body');
    if(!measuring)throw Error('G-66 missing landing measuring body');
    const properties=['fontFamily','fontSize','lineHeight','letterSpacing','textAlign','textIndent','color','wordBreak','lineBreak','maxWidth'];
    const measuredStyle=getComputedStyle(measuring),visibleStyle=getComputedStyle(visible);
    for(const property of properties)if(measuredStyle[property]!==visibleStyle[property])throw Error('G-66 landing style differs: '+property);
    if(measuring.getBoundingClientRect().width!==visible.getBoundingClientRect().width||measuring.getBoundingClientRect().left!==visible.getBoundingClientRect().left)throw Error('G-66 landing measuring width/left differs');
    const pointer=document.querySelector('.landing-demo-pointer');
    const phase=pointer?.className.split(' ').find(c=>c.startsWith('landing-demo-pointer-'))?.replace('landing-demo-pointer-','')??null;
    const allLists=[...document.querySelectorAll('.landing-steps > ol,.landing-demo-steps')];
    const lists=allLists.filter(el=>{
      const box=rect(el),style=getComputedStyle(el);
      return style.display!=='none'&&style.visibility==='visible'&&box.width>0&&box.height>0;
    });
    const list=lists[0];
    const steps=[...(list?.querySelectorAll('li')??[])].map(el=>({rect:rect(el),current:el.classList.contains('landing-step-current')||el.classList.contains('landing-demo-step-current'),ariaCurrent:el.getAttribute('aria-current'),completed:el.classList.contains('landing-step-completed')||el.classList.contains('landing-demo-step-completed')}));
    const selectors=['.landing-header .wordmark','.landing-copy h1','.landing-subtitle','.landing-steps','.landing-actions','.landing-primary','.landing-secondary','.landing-secondary-group small','.landing-supplement','.landing-demo-header','.landing-demo-header small','.landing-demo-header button','.landing-feedback .feedback-button','.landing-demonstration'];
    const narrow=innerWidth<960;
    const references=narrow?selectors.filter(selector=>selector!=='.landing-steps'):selectors;
    const elements=references.map(selector=>({selector,rect:rect(document.querySelector(selector))}));
    const parts=narrow?document.querySelectorAll('.landing-demo-step'):document.querySelectorAll('.landing-step,.landing-step-question,.landing-step-answer');
    for(const [index,el] of [...parts].entries())elements.push({selector:'step-part-'+index,rect:rect(el)});
    const glyph=glyphs(visible),tail=glyphs(visible.querySelector('.reader-para-cont')).filter(c=>c.char.trim()).at(-1);
    const explain=document.querySelector('.explain-result-text');
    const button=document.querySelector('.landing-demo-visible .action-row-explain');
    const actions=document.querySelector('.landing-demo-visible .action-row');
    const cs=getComputedStyle(document.documentElement);
    return {t:performance.now(),phase,opacity:pointer?Number(getComputedStyle(pointer).opacity):null,replayStage:pointer?.className.split(" ").find(c=>c.startsWith("landing-demo-pointer-replay-"))??null,pointer:rect(pointer),button:rect(button),explainHidden:button?.getAttribute('aria-hidden'),explainDisabled:button?.getAttribute('aria-disabled'),steps,listCount:lists.length,totalLists:allLists.length,compact:rect(document.querySelector('.landing-demo-steps')),viewport:{width:document.documentElement.clientWidth,height:innerHeight},elements,glyph,target:glyph.find(c=>c.index===10),tail,stage:rect(document.querySelector('.landing-demo-stage')),card:rect(document.querySelector('.landing-demonstration')),canvas:rect(document.querySelector('.landing-demo-canvas')),scrollY,scrollX,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,bodyOverflow:document.body.scrollWidth-document.documentElement.clientWidth,gutter:cs.scrollbarGutter,gloss:document.querySelector('.landing-demo-visible .gloss-panel-text')?.textContent??'',explain:explain?.textContent??'',pending:document.querySelector('.explain-result-pending')?.textContent??'',buttons:[...document.querySelectorAll('.landing-demo-panel-play button')].map(b=>({text:b.textContent,inert:!!b.closest('[inert]')})),animations:[...document.querySelectorAll('.landing-steps,.landing-steps *,.landing-demo-steps,.landing-demo-steps *,.landing-demo-stage,.landing-demo-stage *')].flatMap(el=>el.getAnimations()).filter(a=>a.playState==='running').length,actionVisible:actions?getComputedStyle(actions).display!=='none':false,saveDisabled:document.querySelector('.landing-demo-visible .action-row-save')?.disabled};
  }
  window.__g62.sample=sample;
  const observer=new MutationObserver(()=>{
    const frame=sample();
    if(frame && window.__g62.armed)window.__g62.commits.push({phase:frame.phase,steps:frame.steps});
  });
  observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  function frame() {
    const state=sample();
    if(state && !window.__g62.firstVisible)window.__g62.firstVisible=state;
    if(state && window.__g62.armed)window.__g62.frames.push(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function check(condition,label,width,run,detail) {
  if(!condition)throw Error(JSON.stringify({assertion:label,width,run,detail}));
}
function metrics(frames,width,run,commits) {
  check(frames.length>2,'sampling',width,run,frames.length);
  const first=frames[0];let a=0,b=0,d=0,e=0,e2=0;let c=false,pending=false;
  let frozen=null,explainDone=false,hadMoving=false,hadExplainMoving=false;
  const original=first.glyph.map(c=>c.char).join('');
  let previous=null;
  let stepsHeightDelta=0,minStepsHeight=first.compact.height,maxStepsHeight=first.compact.height;
  const inViewport=(r,v)=>!!r&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=v.width&&r.bottom<=v.height;
  for(const frame of frames) {
    check(frame.totalLists===2&&frame.listCount===1&&frame.steps.length===2,'one visible steps list',width,run,frame);
    check(frame.steps.every(step=>(step.ariaCurrent==='step')===step.current),'step aria-current agrees with class',width,run,frame.steps);
    if(width<960) {
      minStepsHeight=Math.min(minStepsHeight,frame.compact.height);maxStepsHeight=Math.max(maxStepsHeight,frame.compact.height);
      stepsHeightDelta=maxStepsHeight-minStepsHeight;
      check(stepsHeightDelta<.5,'compact steps height',width,run,{before:first.compact,after:frame.compact,stepsHeightDelta});
      if(frame.phase==='moving'&&!hadMoving)check(inViewport(frame.steps[0].rect,frame.viewport)&&inViewport(frame.target,frame.viewport),'moving first frame in viewport',width,run,{phase:frame.phase,current:frame.steps[0].rect,target:frame.target,viewport:frame.viewport});
      if(frame.phase==='explain-clicking'&&!frozen)check(inViewport(frame.steps[1].rect,frame.viewport)&&inViewport(frame.button,frame.viewport),'explain-clicking first frame in viewport',width,run,{phase:frame.phase,current:frame.steps[1].rect,button:frame.button,viewport:frame.viewport});
    }
    for(let i=0;i<first.elements.length;i++) {
      const before=first.elements[i],after=frame.elements[i];
      check(before.rect&&after.rect,'missing reference',width,run,before.selector);
      const delta=Math.abs(after.rect.y-before.rect.y);a=Math.max(a,delta);
      check(delta<.5,'a',width,run,{element:before.selector,delta,gutter:frame.gutter});
    }
    check(first.target&&frame.target,'missing target',width,run);
    const delta=Math.max(Math.abs(first.target.x-frame.target.x),Math.abs(first.target.y-frame.target.y));b=Math.max(b,delta);
    check(delta<.5,'b',width,run,{delta,gutter:frame.gutter});
    check(frame.overflow<=0&&frame.bodyOverflow<=0,'i',width,run,{overflow:frame.overflow,bodyOverflow:frame.bodyOverflow});
    check(frame.scrollY===first.scrollY&&frame.scrollX===first.scrollX,'scroll moved during playback',width,run,{before:first.scrollY,after:frame.scrollY});
    check(frame.glyph.map(c=>c.char).join('')===original,'original integrity',width,run);
    if(frame.phase==='moving')hadMoving=true;
    if(frame.phase==='explain-moving')hadExplainMoving=true;
    if(frame.phase==='moving')check(frame.steps[0].current&&!frame.steps[1].current,'g step 1',width,run);
    if(frame.phase==='explain-moving')check(frame.steps[1].current&&frame.steps[0].completed,'g step 2',width,run);
    if(frame.phase==='explain-clicking'&&!frozen) {
      const p=frame.pointer,r=frame.button;
      c=p.x>=r.x&&p.x<=r.right&&p.y>=r.y&&p.y<=r.bottom;
      check(c,'c',width,run,{pointer:p,button:r});frozen=p;
    }
    if(frozen&&!explainDone) {
      const delta=Math.max(Math.abs(frame.pointer.x-frozen.x),Math.abs(frame.pointer.y-frozen.y));d=Math.max(d,delta);
      check(delta<.5,'d',width,run,{delta,phase:frame.phase});
      if(frame.explain===EXPECTED_EXPLANATION)explainDone=true;
    }
    if(frame.pending==='……')pending=true;
    if(previous&&previous.pointer&&frame.pointer) {
      const distance=Math.hypot(frame.pointer.x-previous.pointer.x,frame.pointer.y-previous.pointer.y);
      const detail={distance,elapsed:frame.t-previous.t,fromPhase:previous.phase,toPhase:frame.phase,from:previous.pointer,to:frame.pointer,fromOpacity:previous.opacity,toOpacity:frame.opacity};
      if(previous.opacity>0&&frame.opacity>0) { e=Math.max(e,distance); check(distance<=40,'e',width,run,detail); }
      if(distance>40) { e2++; check(previous.opacity===0&&frame.opacity===0,'e2',width,run,detail); }
      check(frame.t-previous.t<=100,'sampling gap',width,run,frame.t-previous.t);
    }
    previous=frame;
  }
  for(const commit of commits) {
    if(commit.phase==='moving')check(commit.steps[0].current&&!commit.steps[1].current,'g commit 1',width,run,commit);
    if(commit.phase==='explain-moving')check(commit.steps[1].current&&commit.steps[0].completed,'g commit 2',width,run,commit);
  }
  check(hadMoving&&hadExplainMoving,'g missing phases',width,run);
  check(c&&frozen&&explainDone&&pending,'missing required stages',width,run,{c,explainDone,pending});
  const final=frames.at(-1),p=final.pointer,last=final.tail,stage=final.stage;
  check(last&&p,'f missing endpoint',width,run);
  const fx=p.x-last.right,fy=p.y-last.y;
  check(fx>=0&&fx<=24&&p.y>=last.y&&p.y<=last.bottom&&p.x>=stage.x&&p.y>=stage.y&&p.right<=stage.right&&p.bottom<=stage.bottom,'f',width,run,{fx,fy,pointer:p,last,stage});
  check(final.explain===EXPECTED_EXPLANATION&&final.explainDisabled==='true','h',width,run);
  check(final.buttons.length===2&&final.buttons.every(b=>b.inert)&&final.buttons.map(b=>b.text).join('|')==='留下|听不懂','inert buttons',width,run);
  const phaseTimes=new Map();for(const frame of frames)if(!phaseTimes.has(frame.phase))phaseTimes.set(frame.phase,frame.t);
  for(const [phase,next,duration] of [['moving','clicking',650],['clicking','revealing',180],['gloss-ready','explain-moving',1600],['explain-moving','explain-clicking',700],['explain-clicking','explain-pending',260],['explain-pending','explain-revealing',700],['explain-complete','settled',600]]) {
    check(phaseTimes.has(phase)&&phaseTimes.has(next),'missing timing phase',width,run,{phase,next});
    const elapsed=phaseTimes.get(next)-phaseTimes.get(phase);
    check(elapsed>=duration-40&&elapsed<=duration+100,'phase duration',width,run,{phase,elapsed,duration});
  }
  let oldText='';for(const frame of frames)if(frame.explain!==oldText) {
    check(frame.explain.startsWith(oldText)&&EXPECTED_EXPLANATION.startsWith(frame.explain),'explain prefix',width,run);
    const added=Array.from(frame.explain).length-Array.from(oldText).length;
    check(added===4||frame.explain===EXPECTED_EXPLANATION&&added>0&&added<=4,'explain chunk',width,run,added);oldText=frame.explain;
  }
  check(e2===(run==='replay'?1:0),'e2 reset count',width,run,e2);
  return {run,a,b,c,d,e,e2,f:{x:fx,y:fy},g:true,h:true,i:true,oneVisible:true,...(width<960?{viewportMoving:true,viewportExplain:true,stepsHeightDelta}:{})};
}
async function waitFinal(cdp) {
  await waitForValue(()=>cdp.evaluate("(()=>{const f=window.__g62.sample();if(!f||f.phase!=='settled')return false;const frames=window.__g62.frames;if(frames.at(-1)?.phase!=='settled')return false;const start=frames.findLast((f,i)=>f.phase==='settled'&&frames[i-1]?.phase!=='settled');return start&&f.t-start.t>=1250;})()"),'G-62 settled movement');
}
async function clickReplay(cdp) {
  const point=await cdp.evaluate("(()=>{const r=document.querySelector('.landing-demo-header button').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()");
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
}
async function run(width,reduce=false) {
  const profile=await mkdtemp(join(tmpdir(),'gloss-g62-')),port=await freePort();browserStartedAt=performance.now();
  const edge=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let cdp,browser;const api=[];
  try {
    const target=await waitForValue(async()=>{const response=await fetch('http://127.0.0.1:'+port+'/json');return(await response.json()).find(t=>t.type==='page');},'Edge CDP');
    const version=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();
    cdp=new Cdp(target.webSocketDebuggerUrl);browser=new Cdp(version.webSocketDebuggerUrl);
    cdp.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))api.push(m.params.request.url);});
    await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Network.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:width<960&&!reduce?1:width<960?812:900,deviceScaleFactor:1,mobile:false});
    await cdp.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduce?'reduce':'no-preference'}]});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:'('+pageSetup.toString()+')();'});
    await assertSinglePage(browser,target.id,'start:single-page');
    await navigate(cdp,ORIGIN+'/');
    await waitForValue(()=>cdp.evaluate('!!window.__g62.firstVisible'),'first visible demo frame');
    await cdp.evaluate('document.fonts.ready',true);
    let spacerHeight=0;
    if(width<960) {
      // A 1px navigation viewport keeps the native 50% observer below threshold.
      // Only the measured run uses 812px; no product timer or observer is replaced.
      await cdp.evaluate(`(()=>{
        const spacer=document.createElement('div');spacer.setAttribute('aria-hidden','true');spacer.dataset.g62Spacer='true';
        spacer.style.cssText='height:0;margin:0;padding:0;border:0;pointer-events:none';document.body.append(spacer);
        const card=document.querySelector('.landing-demonstration'),top=card.getBoundingClientRect().top+scrollY;
        spacer.style.height=Math.max(0,Math.ceil(top+812-document.documentElement.scrollHeight))+'px';
        window.scrollTo({top,behavior:'instant'});
      })()`);
      await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:false});
      spacerHeight=await cdp.evaluate(`(()=>{
        const spacer=document.querySelector('[data-g62-spacer]');spacer.style.height='0px';
        const card=document.querySelector('.landing-demonstration'),top=card.getBoundingClientRect().top+scrollY;
        const height=Math.max(0,Math.ceil(top+innerHeight-document.documentElement.scrollHeight));spacer.style.height=height+'px';
        window.scrollTo({top,behavior:'instant'});return height;
      })()`);
      const prepared=await cdp.evaluate('window.__g62.sample()');
      check(Math.abs(prepared.card.y)<.5,'card top aligned before playback',width,reduce?'reduce':'first',prepared.card);
      if(!reduce)check((prepared.phase===null||prepared.phase==='waiting')&&prepared.steps.every(step=>!step.current),'prepared before moving',width,'first',prepared);
    }
    if(reduce) {
      const first=await cdp.evaluate('window.__g62.firstVisible');
      check(first.totalLists===2&&first.listCount===1&&first.steps.length===2,'one visible steps list',width,'reduce',first);
      check(!first.pointer&&first.gloss.length>0&&first.explain===EXPECTED_EXPLANATION&&first.steps[1].current&&first.buttons.length===2&&first.buttons.every(b=>b.inert)&&first.animations===0,'k',width,'reduce',first);
      await clickReplay(cdp);
      const final=await cdp.evaluate('window.__g62.sample()');
      check(final.totalLists===2&&final.listCount===1&&final.steps.length===2,'one visible steps list',width,'reduce replay',final);
      if(width<960)check(Math.abs(final.compact.height-first.compact.height)<.5,'compact steps height reduce',width,'reduce',{first:first.compact,final:final.compact});
      check(!final.pointer&&final.explain===EXPECTED_EXPLANATION&&final.steps[1].current&&final.animations===0,'k replay',width,'reduce');
      check(final.overflow<=0&&final.bodyOverflow<=0,'i reduce',width,'reduce');
      check(!await cdp.evaluate('document.hidden||window.__g62.hidden'),'hidden reduce',width,'reduce');
      check(api.length===0,'j',width,'reduce',api);
      await assertSinglePage(browser,target.id,'reduce:single-page');
      return {k:true,j:api.length,spacerHeight};
    }
    if(width>=960)await cdp.evaluate("(()=>{const stage=document.querySelector('.landing-demo-stage');window.scrollTo({top:stage.getBoundingClientRect().top+scrollY-20,behavior:'instant'});})()");
    await cdp.evaluate("window.__g62.frames=[];window.__g62.commits=[];window.__g62.armed=true");
    const geometry=await cdp.evaluate("(()=>{const copy=document.querySelector('.landing-copy').getBoundingClientRect(),card=document.querySelector('.landing-demonstration').getBoundingClientRect(),layout=getComputedStyle(document.querySelector('.landing-layout')),page=getComputedStyle(document.querySelector('.landing-page'));return{copy:{x:copy.x,y:copy.y,right:copy.right,width:copy.width},card:{x:card.x,y:card.y,width:card.width},gap:parseFloat(layout.columnGap),padding:parseFloat(getComputedStyle(document.querySelector('.landing-copy')).paddingTop),left:page.paddingLeft,right:page.paddingRight,gutter:getComputedStyle(document.documentElement).scrollbarGutter};})()");
    check(geometry.gutter==='stable'&&geometry.left==='20px'&&geometry.right==='20px','layout gutter and margins',width,'first',geometry);
    if(width>=960)check(Math.abs(geometry.copy.y-geometry.card.y)<.5&&Math.abs(geometry.card.x-geometry.copy.right-56)<.5&&Math.abs(geometry.copy.width/geometry.card.width-.9/1.1)<.01&&geometry.padding===56,'two columns',width,'first',geometry);
    else check(geometry.card.y>geometry.copy.y,'single column',width,'first',geometry);
    await waitFinal(cdp);
    await assertSinglePage(browser,target.id,'first:single-page');
    const first=await cdp.evaluate('({frames:window.__g62.frames,commits:window.__g62.commits})');
    const firstMetrics=metrics(first.frames,width,'first',first.commits);
    // Arm before the real replay click so its return movement is sampled too.
    await cdp.evaluate('window.__g62.frames=[];window.__g62.commits=[]');
    await clickReplay(cdp);
    await waitForValue(()=>cdp.evaluate("window.__g62.frames.some(f=>f.phase==='waiting')"),'replay reset');
    const reset=await cdp.evaluate('window.__g62.frames.find(f=>f.phase===\'waiting\')');
    check(reset.steps.every(s=>!s.current)&&reset.explain===''&&reset.buttons.length===0,'replay reset state',width,'replay');
    await waitFinal(cdp);
    const replay=await cdp.evaluate('({frames:window.__g62.frames,commits:window.__g62.commits})');
    // The baseline is the restored complete paragraph, including the initial pointer return.
    const start=replay.frames.findIndex(f=>f.phase==='waiting');
    const replayMetrics=metrics(replay.frames.slice(start),width,'replay',replay.commits);
    // Real pointer events and keyboard navigation cannot activate inert demo controls.
    const storage=await cdp.evaluate('JSON.stringify({...localStorage})');
    const state=await cdp.evaluate('window.__g62.sample()');
    for(const selector of ['.action-row-save','.action-row-explain']) {
      const point=await cdp.evaluate(`(()=>{const r=document.querySelector('.landing-demo-visible ${selector}').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    await cdp.evaluate('document.activeElement?.blur()');
    for(let n=0;n<6;n++) {
      await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      check(!await cdp.evaluate("!!document.activeElement?.closest('.landing-demo-panel-play')"),'inert tab',width,'replay');
    }
    check(await cdp.evaluate('JSON.stringify({...localStorage})')===storage,'inert storage',width,'replay');
    check(await cdp.evaluate('window.__g62.sample().explain')===state.explain,'inert state',width,'replay');
    check(!await cdp.evaluate('document.hidden||window.__g62.hidden'),'hidden',width,'all');
    check(api.length===0,'j',width,'all',api);
    await assertSinglePage(browser,target.id,'finish:single-page');
    return {first:firstMetrics,replay:replayMetrics,j:api.length,spacerHeight};
  } finally {
    cdp?.close();browser?.close();edge.kill();
    if(edge.exitCode===null)await Promise.race([new Promise(done=>edge.once('exit',done)),sleep(5000)]);
    const resolved=resolve(profile);if(!resolved.startsWith(resolve(tmpdir(),'gloss-g62-')))throw Error('Unexpected profile');
    await rm(resolved,{recursive:true,force:true}).catch(error=>console.warn('Profile cleanup: '+error.code));
  }
}
for(const width of WIDTHS) {
  const normal=await run(width),reduced=await run(width,true);
  console.log(JSON.stringify({width,...normal,k:reduced.k,reducedSpacerHeight:reduced.spacerHeight,verificationOptout:true}));
}
console.log('G-62 checks passed');
