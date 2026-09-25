import { spawn } from 'node:child_process';
/** Replay after the invalid-key / HTTP 401 preflight on the isolated local server. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { const value = await fn(); if (value) return value; } catch {} await sleep(50); }
  throw Error(`timeout ${label}`);
}
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((yes, no) => { this.ws.onopen = yes; this.ws.onerror = no; });
    this.ws.onmessage = ({data}) => { const m = JSON.parse(data); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.no(Error(m.error.message)) : p.yes(m.result); };
  }
  async call(method, params={}) { await this.ready; const id=++this.id; return new Promise((yes,no) => { this.pending.set(id,{yes,no}); this.ws.send(JSON.stringify({id,method,params})); }); }
  async eval(expression) { const r=await this.call('Runtime.evaluate',{expression,returnByValue:true}); if(r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
  close() { this.ws.close(); }
}
const instrumentation = `(() => {
  const log=[]; window.__g44=log;
  const stamp=()=>Math.round(performance.now()*100)/100;
  const name=n=>n instanceof Element ? (n.tagName.toLowerCase()+(n.className && typeof n.className==='string' ? '.'+n.className.trim().replaceAll(' ','.') : '')) : String(n);
  const cover=()=>{const c=document.querySelector('.book-cover');return !!c&&c.isConnected};
  const nativeSet=window.setTimeout, nativeClear=window.clearTimeout;
  const ids=new Map();
  window.setTimeout=function(fn,ms,...args){
    if(ms!==120&&ms!==150) return nativeSet.call(this,fn,ms,...args);
    const kind=ms===120?'openPreview':'closePreview';
    const id=nativeSet.call(this,(...a)=>{log.push({t:stamp(),kind:kind+' fired',cover:cover()});ids.delete(id);fn(...a)},ms,...args);
    ids.set(id,kind);log.push({t:stamp(),kind:kind+' scheduled',cover:cover(),id});return id;
  };
  window.clearTimeout=function(id){if(ids.has(id)){log.push({t:stamp(),kind:ids.get(id)+' cleared',cover:cover(),id});ids.delete(id)}return nativeClear.call(this,id)};
  for(const type of ['pointerdown','contextmenu','mouseleave','mouseout','blur']) document.addEventListener(type,e=>{
    const point=e.clientX===undefined?null:document.elementFromPoint(e.clientX,e.clientY);
    log.push({t:stamp(),kind:type+' capture',target:name(e.target),hit:name(point),related:name(e.relatedTarget),cover:cover(),x:e.clientX,y:e.clientY});
  },true);
  document.addEventListener('contextmenu',e=>{log.push({t:stamp(),kind:'contextmenu bubble',target:name(e.target),prevented:e.defaultPrevented,cover:cover(),menu:!!document.querySelector('.spine-menu')});nativeSet.call(window,()=>log.push({t:stamp(),kind:'contextmenu after dispatch',target:name(e.target),prevented:e.defaultPrevented,cover:cover(),menu:!!document.querySelector('.spine-menu')}),0)});
  window.addEventListener('error',e=>log.push({t:stamp(),kind:'error',message:e.message}));
})();`;

const profile=await mkdtemp(join(tmpdir(),'gloss-g44-probe-'));
const s=createServer(); await new Promise(done=>s.listen(0,'127.0.0.1',done)); const port=s.address().port; await new Promise(done=>s.close(done));
const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-sandbox',`--remote-debugging-port=${port}`,'--remote-allow-origins=*',`--user-data-dir=${profile}`,'--no-first-run','about:blank'],{stdio:'ignore',windowsHide:true});
let cdp;
try {
  const target=await waitFor(async()=>(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page'),'CDP target');
  cdp=new Cdp(target.webSocketDebuggerUrl); await cdp.call('Page.enable'); await cdp.call('Runtime.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:instrumentation});
  await cdp.call('Page.navigate',{url:'http://localhost:3430'});
  await waitFor(()=>cdp.eval("location.hostname==='localhost'&&document.readyState==='complete'"),'page');
  const doc={version:1,docId:'g44probe',paragraphs:['G44 测试书。'],headings:[],footnotes:[],meta:{format:'txt',fileName:'G44 测试书.txt',charCount:8},savedAt:Date.now()};
  await cdp.eval(`localStorage.setItem('gloss:doc:g44probe',${JSON.stringify(JSON.stringify(doc))})`);
  const second={...doc,docId:'g44probe2',paragraphs:['G44 第二本测试书。'],meta:{...doc.meta,fileName:'G44 第二本测试书.txt'}};
  await cdp.eval(`localStorage.setItem('gloss:doc:g44probe2',${JSON.stringify(JSON.stringify(second))})`);
  await cdp.call('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-spine')"),'spine');
  const spine=await cdp.eval("(()=>{const r=document.querySelector('.book-spine').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spine.x,y:spine.y});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-cover')"),'cover');
  const cover=await cdp.eval("(()=>{const r=document.querySelector('.book-cover').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:cover.x,y:cover.y});
  await sleep(30);
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:400});
  await waitFor(()=>cdp.eval("!document.querySelector('.book-cover')"),'150 ms preview close');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spine.x,y:spine.y});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-cover')"),'preview reopen');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:cover.x,y:cover.y});
  await sleep(30);
  const attempts=[];
  for(let n=1;n<=20;n++) {
    const before=(await cdp.eval('window.__g44.length'));
    const hit=await cdp.eval(`document.elementFromPoint(${cover.x},${cover.y})?.closest('.book-cover')?.className ?? null`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:cover.x,y:cover.y,button:'right',buttons:2,clickCount:1});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:cover.x,y:cover.y,button:'right',buttons:0,clickCount:1});
    await sleep(30);
    const evidence=await cdp.eval(`window.__g44.slice(${before}).filter(x=>x.kind==='pointerdown capture'||x.kind==='contextmenu capture'||x.kind==='contextmenu after dispatch')`);
    const context=evidence.find(x=>x.kind==='contextmenu after dispatch');
    const state=await cdp.eval("({cover:!!document.querySelector('.book-cover'),menu:!!document.querySelector('.spine-menu')})");
    const success=hit==='book-cover'&&context?.target==='a.book-cover'&&context.prevented===true&&state.cover&&state.menu;
    attempts.push({n,success,hit,pointerdown:evidence.find(x=>x.kind==='pointerdown capture')?.target,contextmenu:context?.target,prevented:context?.prevented,coverAtContext:evidence.find(x=>x.kind==='contextmenu capture')?.cover});
    if(n===1) {
      await cdp.eval(`(()=>{const p=document.createElement('div');p.style.cssText='position:fixed;left:${cover.x-4}px;top:${cover.y-4}px;width:8px;height:8px;border-radius:50%;background:#e64b28;border:1px solid white;z-index:100;pointer-events:none';document.body.append(p);window.__g44pointer=p})()`);
      const shot=await cdp.call('Page.captureScreenshot',{format:'png'});
      await writeFile(resolve('tmp-g44-menu.png'),Buffer.from(shot.data,'base64'));
      await cdp.eval('window.__g44pointer.remove()');
    }
  }
  const menuGeometry=await cdp.eval(`(()=>{const m=document.querySelector('.spine-menu').getBoundingClientRect(),s=document.querySelector('.shelf').getBoundingClientRect();return{menu:{x:m.x,y:m.y,right:m.right,bottom:m.bottom},shelf:{x:s.x,y:s.y,right:s.right,bottom:s.bottom},viewport:{width:innerWidth,height:innerHeight},cursor:{x:${cover.x},y:${cover.y}}}})()`);
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:100}); await sleep(200);
  const afterLeave=await cdp.eval("({cover:!!document.querySelector('.book-cover'),menu:!!document.querySelector('.spine-menu')})");
  const timers=(await cdp.eval('window.__g44')).filter(x=>x.kind.includes('Preview'));
  if(!afterLeave.cover||!afterLeave.menu) throw Error('Cover or menu disappeared on mouse leave');
  if(await cdp.eval("!!document.querySelector('.book-detail')")) throw Error('Right-click menu displayed a detail card');
  const menu=menuGeometry.menu,shelf=menuGeometry.shelf,cursor=menuGeometry.cursor,viewport=menuGeometry.viewport;
  if(menu.x<Math.max(0,shelf.x)||menu.right>Math.min(shelf.right,viewport.width)||menu.y<Math.max(0,shelf.y)||menu.bottom>Math.min(shelf.bottom,viewport.height)||menu.x-cursor.x<7) throw Error('Menu position or bounds failed');
  await cdp.eval("document.querySelector('[aria-label=\"书色 4\"]').click()");
  await waitFor(()=>cdp.eval("JSON.parse(localStorage.getItem('gloss:shelf:v1')).entries.g44probe.colorId==='book-3'"),'color saved');
  await cdp.call('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-spine')"),'reload shelf');
  const persistedColor=await cdp.eval("JSON.parse(localStorage.getItem('gloss:shelf:v1')).entries.g44probe.colorId");
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spine.x,y:spine.y});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-cover')"),'cover after reload');
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:cover.x,y:cover.y,button:'right',buttons:2,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:cover.x,y:cover.y,button:'right',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("!!document.querySelector('.spine-menu')"),'menu for remove');
  await cdp.eval("[...document.querySelectorAll('.spine-menu button')].find(b=>b.textContent?.includes('从书架移除')).click()");
  await waitFor(()=>cdp.eval("!!document.querySelector('.remove-confirm')"),'remove confirmation');
  await cdp.eval("[...document.querySelectorAll('.remove-confirm button')].find(b=>b.textContent?.includes('取消')).click()");
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:cover.x,y:cover.y,button:'right',buttons:2,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:cover.x,y:cover.y,button:'right',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("!!document.querySelector('.spine-menu')"),'menu for outside click');
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:100,y:100,button:'left',buttons:1,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:100,y:100,button:'left',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("!document.querySelector('.spine-menu')"),'outside close');
  await waitFor(()=>cdp.eval("!document.querySelector('.book-cover')"),'outside close collapses cover');
  const afterOutside=await cdp.eval("({menu:!!document.querySelector('.spine-menu'),cover:!!document.querySelector('.book-cover'),openSlots:document.querySelectorAll('.book-slot-open').length})");
  if(afterOutside.openSlots!==0) throw Error('Outside click left a selected book open');
  await sleep(250);
  const secondSpine=await cdp.eval("(()=>{const r=document.querySelectorAll('.book-spine')[1].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:secondSpine.x,y:secondSpine.y});
  await waitFor(()=>cdp.eval("document.querySelector('.book-slot-open')?.dataset.docId==='g44probe2'"),'second book hover');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:100});
  await waitFor(()=>cdp.eval("document.querySelectorAll('.book-slot-open').length===0"),'no first book rebound');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spine.x,y:spine.y});
  await waitFor(()=>cdp.eval("document.querySelector('.book-slot-open')?.dataset.docId==='g44probe'"),'first book rehover');
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:spine.x,y:spine.y,button:'right',buttons:2,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:spine.x,y:spine.y,button:'right',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("!!document.querySelector('.spine-menu')"),'spine right-click menu');
  if(await cdp.eval("!!document.querySelector('.book-detail')")) throw Error('Spine right-click displayed a detail card');
  await cdp.eval("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await waitFor(()=>cdp.eval("!document.querySelector('.spine-menu')"),'outside event while still hovering');
  const whileHover=await cdp.eval("({cover:!!document.querySelector('.book-cover'),openDoc:document.querySelector('.book-slot-open')?.dataset.docId})");
  if(whileHover.openDoc!=='g44probe') throw Error('Cover closed while cursor still hovered the book');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:100});
  await waitFor(()=>cdp.eval("document.querySelectorAll('.book-slot-open').length===0"),'hover leave collapses cover');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spine.x,y:spine.y});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-cover')"),'cover for Escape check');
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:spine.x,y:spine.y,button:'right',buttons:2,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:spine.x,y:spine.y,button:'right',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("!!document.querySelector('.spine-menu')"),'menu before Escape');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:100});
  await sleep(200);
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor(()=>cdp.eval("!document.querySelector('.spine-menu')"),'Escape closes menu');
  await sleep(200);
  const afterEscape=await cdp.eval("({cover:!!document.querySelector('.book-cover'),focusedSpine:document.activeElement?.classList.contains('book-spine')})");
  if(afterEscape.cover||!afterEscape.focusedSpine) throw Error(`Escape focus restored a stale preview or lost spine focus: ${JSON.stringify(afterEscape)}`);
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spine.x,y:spine.y});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-cover')"),'cover for left-click');
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:cover.x,y:cover.y,button:'left',buttons:1,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:cover.x,y:cover.y,button:'left',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("location.pathname==='/read/g44probe'"),'left click enters reader');
  await cdp.call('Page.navigate',{url:'http://localhost:3430'});
  await waitFor(()=>cdp.eval("!!document.querySelectorAll('.book-spine')[1]"),'return to shelf');
  const spineAfterReturn=await cdp.eval("(()=>{const r=document.querySelector('.book-spine').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spineAfterReturn.x,y:spineAfterReturn.y});
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:spineAfterReturn.x,y:spineAfterReturn.y,button:'left',buttons:1,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:spineAfterReturn.x,y:spineAfterReturn.y,button:'left',buttons:0,clickCount:1});
  await waitFor(()=>cdp.eval("!!document.querySelector('.book-detail')"),'left spine detail');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:100});
  await sleep(200);
  const leftSpine=await cdp.eval("({cover:!!document.querySelector('.book-cover'),detail:!!document.querySelector('.book-detail')})");
  if(!leftSpine.cover||!leftSpine.detail) throw Error('Left spine selection behavior changed');
  console.log(JSON.stringify({successes:attempts.filter(x=>x.success).length,total:attempts.length,attempts,menuGeometry,afterLeave,afterOutside,whileHover,afterEscape,leftSpine,noRebound:true,spineRightClick:true,timerEvidence:timers.slice(0,8),closePreviewFired:timers.filter(x=>x.kind==='closePreview fired').length,persistedColor,removeConfirmation:true,outsideClose:true,leftClickReader:true},null,2));
  if(attempts.some(x=>!x.success)) throw Error('G-44 cover right-click below 20/20');
} finally { cdp?.close(); edge.kill(); await Promise.race([new Promise(done=>edge.once('exit',done)),sleep(5000)]); const p=resolve(profile); if(!p.startsWith(resolve(tmpdir(),'gloss-g44-probe-'))) throw Error('unsafe profile'); await rm(p,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
