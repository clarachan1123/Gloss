/** G-67 production checks: real IntersectionObserver, isolated profiles, no API requests. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const { Cdp, setup, ready, freePort, settle, revealControls, align, open, save, evaluate, measured, drag, change }=await import('./verify-g19.mjs');
const ORIGIN=process.env.G67_ORIGIN??'http://127.0.0.1:3469';
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const THEMES=['parchment','moon-white','eye-green'];
const assert=(value,label,detail)=>{if(!value)throw Error(label+': '+JSON.stringify(detail));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('Timeout: '+label);}
const frames=(c,n=60)=>evaluate(c,n=>new Promise(resolve=>{let i=0;function tick(){if(++i>=n)resolve();else requestAnimationFrame(tick);}requestAnimationFrame(tick);}),n);
async function assertFields(c){
  const state=await c.evaluate("(()=>{const b=document.querySelector('.reader-typography-floating-aa');return{exists:!!b,disabledType:typeof b?.disabled,visibleType:typeof b?.dataset.visible,visible:b?.dataset.visible}})()");
  assert(state.exists,'Missing .reader-typography-floating-aa',state);
  assert(state.disabledType==='boolean','Field HTMLButtonElement.disabled must exist and be boolean',state);
  assert(state.visibleType==='string'&&['true','false'].includes(state.visible),'Field dataset.visible must exist and be a boolean string',state);
}
async function click(c,selector){await assertFields(c);const p=await evaluate(c,selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);
  await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle(c);}
async function scroll(c,y){await assertFields(c);await evaluate(c,y=>{window.dispatchEvent(new WheelEvent('wheel'));window.scrollTo({top:y,behavior:'instant'});},y);await frames(c,3);}
function monitor(){
  const state=window.__g67={frames:0,maxClickable:0,failures:[],maxDelta:0,maxTranslate:0,negative:0};
  const rectVisible=el=>{const r=el.getBoundingClientRect(),v=visualViewport,l=v?.offsetLeft??0,t=v?.offsetTop??0;
    return Math.min(r.right,l+(v?.width??innerWidth))>Math.max(r.left,l)&&Math.min(r.bottom,t+(v?.height??innerHeight))>Math.max(r.top,t);};
  state.visible=rectVisible;
  const tick=()=>{
    const top=document.querySelector('.reader-typography-aa'),floating=document.querySelector('.reader-typography-floating-aa');
    if(top&&floating){
      const active=el=>{const style=getComputedStyle(el);return style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none'&&!el.disabled&&!el.inert&&rectVisible(el);};
      const count=Number(active(top))+Number(active(floating));state.maxClickable=Math.max(state.maxClickable,count);
      if(count>1)state.failures.push('two clickable Aa');
      const should=innerWidth<768&&!rectVisible(top)&&!document.querySelector('.reader-typography-sheet');
      if((floating.dataset.visible==='true')!==should)state.failures.push('geometry/state mismatch');
      if(floating.dataset.visible!=='true'&&(!floating.disabled||!floating.inert||floating.tabIndex!==-1||floating.getAttribute('aria-hidden')!=='true'||getComputedStyle(floating).pointerEvents!=='none'))state.failures.push('hidden entry active');
      const b=document.querySelector('.reader-body'),tr=getComputedStyle(b).translate;
      const abs=tr==='none'?0:Math.max(...tr.split(/\s+/).map(x=>Math.abs(parseFloat(x))));state.maxTranslate=Math.max(state.maxTranslate,abs);
      if(!(abs<1))state.failures.push('article translate >=1px');
      state.frames++;
    }
    state.raf=requestAnimationFrame(tick);
  };state.raf=requestAnimationFrame(tick);
}
async function assertMonitor(c){const result=await c.evaluate('({frames:__g67.frames,maxClickable:__g67.maxClickable,failures:__g67.failures.slice(0,8),maxTranslate:__g67.maxTranslate})');assert(!result.failures.length,'Frame invariants',result);return result;}
async function visibility(c,width,theme){
  await scroll(c,0);
  const bounds=await c.evaluate("(()=>{const r=document.querySelector('.reader-typography-aa').getBoundingClientRect();return{edge:scrollY+r.bottom,height:r.height}})()");
  const edge=bounds.edge,partial=edge-bounds.height/2;
  await scroll(c,partial);
  const partialRatio=await c.evaluate("(()=>{const r=document.querySelector('.reader-typography-aa').getBoundingClientRect(),v=visualViewport;return Math.max(0,Math.min(r.bottom,(v?.offsetTop??0)+(v?.height??innerHeight))-Math.max(r.top,v?.offsetTop??0))/r.height})()");
  assert(partialRatio>0&&partialRatio<1,'Partial scenario has actual positive partial intersection',partialRatio);console.log(JSON.stringify({width,theme,partialRatio}));assert(await c.evaluate("document.querySelector('.reader-typography-floating-aa').disabled"),'Partial top hides floating');
  await scroll(c,edge+.5);assert(await c.evaluate("!document.querySelector('.reader-typography-floating-aa').disabled"),'Fully outside shows floating');
  await scroll(c,partial);assert(await c.evaluate("document.querySelector('.reader-typography-floating-aa').disabled"),'Return hides floating');
  for(let i=0;i<10;i++){await scroll(c,edge+2);await scroll(c,edge-2);}
  await evaluate(c,async edge=>{for(let y=edge-8;y<=edge+8;y+=.5){window.scrollTo({top:y,behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));}},edge);
  await scroll(c,1500);await scroll(c,0);await scroll(c,2500);await scroll(c,0);
  await assertMonitor(c);await c.evaluate('cancelAnimationFrame(__g67.raf)');
  await align(c,11);await c.call('Page.reload');await ready(c); // the stored reader position is restored on entry
  assert(await c.evaluate("scrollY>100&&!document.querySelector('.reader-typography-floating-aa').disabled"),'Deep entry restored');
  await c.evaluate(`(${monitor.toString()})()`);
  const geometry=await c.evaluate("(()=>{const b=document.querySelector('.reader-typography-floating-aa'),s=getComputedStyle(b),t=getComputedStyle(document.querySelector('.reader-typography-aa')),r=b.getBoundingClientRect();return{width:r.width,height:r.height,font:parseFloat(s.fontSize),topFont:parseFloat(t.fontSize),position:s.position,z:s.zIndex,bg:s.backgroundColor,expected:getComputedStyle(document.documentElement).getPropertyValue('--paper-side').trim(),right:s.right,bottom:s.bottom,transition:s.transitionDuration}})()");
  assert(geometry.width>=44&&geometry.height>=44&&geometry.font>=geometry.topFont&&geometry.position==='fixed'&&geometry.z==='40','Floating geometry',geometry);
  assert(geometry.transition==='0.12s','120ms transition',geometry);
  console.log(JSON.stringify({width,theme,visibility:geometry}));
}
function countAppRaf(){
  const raf=window.requestAnimationFrame.bind(window);window.__g67AppRaf=0;
  window.requestAnimationFrame=function(callback){if(new Error().stack?.includes('/_next/static/chunks/'))window.__g67AppRaf++;return raf(callback);};
}
async function idle(c,width,theme){
  const counts=[];
  for(const visible of [true,false]){
    await c.evaluate('window.__g67AppRaf=0');await scroll(c,visible?1500:0);await frames(c,60);
    const afterScroll=await c.evaluate('(()=>{const count=window.__g67AppRaf;window.__g67AppRaf=0;return count})()');
    assert(afterScroll>0,'App rAF counter observed this scroll before reset',{width,theme,visible,afterScroll});
    const result=await evaluate(c,visible=>new Promise(resolve=>{let n=0,unchanged=true;function tick(){unchanged=unchanged&&(document.querySelector('.reader-typography-floating-aa').dataset.visible===String(visible));if(++n>=120)resolve({appRaf:window.__g67AppRaf,unchanged});else requestAnimationFrame(tick);}requestAnimationFrame(tick);}),visible);
    counts.push({visible,afterScroll,...result});
    assert(result.appRaf===0&&result.unchanged,'Idle schedules no app rAF and retains visibility',{width,theme,visible,...result});
  }
  console.log(JSON.stringify({width,theme,idle:counts}));
}
async function zeroDisplacement(c,width){await assertFields(c);
  await align(c,11);await c.evaluate("window.dispatchEvent(new WheelEvent('wheel'))");
  const result=await measured(c,width,'G67-toggle-strict-xy',async()=>{
    await evaluate(c,async()=>{const top=document.querySelector('.reader-typography-aa');for(let i=0;i<4;i++){
      // Real position changes emit scroll/viewport events; pair synthetic translate with scroll.
      top.style.translate=i%2?'':'0 '+(scrollY+100)+'px';window.dispatchEvent(new Event('scroll'));await new Promise(r=>{let n=0;function tick(){if(++n>=65)r();else requestAnimationFrame(tick);}requestAnimationFrame(tick);});}top.style.translate='';window.dispatchEvent(new Event('scroll'));});
  });
  assert(await c.evaluate('window.__g19.trace.frames.every(f=>f.dx===0&&f.dy===0)'),'Strict x/y zero');
  await c.evaluate('window.__g67.maxDelta='+result.maxAbsDelta);
  // Moving only the overlay into normal flow before the article must be detected.
  const negative=await evaluate(c,async()=>{
    const f=document.querySelector('.reader-typography-floating-aa'),body=document.querySelector('.reader-body'),parent=f.parentNode,next=f.nextSibling;
    const ref=__g19.reference(),before=__g19.rect(ref.key);body.before(f);f.style.position='static';
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const after=__g19.rect(ref.key);const delta=Math.max(Math.abs(after.y-before.y),Math.abs(after.x-before.x));
    f.style.position='';parent.insertBefore(f,next);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return delta;
  });
  assert(negative>0,'Normal-flow negative control',negative);await c.evaluate('window.__g67.negative='+negative);
}
async function closures(c,width){await assertFields(c);
  for(const kind of ['close','outside','escape']){
    await align(c,11);await revealControls(c,width);
    assert(await c.evaluate("document.activeElement.id==='reader-typography-sheet-title'"),'Title focus');
    const before=await c.evaluate("({y:scrollY,panels:[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)})");
    await c.evaluate('window.__g19.events=[]');
    if(kind==='close')await click(c,'[aria-label="关闭阅读排版"]');
    else if(kind==='outside'){await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:width/2,y:40});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:width/2,y:40});await settle(c);}
    else {await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle(c);}
    const after=await c.evaluate("({y:scrollY,panels:[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex),closed:!document.querySelector('.reader-typography-sheet'),focus:document.activeElement===document.querySelector('.reader-typography-floating-aa'),events:__g19.events})");
    assert(after.closed&&after.focus&&after.y===before.y&&JSON.stringify(after.panels)===JSON.stringify(before.panels),'Close/focus retains reading '+kind,{before,after});
    assert(after.events.filter(e=>e.event.startsWith('sentence_')||['gloss_abort','gloss_dismiss_early'].includes(e.event)).length===0,'No close/click events',after.events);
  }
  await scroll(c,0);await revealControls(c,width);await click(c,'.reader-typography-aa');
  assert(await c.evaluate("!document.querySelector('.reader-typography-sheet')&&document.activeElement===document.querySelector('.reader-typography-aa')"),'Top toggle and focus');
  await align(c,11);await revealControls(c,width);
  await c.call('Emulation.setDeviceMetricsOverride',{width:768,height:900,deviceScaleFactor:1,mobile:false});await settle(c);
  assert(await c.evaluate("!document.querySelector('.reader-typography-sheet')&&document.activeElement===document.querySelector('.settings-typography-toggle')"),'Desktop focus fallback');
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await settle(c);
}
async function typography(c,width){await assertFields(c);
  await save(c,5);await open(c,6);
  for(const location of ['middle','end']){
    if(location==='middle')await align(c,11);else await evaluate(c,()=>{const g=__g19.glyphs(),last=g.at(-1);window.dispatchEvent(new WheelEvent('wheel'));window.scrollTo({top:scrollY+last.y-60,behavior:'instant'});});
    await settle(c);await revealControls(c,width);
    for(const key of ['fontSize','lineHeight'])await measured(c,width,'G67-'+location+'-drag-'+key,()=>drag(c,key));
    for(const key of ['bodyFont','glossFont'])for(const font of ['sans','serif'])await measured(c,width,'G67-'+location+'-'+key+'-'+font,()=>change(c,key,font));
    await click(c,'[aria-label="关闭阅读排版"]');
  }
  await closures(c,width);
}
async function overlays(c,width){await assertFields(c);
  const panelExists=await c.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\"6\"]')");
  if(!panelExists)await open(c,6);
  await align(c,6);
  assert(await c.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\"6\"]')"),'Field gloss panel 6 must exist before context-menu geometry');
  const p=await c.evaluate("(()=>{const s=document.querySelector('.gloss-panel[data-sentence-index=\"6\"]'),r=s.getBoundingClientRect();return{x:r.left+20,y:Math.max(30,r.top+10)}})()");
  await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...p});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...p});await settle(c);
  assert(await c.evaluate("!!document.querySelector('.reader-context-menu')"),'Context menu opened');
  await click(c,'.reader-typography-floating-aa');assert(await c.evaluate("!document.querySelector('.reader-context-menu')&&!document.querySelector('.reader-typography-sheet')"),'Menu first click consumed');
  await click(c,'.reader-typography-floating-aa');assert(await c.evaluate("!!document.querySelector('.reader-typography-sheet')"),'Menu second click opens sheet');await click(c,'[aria-label="关闭阅读排版"]');
  await scroll(c,0);await click(c,'.feedback-button');await align(c,11);
  assert(await c.evaluate("!!document.querySelector('.feedback-card')"),'Feedback open');
  await click(c,'.reader-typography-floating-aa');assert(await c.evaluate("!document.querySelector('.feedback-card')&&!document.querySelector('.reader-typography-sheet')"),'Feedback first click consumed');
  await click(c,'.reader-typography-floating-aa');assert(await c.evaluate("!!document.querySelector('.reader-typography-sheet')"),'Feedback second click opens sheet');await click(c,'[aria-label="关闭阅读排版"]');
  await c.evaluate('window.__g19.events=[]');await click(c,'.reader-typography-floating-aa');
  assert(await c.evaluate("__g19.events.every(e=>!e.event.startsWith('sentence_')&&!['gloss_abort','gloss_dismiss_early'].includes(e.event))"),'No button reading event');await click(c,'[aria-label="关闭阅读排版"]');
  await open(c,8);assert(await c.evaluate("!!document.querySelector('.gloss-panel[data-sentence-index=\"8\"]')"),'Outside button sentence still opens');
}
async function clock(c,width){await assertFields(c);
  // Sample sentence 3 has a local first expansion, no network. Freeze only the
  // clock, preserving browser rAF timing, and cross the real completion threshold.
  await c.evaluate("window.__g67.realNow=performance.now.bind(performance);window.__g67.now=1000;performance.now=()=>window.__g67.now");
  await open(c,3);await wait(()=>c.evaluate("document.querySelector('.gloss-panel[data-sentence-index=\"3\"]')?.dataset.state==='done'"),'Sample gloss done');await align(c,3);await c.evaluate('window.__g19.events=[]');
  await revealControls(c,width);await c.evaluate("__g67.now+=100000;window.dispatchEvent(new Event('scroll'))");await settle(c);
  assert(await c.evaluate("!__g19.events.some(e=>e.event==='gloss_read_complete'&&e.sentenceIndex===3)"),'Sheet pauses clock');
  await click(c,'[aria-label="关闭阅读排版"]');await c.evaluate("__g67.now+=100000;window.dispatchEvent(new Event('scroll'))");await settle(c);
  assert(await c.evaluate("__g19.events.some(e=>e.event==='gloss_read_complete'&&e.sentenceIndex===3)"),'Floating entry leaves clock running');
  await c.evaluate('performance.now=__g67.realNow');
}
async function reduced(c){await assertFields(c);await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert(await c.evaluate("getComputedStyle(document.querySelector('.reader-typography-floating-aa')).transitionDuration==='0s'"),'Reduced motion has no transition');
  await c.call('Emulation.setEmulatedMedia',{features:[]});}
async function run(width,theme){
  const profile=await mkdtemp(join(tmpdir(),'gloss-g67-edge-')),port=await freePort();
  const edge=spawn(EDGE,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let c;const api=[];
  const single=async()=>{const pages=(await (await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(p=>p.type==='page');assert(pages.length===1,'Only one page',pages.map(p=>p.url));return pages[0];};
  try{
    let target;await wait(async()=>{const response=await fetch('http://127.0.0.1:'+port+'/json').catch(()=>null);if(!response)return false;target=(await response.json()).find(p=>p.type==='page');return !!target;},'Edge');
    await single();c=new Cdp(target.webSocketDebuggerUrl);
    c.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))api.push(m.params.request.url);});
    await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');
    await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${countAppRaf.toString()})();(${setup.toString()})();localStorage.setItem('gloss:settings:theme',${JSON.stringify(theme)});`});
    await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await c.call('Page.bringToFront');await ready(c);
    await c.evaluate(`(${monitor.toString()})()`);
    if(width<768){await visibility(c,width,theme);await idle(c,width,theme);await zeroDisplacement(c,width);await typography(c,width);await overlays(c,width);await clock(c,width);await reduced(c);}
    else{await scroll(c,1500);assert(await c.evaluate("getComputedStyle(document.querySelector('.reader-typography-floating-aa')).display==='none'"),'No desktop floating Aa');}
    await frames(c);await single();assert(api.length===0,'Zero API requests',api);
    const result=await assertMonitor(c);const extra=await c.evaluate('({maxDelta:__g67.maxDelta,negative:__g67.negative})');
    console.log(JSON.stringify({width,theme,...result,...extra,apiRequests:api.length,passed:true}));
  }finally{c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),pause(5000)]);
    assert(resolve(profile).startsWith(resolve(tmpdir(),'gloss-g67-edge-')),'Safe profile cleanup');await rm(profile,{recursive:true,force:true});}
}
for(const width of [375,506])for(const theme of THEMES)await run(width,theme);
for(const width of [768,1024,1280])await run(width,'parchment');
console.log('G-67 floating Aa checks passed');
