/** G-19c desktop rail/popover, invalid-key production service only. */
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,setup,ready,freePort,settle,revealControls,align,open,evaluate,measured,drag,change}=await import('./verify-g19.mjs');
const ORIGIN=process.env.G19C_ORIGIN??'http://localhost:3472';
const ROOT=resolve(import.meta.dirname,'..');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const assert=(ok,label,detail)=>{if(!ok)throw Error(label+(detail===undefined?'':': '+JSON.stringify(detail)));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('Timeout: '+label);}
async function click(c,selector){const p=await evaluate(c,selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);
 await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle(c);}
function probes(){
 const state=window.__g19c={locks:[],raw:[],idleRaf:0};
 const realRaf=requestAnimationFrame;
 window.requestAnimationFrame=function(callback){if(new Error().stack?.includes('/_next/'))state.idleRaf++;return realRaf.call(window,callback);};
 const intersects=(r,p)=>Math.min(r.right,p.right)>Math.max(r.left,p.left)&&Math.min(r.bottom,p.bottom)>Math.max(r.top,p.top);
 state.intersects=intersects;
 // Observe the actual synchronous Range read used by the Reader's pointer/radio gesture, without replacing its selection.
 const read=Range.prototype.getClientRects;
 Range.prototype.getClientRects=function(){const result=read.call(this),node=this.startContainer,span=node.parentElement?.closest('.sentence');
  if(state.collect&&span?.closest('.reader-body')&&result[0]){const r=result[0];state.raw.push({key:span.closest('[data-para]').dataset.para+':'+(Number(span.dataset.offset)+this.startOffset),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}});}return result;};
 for(const type of ['pointerdown','click']){
  document.addEventListener(type,e=>{state.collect=!!e.target.closest('.reader-typography-popover [data-typography]');state.raw=[];},true);
  document.addEventListener(type,()=>{if(state.collect&&state.raw.length){const last=state.raw.at(-1),p=document.querySelector('.reader-typography-popover').getBoundingClientRect();state.locks.push({...last,intersects:intersects(last.rect,p)});}state.collect=false;});
 }
 state.snapshot=()=>({glyphs:__g19.glyphs().filter(g=>g.y>=0&&g.bottom<=innerHeight&&g.char.trim()).map(g=>({key:g.key,...__g19.rect(g.key)})),panels:[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)});
 state.guard=ref=>{const r=__g19.rect(ref.key),p=document.querySelector('.reader-typography-popover').getBoundingClientRect();if(intersects({left:r.x,right:r.x+r.width,top:r.y,bottom:r.y+r.height},p))throw Error('参照字被浮层遮挡 '+JSON.stringify({key:ref.key,rect:r}));};
}
async function unchanged(c,before,label){const after=await c.evaluate('__g19c.snapshot()');let maxDx=0,maxDy=0;
 for(const a of before.glyphs){const b=after.glyphs.find(g=>g.key===a.key);assert(b,'Visible original glyph lost '+label,a);maxDx=Math.max(maxDx,Math.abs(b.x-a.x));maxDy=Math.max(maxDy,Math.abs(b.y-a.y));}
 assert(maxDx<.5&&maxDy<.5,'Visible glyph displacement '+label,{maxDx,maxDy});assert(JSON.stringify(before.panels)===JSON.stringify(after.panels),'Gloss retained '+label,{before:before.panels,after:after.panels});assert(await c.evaluate('__g19.events.length')===0,'Zero reading events '+label);return{maxDx,maxDy};}
async function idle(c,opened){await settle(c);const count=await evaluate(c,()=>new Promise(resolve=>{__g19c.idleRaf=0;let n=0;function tick(){if(++n>=120)resolve(__g19c.idleRaf);else requestAnimationFrame(tick);}requestAnimationFrame(tick);}));assert(count===0,'Idle app rAF',{opened,count});return{opened,frames:120,appRaf:count};}
async function checks(c,width,theme){
 await evaluate(c,theme=>{localStorage.removeItem('gloss:settings:reader-typography');localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'system');localStorage.setItem('gloss:settings:theme','parchment');},theme);
 await c.call('Page.reload');await ready(c);await open(c,5);await align(c,11);
 const layout=await evaluate(c,()=>{const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{left:r.left,right:r.right,width:r.width};};return{left:rect('.col-left'),main:rect('.col-main'),rail:rect('.col-right'),body:rect('.reader-body'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,labels:[...document.querySelector('.reader-tool-rail').children].map(el=>el.getAttribute('aria-label'))};});
 assert(Math.abs(layout.rail.width-88)<=1,'88px rail',layout);assert(layout.main.left===layout.left.right&&layout.main.right===layout.rail.left,'Contiguous grid',layout);
 assert(Math.abs((layout.body.left-layout.main.left)-(layout.main.right-layout.body.right))<=1,'Centered original body',layout);assert(layout.overflow<=0,'No horizontal overflow',layout);
 assert(layout.labels[0]==='阅读排版'&&layout.labels[1].startsWith('外观：')&&layout.labels[2]==='底色'&&layout.labels[3].startsWith('白话显示形态：'),'Rail order and Chinese names',layout);
 const paper='.reader-tool-rail .reader-paper-options';
 const dom=await c.call('DOM.getDocument'),node=await c.call('DOM.querySelector',{nodeId:dom.root.nodeId,selector:paper}),ax=await c.call('Accessibility.getPartialAXTree',{nodeId:node.nodeId,fetchRelatives:false});assert(ax.nodes[0].ignored===(theme==='dark'),'Paper AX hidden',ax.nodes);
 assert(await c.evaluate("[...document.querySelectorAll('.reader-tool-swatch')].every(b=>['羊皮纸','月白','护眼绿'].includes(b.ariaLabel)&&['true','false'].includes(b.getAttribute('aria-pressed')))") ,'Swatch Chinese labels and pressed');
 // Cycle always begins at system, then restores this matrix's effective theme.
 await evaluate(c,()=>{localStorage.setItem('gloss:settings:appearance','system');dispatchEvent(new Event('gloss:appearance-change'));});await settle(c);
 for(const [name,effective] of [['浅色','parchment'],['深色','dark'],['跟随系统','parchment']]){await click(c,'.reader-appearance-cycle');assert(await c.evaluate('document.documentElement.dataset.theme')===effective,'Appearance effective '+name);assert(await c.evaluate("document.querySelector('.reader-appearance-cycle').ariaLabel")===`外观：${name}，点击切换`,'Appearance label '+name);}
 await evaluate(c,theme=>{localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'system');dispatchEvent(new Event('gloss:appearance-change'));},theme);await settle(c);
 const shape=await c.evaluate("localStorage.getItem('gloss:settings:gloss-shape')");await click(c,'.reader-shape-cycle');assert(await c.evaluate("document.querySelector('.reader-shape-cycle').ariaLabel.includes('气泡')"),'Shape cycle bubble');await click(c,'.reader-shape-cycle');
 const closeRows=[];
 for(const mode of ['escape','outside','toggle']){
  await c.evaluate('__g19.events=[]');const before=await c.evaluate('__g19c.snapshot()');await click(c,'.settings-typography-toggle');
  assert(await c.evaluate("document.activeElement===document.querySelector('.reader-typography-popover h2')"),'Title focus');assert(await c.evaluate("document.querySelector('.settings-typography-toggle').getAttribute('aria-expanded')==='true'"),'Expanded');
  const opened=await unchanged(c,before,mode+':open');
  if(mode==='escape'){await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
  else if(mode==='toggle')await click(c,'.settings-typography-toggle');else{const p=await c.evaluate("(()=>{const r=document.querySelector('.col-main').getBoundingClientRect();return{x:r.left+4,y:innerHeight-8}})()");await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
  await settle(c);assert(await c.evaluate("!document.querySelector('.reader-typography-popover')&&document.activeElement===document.querySelector('.settings-typography-toggle')"),'Close and restore Aa '+mode);closeRows.push({mode,opened,closed:await unchanged(c,before,mode+':close')});
 }
 await revealControls(c,width);const overlap=await c.evaluate("(()=>{const p=document.querySelector('.reader-typography-popover').getBoundingClientRect(),b=document.querySelector('.reader-body').getBoundingClientRect(),a=document.querySelector('.settings-typography-toggle').getBoundingClientRect(),r=document.querySelector('.col-right').getBoundingClientRect();return{horizontal:Math.max(0,Math.min(p.right,b.right)-Math.max(p.left,b.left)),width:p.width,gap:r.left-p.right,top:p.top,aaTop:a.top,bottom:p.bottom}})()");assert(overlap.width===320&&overlap.gap===8&&overlap.top>=0&&overlap.bottom<=900,'Popover positioning',overlap);
 const stable=await c.evaluate('__g19c.snapshot()');await c.evaluate('__g19.events=[]');
 for(const selector of ['.reader-appearance-cycle','.reader-tool-swatch[data-reader-theme="moon-white"]','.reader-shape-cycle']){
  // From dark the first cycle resolves to system/light, making the following swatch visible.
  await click(c,selector);assert(await c.evaluate("!!document.querySelector('.reader-typography-popover')"),'Rail retains popover '+selector);assert(await evaluate(c,selector=>document.activeElement===document.querySelector(selector),selector),'Rail retains clicked focus '+selector);await unchanged(c,stable,'rail '+selector);
 }
 await click(c,'.reader-shape-cycle');
 const idleRows=[await idle(c,true)];await click(c,'.settings-typography-toggle');idleRows.push(await idle(c,false));await revealControls(c,width);
 // Both endpoints, original G19 strict vertical/translate sampler; observe actual lock Range reads too.
 const gestures=[];await c.evaluate('__g19c.locks=[]');
 for(const key of ['fontSize','lineHeight','lineChars'])gestures.push(await measured(c,width,'G19c:'+key,()=>drag(c,key)));
 for(const [key,value]of [['bodyFont','serif'],['glossFont','sans']])gestures.push(await measured(c,width,'G19c:'+key,()=>change(c,key,value)));
 const locks=await c.evaluate('__g19c.locks');assert(locks.length>=5,'Actual gesture lock samples',locks);assert(locks.every(l=>!l.intersects),'Gesture reference intersects popover',locks);
 let negative=null;
 try{await c.evaluate("(()=>{const p=document.querySelector('.reader-typography-popover').getBoundingClientRect(),g=__g19.glyphs().find(g=>g.y>=0&&g.bottom<=innerHeight&&(()=>{const r=__g19.rect(g.key);return __g19c.intersects({left:r.x,right:r.x+r.width,top:r.y,bottom:r.y+r.height},p)})());if(!g)throw Error('No covered negative glyph');const saved=__g19.reference;try{__g19.reference=()=>g;__g19c.guard(__g19.reference());}finally{__g19.reference=saved;}})()");}catch(e){negative=e.message;}
 assert(negative?.includes('参照字被浮层遮挡'),'Covered-reference negative control',negative);
 const cache='.reader-typography-popover .settings-cache-button';await click(c,cache);assert(await evaluate(c,s=>document.querySelector(s).textContent,cache)==='确认清除？','First cache confirmation');await click(c,cache);await wait(()=>c.evaluate("document.querySelector('.settings-cache-result')?.textContent==='已清除'"),'cleared result');await sleep(3000);await click(c,cache);assert(await evaluate(c,s=>document.querySelector(s).textContent,cache)==='确认清除？','Second cache confirmation');await sleep(5000);assert(await evaluate(c,s=>document.querySelector(s).textContent,cache)==='清除自动缓存','Five second confirmation reset');
 if(width===1024){await c.call('Emulation.setDeviceMetricsOverride',{width:600,height:900,deviceScaleFactor:1,mobile:false});await settle(c);const mobile=await c.evaluate("(()=>{const clickable=[...document.querySelectorAll('.settings-typography-toggle,.reader-typography-aa,.reader-typography-floating-aa')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return !el.disabled&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'&&r.bottom>0&&r.top<innerHeight});return{popover:!!document.querySelector('.reader-typography-popover'),count:clickable.length,right:getComputedStyle(document.querySelector('.col-right')).display,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()");assert(!mobile.popover&&mobile.count<=1&&mobile.right==='none'&&mobile.overflow<=0,'Resize mobile single Aa',mobile);await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await settle(c);}
 console.log(JSON.stringify({width,theme,layout,overlap,closeRows,idle:idleRows,gestureCount:gestures.length,maxDelta:Math.max(...gestures.map(g=>g.maxAbsDelta)),maxTranslate:Math.max(...gestures.map(g=>g.maxTranslate)),locks,negative,cache:true,passed:true}));
}
async function screenshot(c,width,theme){if(![1024,1440].includes(width))return;const dir=join(ROOT,'tmp-g19c-shots-2');await mkdir(dir,{recursive:true});
 await evaluate(c,theme=>{localStorage.removeItem('gloss:settings:reader-typography');localStorage.setItem('gloss:settings:theme','parchment');localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');},theme);await c.call('Page.reload');await ready(c);await open(c,5);
 for(const state of ['closed','open']){if(state==='open')await revealControls(c,width);const {data}=await c.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(dir,`reader-${width}-${theme}-${state}.png`),Buffer.from(data,'base64'));}}
async function run(width,theme){const profile=await mkdtemp(join(tmpdir(),'gloss-g19c-edge-')),port=await freePort(),edge=spawn(EDGE,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});let c;const api=[];
 try{let target;await wait(async()=>{try{target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');return!!target;}catch{return false;}},'Edge');c=new Cdp(target.webSocketDebuggerUrl);
 const single=async()=>{const pages=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page');assert(pages.length===1&&pages[0].id===target.id,'Single page',pages);};await single();
 c.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))api.push(m.params.request.url);});
 await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 const raw=c.call.bind(c);c.call=async(method,params={})=>{if(!['Page.navigate','Page.reload'].includes(method))return raw(method,params);let handler,timer;const loaded=new Promise((done,fail)=>{handler=data=>{if(JSON.parse(data).method==='Page.domContentEventFired')done();};c.socket.on('message',handler);timer=setTimeout(()=>fail(Error('Navigation DOMContentLoaded timeout')),20000);});try{const result=await raw(method,params);await loaded;await raw('Page.bringToFront');return result;}finally{clearTimeout(timer);c.socket.off('message',handler);}};
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${setup.toString()})();(${probes.toString()})();`});await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);await checks(c,width,theme);await screenshot(c,width,theme);await single();assert(api.length===0,'Zero API requests',api);
 }catch(e){console.log(JSON.stringify({width,theme,stopped:true,error:e.message}));throw e;}
 finally{c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);assert(resolve(profile).startsWith(resolve(tmpdir(),'gloss-g19c-edge-')),'Safe cleanup');await rm(profile,{recursive:true,force:true});}}
for(const width of [768,1024,1280,1440])for(const theme of ['parchment','dark'])await run(width,theme);
console.log('G-19c desktop checks passed');
