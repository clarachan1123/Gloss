// G-73c：生产构建反馈卡验证；全部写入在浏览器内拦截，逐字坐标严格为零。
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,setup,evaluate}=await import('./verify-g19.mjs');
const origin='http://127.0.0.1:3504',port=9504;
const dir=resolve('tmp-g73c-shots');await mkdir(dir,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'gloss-g73c-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--disable-sync','--no-default-browser-check','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port='+port,'--remote-allow-origins=*','about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let c,scenes=0,passed=0,negatives=0,detected=0,shots=0;
const arrows=[],displacements=[],requests=[],errors=[];
const assert=(ok,label,detail)=>{if(!ok)throw Error(label+' '+JSON.stringify(detail??null));};
async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('等待失败 '+label);}
const ev=(fn,...args)=>evaluate(c,fn,...args);
async function check(label,fn,...args){scenes++;const value=await ev(fn,...args);assert(value,label);passed++;}
async function snap(name){const shot=await c.call('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,name+'.png'),Buffer.from(shot.data,'base64'));shots++;}
async function click(selector){const p=await ev(sel=>{const el=document.querySelector(sel);if(!el)throw Error('缺少 '+sel);const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},selector);await point(p);}
async function point(p){await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
async function key(key,shift=false){await c.call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,modifiers:shift?8:0,windowsVirtualKeyCode:key==='Tab'?9:27});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});}
async function edit(sel,text){await ev((sel,text)=>{const el=document.querySelector(sel),proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));},sel,text);}
async function settled(){await ev(()=>new Promise(r=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(r)),350)));}
async function single(){const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();assert(tabs.filter(t=>t.type==='page').length===1,'只有一个页面');}
const glyphs=()=>__g19.glyphs().filter(g=>g.char.trim()&&g.y>=52&&g.bottom<=innerHeight);
const unchanged=(before,after)=>before.every(a=>{const b=after.find(b=>b.key===a.key);return b&&a.x===b.x&&a.y===b.y;});
async function zero(before,label){if(!before)return;const after=await ev(()=>__g19.glyphs());let dx=0,dy=0;for(const a of before){const b=after.find(b=>b.key===a.key);assert(b,'原字丢失',a);dx=Math.max(dx,Math.abs(a.x-b.x));dy=Math.max(dy,Math.abs(a.y-b.y));}displacements.push({label,count:before.length,dx,dy});scenes++;assert(unchanged(before,after),'正文严格零位移 '+label,{dx,dy});passed++;}
async function negative(label,predicate,mutate,restore){assert(await ev(predicate),label+' 正对照');await ev(mutate);negatives++;try{assert(!await ev(predicate),label+' 负对照未检出');detected++;}finally{await ev(restore);}}
async function dataNegative(label,predicate,data,mutate){assert(predicate(data),label+' 正对照');const bad=structuredClone(data);mutate(bad);negatives++;assert(!predicate(bad),label+' 负对照未检出');detected++;}
const bounds=()=>{const r=document.querySelector('.feedback-card').getBoundingClientRect();return r.left>=0&&r.right<=document.documentElement.clientWidth&&r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=document.documentElement.clientWidth;};
const arrowValid=()=>{const card=document.querySelector('.feedback-card'),b=document.querySelector('.feedback-button').getBoundingClientRect(),a=card.querySelector('.feedback-arrow').getBoundingClientRect();return card.dataset.arrow==='true'&&Math.abs((a.left+a.right)/2-(b.left+b.right)/2)<=.5;};
const failure=()=>document.querySelector('.feedback-failure')?.textContent==='没发出去，内容还在。稍后再试，或加微信：Claraiing'&&document.querySelector('.feedback-send')?.textContent==='重新发送';
const overlay=()=>document.elementFromPoint(1,1)?.classList.contains('feedback-backdrop');
const openedStyle=()=>{const b=document.querySelector('.feedback-button'),s=getComputedStyle(b),probe=document.createElement('span');probe.style.color='var(--ink)';document.body.append(probe);const ink=getComputedStyle(probe).color;probe.remove();return s.backgroundColor===ink;};
const locked=()=>document.documentElement.style.overflow==='hidden'&&[...document.body.children].filter(n=>n instanceof HTMLElement&&!n.matches('.feedback-layer')).every(n=>n.inert);
try{
 let target;await wait(async()=>{try{const pages=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page');assert(pages.length===1,'只有一个页面');target=pages[0];return!!target;}catch{return false;}},'Edge');
 c=new Cdp(target.webSocketDebuggerUrl);await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 c.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
 await c.call('Runtime.enable');
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:'('+setup.toString()+')();'+String.raw`
 window.__feedbackMode='fail';window.__feedbackRows=[];window.__feedbackEvents=[];
 addEventListener('gloss:analytics',e=>__feedbackEvents.push(e.detail));
 const nativeFetch=window.fetch;
 window.fetch=async(...args)=>{
  if(args[0]==='/api/feedback'){
   __feedbackRows.push(JSON.parse(args[1].body));
   const mode=__feedbackMode;
   if(mode==='delay')return new Promise(resolve=>{window.__feedbackResolve=()=>resolve(new Response(null,{status:200}));});
   if(mode==='network')throw new TypeError('验证网络失败');
   return new Response(null,{status:mode==='success'?200:503});
  }
  if(String(args[0]).startsWith('/api/'))return new Response(null,{status:503});
  return nativeFetch(...args);
 };
`});
 for(const page of ['reader','shelf','landing'])for(const theme of ['parchment','moon-white','eye-green','dark'])for(const width of [1024,1280,1440,375,390,430]){
  const mobile=width<768,height=mobile?({375:667,390:844,430:932}[width]):900,id=page+'-'+theme+'-'+width;
  await c.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await c.call('Page.navigate',{url:origin+'/'});await wait(()=>c.evaluate("!!document.querySelector('.landing-header,.shelf-heading')"),'首页');
  await ev((page,theme)=>{
   localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);
   if(page==='shelf'){
    const docId='g73c';localStorage.setItem('gloss:doc:'+docId,JSON.stringify({version:1,docId,paragraphs:['验证原文。'],headings:[],footnotes:[],meta:{format:'txt',fileName:'验证.txt',charCount:5},savedAt:1}));
    localStorage.setItem('gloss:shelf:v1',JSON.stringify({version:1,migratedAt:1,entries:{g73c:{docId,title:'验证',author:null,addedAt:1,lastOpenedAt:1,colorId:'book-0',widthSeed:1}}}));
   }else {localStorage.removeItem('gloss:shelf:v1');localStorage.removeItem('gloss:doc:g73c');}
  },page,theme);
  await c.call('Page.navigate',{url:origin+(page==='reader'?'/read/sample':'/')});
  await wait(()=>c.evaluate(page==='reader'?"document.querySelector('.reader-body')?.dataset.measuring==='false'":page==='shelf'?"!!document.querySelector('.shelf-heading')":"!!document.querySelector('.landing-header')"),'目标页面 '+id);await settled();
  const before=page==='reader'?await ev(glyphs):null;
  if(mobile&&page==='reader'){await click('.reader-typography-aa');await ev(()=>{const s=document.querySelector('.reader-typography-sheet');s.scrollTop=s.scrollHeight;});await click('.reader-settings-feedback');}
  else await click('.feedback-button');
  await wait(()=>c.evaluate("!!document.querySelector('.feedback-card')"),'反馈打开');
  await check(id+' 动画时长',mobile=>getComputedStyle(document.querySelector('.feedback-card')).animationDuration===(mobile?'0.28s':'0.18s'),mobile);
  await snap(id+'-enter');await settled();await check(id+' 边界',bounds);await zero(before,id+'-open');
  await check(id+' 文案与尺寸',mobile=>{const card=document.querySelector('.feedback-card'),s=getComputedStyle(card),t=card.querySelector('textarea'),i=card.querySelector('input'),label=card.querySelector('label');return card.querySelector('h2').textContent==='体验反馈'&&t.placeholder==='比如：第二段的白话好像讲错了……'&&label.textContent==='联系方式 · 选填'&&label.htmlFor===i.id&&parseFloat(getComputedStyle(t).height)===120&&getComputedStyle(t).fontSize===(mobile?'16px':'14px')&&getComputedStyle(i).fontSize===(mobile?'16px':'13px')&&s.fontFamily.includes('Serif')&&(!mobile?Math.abs(card.offsetWidth-360)<.01:card.getAttribute('aria-modal')==='true');},mobile);
  if(!mobile){

   await check(id+' 尖角',arrowValid);
   arrows.push(await ev((page,width)=>{const b=document.querySelector('.feedback-button').getBoundingClientRect(),r=document.querySelector('.feedback-card').getBoundingClientRect(),a=document.querySelector('.feedback-arrow').getBoundingClientRect();return{page,width,B:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},L:r.left,M:(b.left+b.right)/2,arrow:(a.left+a.right)/2};},page,width));
  }else{await check(id+' 遮罩',overlay);await check(id+' 锁背景',locked);await check(id+' 无关闭和右键提示',()=>!document.querySelector('.feedback-close')&&getComputedStyle(document.querySelector('.feedback-report-tip')).display==='none');}
  if(page!=='reader')await check(id+' 打开中实心',openedStyle);
  await check(id+' 文字对比度',()=>{
   const color=key=>{const p=document.createElement('span');p.style.color='var('+key+')';document.body.append(p);const v=getComputedStyle(p).color.match(/[\d.]+/g).slice(0,3).map(Number);p.remove();return v;};
   const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
   return [['--feedback-placeholder','--feedback-input-bg'],['--feedback-error','--feedback-input-bg'],['--ink','--feedback-input-bg'],['--gloss','--paper-main'],['--paper-main','--hover']].every(([a,b])=>{const x=lum(color(a)),y=lum(color(b));return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)>=4.5;});
  });
  if(mobile){
   await ev(()=>document.querySelector('.feedback-copy').focus({preventScroll:true}));await key('Tab');
   await check(id+' Tab循环',()=>document.activeElement===document.querySelector('textarea'));
   await key('Tab',true);await check(id+' ShiftTab循环',()=>document.activeElement===document.querySelector('.feedback-copy'));
   await check(id+' 安全区基础留白',()=>parseFloat(getComputedStyle(document.querySelector('.feedback-card')).paddingBottom)>=24);
  }
  await snap(id+'-open');
  await edit('textarea',' 🙂甲 ');await check(id+' 计数',()=>document.querySelector('.feedback-count').textContent==='2 / 1000');await zero(before,id+'-input');
  await edit('textarea','甲'.repeat(1001));await check(id+' 超限',()=>document.querySelector('.feedback-count').classList.contains('feedback-error')&&document.querySelector('.feedback-send').disabled&&document.querySelector('.feedback-form').textContent.includes('超过 1000 字了，删一些再发'));await snap(id+'-over-limit');
  await edit('textarea','测试');await edit('input[type=text]','🙂'.repeat(101));await check(id+' 联系方式超限',()=>document.querySelector('.feedback-send').disabled);await edit('input[type=text]','邮箱');
  await click('.feedback-send');await wait(()=>c.evaluate("!!document.querySelector('.feedback-failure')"),'失败');await check(id+' 失败',failure);await zero(before,id+'-failure');await snap(id+'-failure');
  await ev(()=>window.__feedbackMode='success');await click('.feedback-send');await wait(()=>c.evaluate("!!document.querySelector('.feedback-success')"),'成功');await zero(before,id+'-success');await snap(id+'-success');
  await check(id+' 发送来源与新id',page=>__feedbackRows.length===2&&__feedbackRows.every(r=>r.source===page)&&__feedbackRows[0].id!==__feedbackRows[1].id,page==='landing'?'landing':page);
  if(mobile){await click('.feedback-success .feedback-send');await check(id+' 回到阅读',()=>!document.querySelector('.feedback-card'));}
  else{await click('.feedback-again');await settled();await check(id+' 再写一条',()=>document.querySelector('textarea').value===''&&document.activeElement===document.querySelector('textarea'));await click('.feedback-close');}
  await settled();await zero(before,id+'-closed');await snap(id+'-closed');
  await check(id+' 焦点返回',mobile&&page==='reader'?()=>document.activeElement===document.querySelector('.reader-typography-aa'):()=>document.activeElement===document.querySelector('.feedback-button'));
  await check(id+' 无反馈埋点',()=>__feedbackEvents.length===0);
 }
 // 专项在最后一个手机落地页中运行，故障注入恢复后复用同一判据。
 await click('.feedback-button');await settled();
 await negative('遮罩不穿透',overlay,()=>document.querySelector('.feedback-backdrop').style.pointerEvents='none',()=>document.querySelector('.feedback-backdrop').style.removeProperty('pointer-events'));
 await ev(()=>{window.__savedY=scrollY;});
 await c.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:1,y:1,deltaY:200,deltaX:0});await settled();
 await check('背景真实滚轮不滚',()=>scrollY===__savedY);
 await negative('错误色对比度',()=>{
   const lum=key=>{const p=document.createElement('span');p.style.color='var('+key+')';document.body.append(p);const rgb=getComputedStyle(p).color.match(/[\d.]+/g).slice(0,3).map(Number);p.remove();return rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);};
   const a=lum('--feedback-error'),b=lum('--feedback-input-bg');return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
 },()=>document.documentElement.style.setProperty('--feedback-error','var(--feedback-input-bg)'),()=>document.documentElement.style.removeProperty('--feedback-error'));
 await ev(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}}));await click('.feedback-copy');
 await wait(()=>c.evaluate("document.querySelector('.feedback-copy').textContent==='已复制'"),'复制');await snap('copy-success');
 await wait(()=>c.evaluate("document.querySelector('.feedback-copy').textContent==='复制'"),'复制恢复');
 await ev(()=>navigator.clipboard.writeText=async()=>{throw Error('验证拒绝复制');});await click('.feedback-copy');
 await check('复制回退',()=>getSelection().toString()==='Claraiing'&&document.querySelector('.feedback-card').textContent.includes('请手动复制'));await snap('copy-manual');
 await ev(()=>getSelection().removeAllRanges());
 await negative('背景锁定',locked,()=>document.documentElement.style.overflow='auto',()=>document.documentElement.style.overflow='hidden');
 await negative('打开中样式',openedStyle,()=>document.querySelector('.feedback-button').style.background='transparent',()=>document.querySelector('.feedback-button').style.removeProperty('background'));
 await edit('textarea','甲'.repeat(1001));
 await negative('超限禁发',()=>document.querySelector('.feedback-send').disabled,()=>document.querySelector('.feedback-send').disabled=false,()=>document.querySelector('.feedback-send').disabled=true);
 await edit('textarea','网络');await ev(()=>window.__feedbackMode='network');await click('.feedback-send');await wait(()=>c.evaluate("!!document.querySelector('.feedback-failure')"),'网络失败');
 await negative('新失败文案',failure,()=>document.querySelector('.feedback-failure').textContent='旧文案',()=>document.querySelector('.feedback-failure').textContent='没发出去，内容还在。稍后再试，或加微信：Claraiing');
 await ev(()=>window.__feedbackMode='delay');await click('.feedback-send');await check('发送中',()=>document.querySelector('.feedback-send').disabled&&!!document.querySelector('.feedback-spinner'));await snap('sending');
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await check('减少动态时转圈停止',()=>getComputedStyle(document.querySelector('.feedback-spinner')).animationName==='none');
 await negative('减少动态转圈负对照',()=>getComputedStyle(document.querySelector('.feedback-spinner')).animationName==='none',()=>document.querySelector('.feedback-spinner').style.animation='feedback-spin 800ms linear infinite',()=>document.querySelector('.feedback-spinner').style.removeProperty('animation'));
 await key('Escape');await check('发送中Esc关闭',()=>!document.querySelector('.feedback-card'));await ev(()=>window.__feedbackResolve());await settled();
 await click('.feedback-button');await settled();await edit('textarea','键盘草稿');
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await check('减少动态效果',()=>getComputedStyle(document.querySelector('.feedback-card')).animationName==='none');
 await negative('减少动态效果负对照',()=>getComputedStyle(document.querySelector('.feedback-card')).animationName==='none',()=>document.querySelector('.feedback-card').style.animation='feedback-pop 180ms linear',()=>document.querySelector('.feedback-card').style.removeProperty('animation'));
 await ev(()=>{window.__oldViewport=Object.getOwnPropertyDescriptor(window,'visualViewport');window.__mockViewport=new EventTarget();Object.assign(__mockViewport,{height:400,offsetTop:0});Object.defineProperty(window,'visualViewport',{configurable:true,value:__mockViewport});});
 await key('Escape');await click('.feedback-button');await settled();await snap('keyboard-before');
 await ev(()=>{Object.assign(__mockViewport,{height:300,offsetTop:20});__mockViewport.dispatchEvent(new Event('resize'));document.querySelector('input').focus({preventScroll:true});});
 await settled();await check('模拟键盘上推',()=>{const r=document.querySelector('.feedback-card').getBoundingClientRect();return r.bottom===320&&r.height<=268;});await snap('keyboard-after');
 await negative('键盘底边负对照',()=>document.querySelector('.feedback-card').getBoundingClientRect().bottom===320,()=>document.querySelector('.feedback-card').style.bottom='0px',()=>__mockViewport.dispatchEvent(new Event('resize')));
 await key('Escape');await ev(()=>{if(__oldViewport)Object.defineProperty(window,'visualViewport',__oldViewport);else delete window.visualViewport;});
 await click('.feedback-button');await settled();
 await ev(()=>{window.__backgroundClicks=0;window.__backgroundListener=()=>__backgroundClicks++;document.querySelector('.landing-primary').addEventListener('click',__backgroundListener);});
 await point({x:1,y:1});await settled();
 await check('遮罩关闭不穿透',()=>!document.querySelector('.feedback-card')&&__backgroundClicks===0&&document.activeElement===document.querySelector('.feedback-button'));
 await click('.feedback-button');await settled();await edit('textarea','旋转保留');
 await c.call('Emulation.setDeviceMetricsOverride',{width:1024,height:900,deviceScaleFactor:1,mobile:false});await settled();
 await check('旋转保留草稿与解锁',()=>document.querySelector('textarea').value==='旋转保留'&&document.documentElement.style.overflow!=='hidden');
 await check('旋转不重播',()=>getComputedStyle(document.querySelector('.feedback-card')).animationName==='none');
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await key('Escape');await click('.feedback-button');await settled();
 await check('专项尖角',arrowValid);
 await negative('焦点去向负对照',()=>document.querySelector('.feedback-card').contains(document.activeElement),()=>document.querySelector('.feedback-button').focus({preventScroll:true}),()=>document.querySelector('.feedback-card').focus({preventScroll:true}));
await negative('尖角偏2px',arrowValid,()=>{const a=document.querySelector('.feedback-arrow');a.style.marginLeft='2px';},()=>document.querySelector('.feedback-arrow').style.marginLeft='');
 await ev(()=>{const b=document.querySelector('.feedback-button');window.__oldButton=b.style.cssText;b.style.position='fixed';b.style.top='850px';b.style.left='800px';dispatchEvent(new Event('resize'));});await settled();
 await check('上翻尖角',()=>document.querySelector('.feedback-card').dataset.side==='above');await check('上翻对准',arrowValid);await snap('desktop-flipped');
 await ev(()=>{document.querySelector('.feedback-button').style.cssText=__oldButton;dispatchEvent(new Event('resize'));});
 await key('Escape');
 const baseline=[{key:'字',x:10,y:10}];await dataNegative('逐字位移1px',a=>unchanged(baseline,a),baseline,a=>a[0].y++);
 await check('页面未隐藏',()=>!document.hidden);await single();assert(errors.length===0,'浏览器异常',errors);
 const result={scenes,passed,negatives,detected,shots,arrows,displacements,realDeviceKeyboard:'未验证'};
 await writeFile(join(dir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify({stopped:true,error:error.message,scenes,passed,negatives,detected,shots,arrows,displacements}));throw error;}
finally{
 c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);
 const absolute=resolve(profile);assert(absolute.startsWith(resolve(tmpdir(),'gloss-g73c-')),'安全清理');await rm(absolute,{recursive:true,force:true});
}
