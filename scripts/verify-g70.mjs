/** G-70: deterministic CDP-only generation; production candidates :3482 / baseline :3483. */
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,setup,freePort,evaluate,revealControls,change,align}=await import('./verify-g19.mjs');
const WIDTHS=[375,506,768,1024,1280,1440], SIZES=[15,17.5,18,21];
const KEY='gloss:settings:reader-typography';
const DEFAULT={version:1,fontSize:17.5,lineHeight:1.75,lineChars:32,bodyFont:'sans',glossFont:'serif'};
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FIXED='这是固定的本地白话，用来检查字体放大和面板增长时原文是否保持原位。'.repeat(4);
const TEXT=Array.from({length:18},(_,p)=>Array.from({length:8},(_,s)=>`第${p+1}段第${s+1}句介绍树林里的一次观察，雨后的树叶和溪流显得十分清楚。`).join('')).join('\n\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,label,detail)=>{if(!ok)throw Error(label+(detail===undefined?'':': '+JSON.stringify(detail)));};
process.env.G76_IMPORT_ONLY='1';
const {whiteBlockFacts,assertWhiteBlocks,whiteBlockNegatives,g76UIFacts,assertG76UI,g76UINegatives}=await import('./verify-g76.mjs');
const report={A:0,B:0,C:0,D:0,E:0,reveal:[],revealNegative:[],noAnchor:0,topExceptions:0,negative:[],nonzero:{growth:0,rounding:0},styles:[],hashes:[],tallest:[],baseline:{total:0,unstable:0}};
async function health(c){const s=await c.evaluate('({hidden:document.hidden,ever:window.__g70?.hidden,error:window.__g70?.error})');assert(!s.hidden&&!s.ever&&!s.error,'Visible error-free page',s);const {targetInfos}=await c.call('Target.getTargets');assert(targetInfos.filter(t=>t.type==='page').length===1,'Exactly one page');}
async function wait(c,expr,label){const end=Date.now()+20000;while(Date.now()<end){await health(c);if(await c.evaluate('Boolean('+expr+')'))return;await sleep(100);}throw Error('Timeout: '+label);}
async function frames(c,n=2){await c.evaluate(`new Promise(r=>{let n=${n};function tick(){if(--n<=0)r();else requestAnimationFrame(tick)}requestAnimationFrame(tick)})`);await health(c);}
async function settle(c){await sleep(350);await frames(c);}
function install(){
  localStorage.setItem('gloss:analytics:optout','1');localStorage.setItem('gloss:sample:breathed','1');
  const g=window.__g70={hidden:document.hidden,error:null,gate:0,trace:null,reads:[],collect:false};
  addEventListener('visibilitychange',()=>{if(document.hidden){g.hidden=true;g.error='document hidden';}});
  const rects=Range.prototype.getClientRects;
  Range.prototype.getClientRects=function(){const r=rects.call(this),span=this.startContainer.parentElement?.closest('.sentence');if(g.collect&&span&&r[0])g.reads.push({key:span.closest('[data-para]').dataset.para+':'+(Number(span.dataset.offset)+this.startOffset),y:r[0].top});return r;};
  for(const type of ['pointerdown','click'])document.addEventListener(type,e=>{if(e.target.closest('.reader-size-stepper button,input[data-typography]')){g.collect=true;g.reads=[];}},true);
  for(const type of ['pointerdown','click'])window.addEventListener(type,()=>{if(g.collect&&g.reads.length&&g.trace)g.trace.locks.push(g.reads.at(-1));g.collect=false;});
  const nativeFetch=fetch.bind(window);
  window.fetch=async(input,options)=>{const response=await nativeFetch(input,options);if(!/\/api\/(gloss|explain)$/.test(String(input))||!response.ok)return response;const text=await response.text();let at=0,timer;return new Response(new ReadableStream({start(controller){const send=()=>{if(options?.signal?.aborted){controller.close();return;}if(at>=text.length){controller.close();return;}if(at<g.gate){const end=Math.min(at+4,g.gate,text.length);controller.enqueue(new TextEncoder().encode(text.slice(at,end)));at=end;}timer=setTimeout(send,120);};timer=setTimeout(send,120);},cancel(){clearTimeout(timer);}}),{status:response.status,headers:response.headers});};

  g.characterRect=key=>{const [para,offset]=key.split(':').map(Number);for(const span of document.querySelectorAll('[data-para="'+para+'"] .sentence')){const start=Number(span.dataset.offset),node=span.firstChild;if(!(node instanceof Text)||offset<start||offset>=start+node.length)continue;const range=document.createRange();range.setStart(node,offset-start);range.setEnd(node,offset-start+1);const r=range.getClientRects()[0];return r?{x:r.x,y:r.y,left:r.left,right:r.right,top:r.top,bottom:r.bottom}:null;}return null;};
  g.productReference=()=>{const body=document.querySelector('.reader-body-reader');if(!body)return null;const viewport=visualViewport,visibleTop=Math.max(viewport?.offsetTop??0,innerWidth<768?document.querySelector('.col-left')?.getBoundingClientRect().bottom??0:0),sheet=document.querySelector('.reader-typography-sheet'),floating=document.querySelector('.reader-typography-floating-aa[data-visible="true"]'),visibleBottom=Math.min(visibleTop+(viewport?.height??innerHeight),sheet?.getBoundingClientRect().top??Infinity,floating?.getBoundingClientRect().top??Infinity),popover=document.querySelector('.reader-typography-popover')?.getBoundingClientRect();for(const span of body.querySelectorAll('.sentence')){const bounds=span.getBoundingClientRect();if(bounds.bottom<=visibleTop)continue;if(bounds.top>=visibleBottom)break;const node=span.firstChild,container=span.closest('[data-para]');if(!(node instanceof Text)||!container)continue;for(let c=0;c<node.length;c++){const range=document.createRange();range.setStart(node,c);range.setEnd(node,c+1);const rect=range.getClientRects()[0];if(rect&&rect.top>=visibleTop&&rect.bottom<=visibleBottom&&node.data[c].trim()&&(!popover||Math.min(rect.right,popover.right)<=Math.max(rect.left,popover.left)||Math.min(rect.bottom,popover.bottom)<=Math.max(rect.top,popover.top)))return{key:container.dataset.para+':'+(Number(span.dataset.offset)+c),y:rect.top};}}return null;};
  g.obstructed=key=>{if(!key)return null;const r=g.characterRect(key),p=document.querySelector('.reader-typography-popover')?.getBoundingClientRect();return !!(r&&p&&Math.min(r.right,p.right)>Math.max(r.left,p.left)&&Math.min(r.bottom,p.bottom)>Math.max(r.top,p.top));};
  g.captureStart=()=>{const t=g.trace;if(!t||t.stop)return;const recomputed=g.productReference();const product=innerWidth<768&&t.mobileLockedKey?{key:t.mobileLockedKey,y:t.mobileLockedTop}:recomputed;if(innerWidth<768&&product&&!t.mobileLockedKey){t.mobileLockedKey=product.key;t.mobileLockedTop=product.y;}const record={scriptKey:t.key,productKey:product?.key??null,same:t.key===product?.key,scriptBlockedBefore:g.obstructed(t.key),productBlockedBefore:g.obstructed(product?.key),scriptBefore:g.characterRect(t.key),productBefore:product?g.characterRect(product.key):null,scrollBefore:scrollY,productFrames:[]};t.observations??=[];t.observations.push(record);t.currentObservation=record;};
  for(const type of ['input','change','click','pointerdown'])document.addEventListener(type,e=>{if(e.target.closest('input[data-typography="fontSize"],.reader-size-stepper button'))g.captureStart();},true);

  g.panels=()=>[...document.querySelectorAll('.reader-body-reader .gloss-panel')].map(p=>({index:p.dataset.sentenceIndex,height:p.getBoundingClientRect().height,top:p.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom,state:p.dataset.state,min:p.style.minHeight}));
  g.raw=key=>{const r=__g19.rect(key);return{...r,panels:g.panels(),translate:getComputedStyle(document.querySelector('.reader-body-reader')).translate,scrollY};};
  g.start=(key,top=false)=>{const before=g.raw(key);g.trace={key,before,frames:[],locks:[],stop:false,top,target:null,raf:null};const t=g.trace;function tick(){if(t.stop)return;const row=g.raw(key);row.dy=row.y-before.y;row.dx=row.x-before.x;t.frames.push(row);if(t.currentObservation?.productKey){const o=t.currentObservation,r=g.characterRect(o.productKey);o.productFrames.push({x:r?.x,y:r?.y,dx:r?r.x-o.productBefore.x:null,dy:r?r.y-o.productBefore.y:null,scrollY,blocked:g.obstructed(o.productKey)});}if(document.hidden){g.error='document hidden';t.stop=true;return;}if(t.frames.length>=900){g.error='Sampler reached stop bound';t.stop=true;return;}t.raf=requestAnimationFrame(tick);}t.raf=requestAnimationFrame(tick);};
  g.end=()=>{const t=g.trace;t.stop=true;cancelAnimationFrame(t.raf);for(const o of t.observations??[]){o.scriptAfter=g.characterRect(o.scriptKey);o.productAfter=o.productKey?g.characterRect(o.productKey):null;o.scriptBlockedAfter=g.obstructed(o.scriptKey);o.productBlockedAfter=g.obstructed(o.productKey);o.scrollAfter=scrollY;}return{...t,after:g.raw(t.key)};};
  const scroll=window.scrollTo;window.scrollTo=function(...args){const t=g.trace;if(t&&typeof args[0]==='object'&&args[0].top===0){const target=scrollY+__g19.rect(t.key).y-t.before.y;if(target<0)t.target=target;}return scroll.apply(this,args);};
}
async function interceptReplayFault(raw,p,files){
  const response=await raw('Fetch.getResponseBody',{requestId:p.requestId});
  const body=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;
  const matches=[...body.matchAll(/\(\)=>([A-Za-z_$][\w$]*)\.revealProgress\?\.shown\?\?0/g)];
  if(!matches.length){await raw('Fetch.continueRequest',{requestId:p.requestId});return;}
  assert(matches.length===1,'负对照整文件初始化匹配恰好一处',{count:matches.length});
  const from=matches[0][0],alias=matches[0][1];
  assert(body.split(from).length===2,'负对照原文恰好一处');
  const to='()=>(window.__g70?.replayFault?(window.__g70.replayFaultHits=(window.__g70.replayFaultHits??0)+1,0):'+alias+'.revealProgress?.shown??0)';
  const changed=body.replace(from,to),path=new URL(p.request.url).pathname;
  files.add(path);assert(files.size===1,'负对照仅修改一个构建模块');
  console.log(JSON.stringify({faultModule:path,matches:matches.length}));
  await raw('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:p.responseStatusCode,responseHeaders:(p.responseHeaders??[]).filter(h=>!['content-length','content-encoding'].includes(h.name.toLowerCase())),body:Buffer.from(changed).toString('base64')});
}

async function launch(origin,width,fn,replayFaultInjection=false){
  const profile=await mkdtemp(join(tmpdir(),'gloss-g70-')),port=await freePort();
  assert(resolve(profile).startsWith(resolve(tmpdir(),'gloss-g70-')),'Safe profile');
  const edge=spawn(EDGE,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let c,browser,passed=false;const errors=[];
  try{let target;const end=Date.now()+20000;while(Date.now()<end){try{target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');if(target)break;}catch{}await sleep(100);}assert(target,'Edge target');c=new Cdp(target.webSocketDebuggerUrl);browser=new Cdp((await(await fetch('http://127.0.0.1:'+port+'/json/version')).json()).webSocketDebuggerUrl);
    await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    if(replayFaultInjection)await c.call('Network.setCacheDisabled',{cacheDisabled:true});c.g70FaultFiles=new Set();
    c.g70Diagnostics=[];c.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Runtime.consoleAPICalled'&&m.params.args?.[0]?.value==='G70DIAG')c.g70Diagnostics.push(JSON.parse(m.params.args[1].value));});
    const raw=c.call.bind(c);c.call=async(method,params={})=>{if(!['Page.navigate','Page.reload'].includes(method))return raw(method,params);let handler,timer;const loaded=new Promise((r,j)=>{handler=data=>{if(JSON.parse(data).method==='Page.domContentEventFired')r();};c.socket.on('message',handler);timer=setTimeout(()=>j(Error('Navigation DOMContentLoaded timeout')),20000);});try{const result=await raw(method,params);await loaded;await raw('Page.bringToFront');return result;}finally{clearTimeout(timer);c.socket.off('message',handler);}};
    c.socket.on('message',async data=>{const m=JSON.parse(data);if(m.method!=='Fetch.requestPaused')return;try{const p=new URL(m.params.request.url).pathname;if(replayFaultInjection&&p.endsWith('.js')){await interceptReplayFault(raw,m.params,c.g70FaultFiles);return;}const body=p==='/api/gloss'?FIXED:p==='/api/explain'?[JSON.stringify({type:'sentence',text:FIXED.slice(0,60)}),JSON.stringify({type:'done'}),''].join('\n'):p==='/api/structure'?JSON.stringify({structure:'固定本地结构。',prompt:'structure-v1'}):null;assert(body!==null,'Unexpected API',p);await raw('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:p==='/api/explain'?'application/x-ndjson':'text/plain; charset=utf-8'}],body:Buffer.from(body).toString('base64')});}catch(e){errors.push(e.message);}});
    await c.call('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'},...(replayFaultInjection?[{urlPattern:'*/_next/static/chunks/*.js',requestStage:'Response'}]:[])]});await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${setup.toString()})();(${install.toString()})();(${installReveal.toString()})();window.__g70.autoMarginFacts=${autoMarginFacts.toString()};`});
    const nav=async path=>{await c.call('Page.navigate',{url:origin+path});await settle(c);};
    await nav('/');await wait(c,"!!document.querySelector('.landing-secondary')",'landing');
    const inputPath=join(profile,'gloss-g70-import.txt');await writeFile(inputPath,TEXT);
    await c.evaluate("document.querySelector('.landing-secondary').click()");await wait(c,"!!document.querySelector('input[type=file]')",'import input');await c.call('DOM.enable');const doc=await c.call('DOM.getDocument'),input=await c.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});await c.call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[inputPath]});
    await wait(c,"location.pathname.startsWith('/read/')&&document.querySelector('.reader-body-reader')?.dataset.measuring==='false'",'actual imported reader');await settle(c);const own=await c.evaluate('location.pathname');
    const result=await fn(c,nav,own);await health(c);assert(!errors.length,'Interception errors',errors);passed=true;return result;
  }finally{try{if(browser)await browser.call('Browser.close');}finally{if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);c?.close();browser?.close();}const absolute=resolve(profile);assert(absolute.startsWith(resolve(tmpdir(),'gloss-g70-')),'Safe cleanup');try{await rm(absolute,{recursive:true,force:true});}catch(e){if(!passed)throw e;console.warn('Profile cleanup warning: '+e.code);}}
}
async function reset(c,nav,own,size=17.5){await evaluate(c,(key,value,id)=>{localStorage.setItem(key,JSON.stringify(value));localStorage.setItem('gloss:settings:reading-mode','review');localStorage.removeItem('gloss:saved:'+id);localStorage.removeItem('gloss:explain:'+id);localStorage.setItem('gloss:settings:gloss-shape','inline');},KEY,{...DEFAULT,fontSize:size},own.split('/').at(-1));await nav(own);await wait(c,"document.querySelector('.reader-body-reader')?.dataset.measuring==='false'",'reader measured');}
async function click(c,selector){const p=await evaluate(c,s=>{const el=document.querySelector(s);if(!el)throw Error('Missing selector '+s);const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle(c);}
async function openPanel(c,index,gate=Infinity){await evaluate(c,(index,gate)=>{__g70.gate=gate===null?Infinity:gate;const g=__g19.glyphs().find(g=>g.index===index&&g.char.trim());dispatchEvent(new WheelEvent('wheel'));scrollTo({top:scrollY+g.y-150,behavior:'instant'});},index,gate===Infinity?null:gate);await settle(c);await evaluate(c,index=>{const g=__g19.glyphs().find(g=>g.index===index&&g.char.trim()),span=[...document.querySelectorAll('.sentence')].find(s=>Number(s.dataset.index)===index);span.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:g.x+1,clientY:g.y+1}));},index);await wait(c,`!!document.querySelector('.gloss-panel[data-sentence-index="${index}"]')`,'panel');if(gate===Infinity)await wait(c,`document.querySelector('.gloss-panel[data-sentence-index="${index}"]')?.dataset.state==='done'`,'panel done');await settle(c);}
async function bubble(c,width){
  if(width<768){await revealControls(c,width);await evaluate(c,()=>{const b=[...document.querySelectorAll('.reader-typography-sheet button')].find(b=>b.textContent.trim()==='气泡');if(!b)throw Error('Missing mobile bubble button');b.click();});await settle(c);await evaluate(c,()=>document.querySelector('[aria-label="关闭阅读设置"]').click());}
  else await evaluate(c,()=>{const b=document.querySelector('.reader-shape-cycle');if(!b)throw Error('Missing desktop shape cycle');if(b.textContent.includes('小字'))b.click();});
  await settle(c);
}
async function checkSize(c,size,expected=true){const result=await evaluate(c,()=>[...document.querySelectorAll('.reader-body-reader .gloss-panel,.reader-body-reader .gloss-panel-text,.reader-body-reader .gloss-term,.reader-body-reader .explain-result-text,.reader-body-reader .action-row-save,.reader-body-reader .action-row-explain,.reader-body-reader .gloss-panel-note,.reader-body-reader .explain-result-note,.reader-body-reader .action-row-notice')].map(el=>({class:el.className,font:parseFloat(getComputedStyle(el).fontSize),line:parseFloat(getComputedStyle(el).lineHeight),spacing:getComputedStyle(el).letterSpacing,placement:el.closest(".action-row")?.dataset.actionPlacement})));assert(result.length,'Font samples exist');for(const r of result){const target=r.placement&&r.class.includes('action-row-explain')&&r.placement==='side'?12:r.placement&&r.class.includes('action-row-')&&!r.class.includes('notice')?13:r.class.includes('action-row-notice')?12:(r.class.includes('panel-note')||r.class.includes('result-note'))?Math.max(14,size*.8)*.85:Math.max(14,size*.8);assert(Math.abs(r.font-target)<1e-6,'A gloss formula',{size,target,r});if(r.class==='gloss-panel-text')assert(Math.abs(r.line/r.font-2.05)<1e-6,'Panel line multiplier',r);}if(expected)report.A++;return result;}

function ownedShelfState(){
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  return !document.querySelector('.landing-secondary')&&[...document.querySelectorAll(innerWidth<768?'.mobile-book,.mobile-current':'.book-slot')].some(visible);
}
const adaptationNegatives=new Set();
async function ownedShelf(c,width){
  await wait(c,'('+ownedShelfState.toString()+')()','owned shelf');
  const key='owned-shelf-'+width;if(adaptationNegatives.has(key))return;
  const state=await evaluate(c,()=>{
    const nodes=[...document.querySelectorAll(innerWidth<768?'.mobile-book,.mobile-current':'.book-slot')];
    window.__g70ShelfNodes=nodes.map(el=>[el,el.style.display]);for(const el of nodes)el.style.display='none';
  });
  let detected=false;try{detected=!await evaluate(c,ownedShelfState);}finally{await evaluate(c,()=>{for(const [el,value] of window.__g70ShelfNodes)el.style.display=value;delete window.__g70ShelfNodes;});}
  assert(detected,'当前断点书单准备负对照');adaptationNegatives.add(key);report.negative.push({adaptation:key,detected});
}
function brandingFacts(){
  const css=el=>getComputedStyle(el),rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom};};
  const root=document.documentElement,oldTheme=root.dataset.theme,tokens=[];
  for(const theme of ['parchment','moon-white','eye-green','dark']){
    root.dataset.theme=theme;const s=css(root);tokens.push({theme,english:s.getPropertyValue('--brand-english').trim(),lockup:s.getPropertyValue('--brand-lockup').trim()});
  }root.dataset.theme=oldTheme;
  const probe=document.createElement('span');document.body.append(probe);probe.style.fontFamily='var(--font-brand)';const englishFont=css(probe).fontFamily;probe.style.fontFamily='var(--font-brand-chinese)';const chineseFont=css(probe).fontFamily;
  const color=token=>{probe.style.color='var('+token+')';return css(probe).color;};
  const rows=[...document.querySelectorAll('.brand-wordmark')].map(el=>{
    const en=el.querySelector('.brand-english'),zh=el.querySelector('.brand-chinese'),reader=!!el.closest('.col-left'),size=reader?20:el.closest('.shelf-brand-footer')?18:el.closest('.landing-header')&&innerWidth<768?22:26;
    const s=css(en),z=zh&&css(zh);return{reader,size,text:en.textContent,font:s.fontFamily,weight:s.fontWeight,fontSize:parseFloat(s.fontSize),color:s.color,expectedColor:color(reader?'--ink':'--brand-english'),en:rect(en),zh:zh?{text:zh.textContent,font:z.fontFamily,weight:z.fontWeight,size:z.fontSize,color:z.color,expectedColor:color('--gloss'),spacing:z.letterSpacing,margin:z.marginRight,...rect(zh)}:null};
  });
  const h=document.querySelector('.shelf-heading'),mobileHeader=h&&innerWidth<768?{title:document.querySelector('.shelf-mobile-title')?.textContent,size:css(document.querySelector('.shelf-mobile-title')).fontSize,weight:css(document.querySelector('.shelf-mobile-title')).fontWeight,lockup:rect(document.querySelector('.brand-lockup')),role:document.querySelector('.brand-lockup').getAttribute('role'),label:document.querySelector('.brand-lockup').getAttribute('aria-label'),gap:css(document.querySelector('.shelf-mobile-brand')).gap,feedback:rect(h.querySelector('[aria-label="体验反馈"]')),icon:!!h.querySelector('[aria-label="体验反馈"] svg'),footer:!!document.querySelector('.shelf-brand-footer')}:null;
  probe.remove();return{englishFont,chineseFont,tokens,rows,mobileHeader};
}
function assertBranding(f){
  for(const t of f.tokens){assert(t.english.toLowerCase()===(t.theme==='dark'?'#e4ded3':'#233448'),'品牌英文 token',t);assert(t.lockup.includes(t.theme==='dark'?'/brand/brand-lockup-dark.png':'/brand/brand-lockup.png'),'品牌图片 token',t);}
  assert(f.rows.length>0,'品牌节点存在');
  for(const r of f.rows){assert(r.text==='Glossline'&&r.font===f.englishFont&&r.weight==='600'&&r.fontSize===r.size&&r.color===r.expectedColor,'品牌英文规格',r);assert(r.reader?!r.zh:!!r.zh,'阅读页只放英文',r);
    if(r.zh){const z=r.zh;assert(z.text==='句下'&&z.font===f.chineseFont&&z.weight==='500'&&z.size==='11px'&&z.color===z.expectedColor&&z.spacing==='5.5px'&&z.margin==='-5.5px','品牌中文规格',r);if(r.en.w&&z.w)assert(z.y>=r.en.b&&Math.abs(z.x+z.w/2-r.en.x-r.en.w/2)<3,'品牌上下居中',r);}
  }
  if(f.mobileHeader){const h=f.mobileHeader;assert(h.title==='我的书架'&&h.size==='20px'&&Number(h.weight)>=600&&h.lockup.w===59&&h.lockup.h===36&&h.role==='img'&&h.label==='Glossline 句下'&&h.gap==='10px'&&h.feedback.w===44&&h.feedback.h===44&&h.icon&&h.footer,'手机书架页头与落款规格',h);}
}
async function checkBranding(c){
  if(!await c.evaluate("!!document.querySelector('.brand-wordmark')"))return;
  const facts=await evaluate(c,brandingFacts);assertBranding(facts);
  const kind=await c.evaluate("innerWidth+':'+(document.querySelector('.shelf-page')?'shelf':document.querySelector('.landing-page')?'landing':'reader')");
  if(adaptationNegatives.has('brand-'+kind))return;
  for(const field of ['english','chinese','token','lockup','header']){
    if(field==='chinese'&&!facts.rows.some(r=>r.zh)||field==='header'&&!facts.mobileHeader)continue;
    const changed=structuredClone(facts);
    if(field==='english')changed.rows[0].font='Cinzel';
    if(field==='chinese')changed.rows.find(r=>r.zh).zh.font='serif';
    if(field==='token')changed.tokens[0].english='#000000';
    if(field==='lockup')changed.tokens.find(t=>t.theme==='dark').lockup='url(/brand/brand-lockup.png)';
    if(field==='header')changed.mobileHeader.feedback.w=43;
    let detected=false;try{assertBranding(changed);}catch{detected=true;}
    assert(detected,'品牌独立判据负对照 '+field);report.negative.push({adaptation:'brand-'+kind+'-'+field,detected});
  }
  adaptationNegatives.add('brand-'+kind);
}

// 只对双方声明仍为 auto 的水平边距使用实际几何，其他属性保持原比较。
function autoMarginFacts(el){
  const parent=el.parentElement;if(!parent)return null;
  const names=['margin-left','margin-right','margin-inline-start','margin-inline-end'],map=el.computedStyleMap(),s=getComputedStyle(el),p=getComputedStyle(parent),r=el.getBoundingClientRect(),pr=parent.getBoundingClientRect();
  const borderLeft=parseFloat(p.borderLeftWidth),borderRight=parseFloat(p.borderRightWidth);
  const leftGutter=Math.max(0,parent.clientLeft-borderLeft),rightGutter=Math.max(0,parent.offsetWidth-parent.clientWidth-parent.clientLeft-borderRight);
  const contentLeft=pr.left+borderLeft+leftGutter+parseFloat(p.paddingLeft),contentRight=pr.right-borderRight-rightGutter-parseFloat(p.paddingRight);
  return {declarations:Object.fromEntries(names.map(name=>[name,map.get(name)?.toString()])),direction:s.direction,writingMode:s.writingMode,left:r.left-contentLeft,right:contentRight-r.right};
}
function compareAutoMargin(base,actual,property,label){
  const b=base.autoMargins,a=actual.autoMargins;
  if(!b||!a||b.declarations[property]!=='auto'||a.declarations[property]!=='auto'||b.writingMode!=='horizontal-tb'||a.writingMode!=='horizontal-tb')return false;
  const side=property==='margin-left'?'left':property==='margin-right'?'right':property==='margin-inline-start'?(a.direction==='rtl'?'right':'left'):property==='margin-inline-end'?(a.direction==='rtl'?'left':'right'):null;
  if(!side||!Number.isFinite(b[side])||!Number.isFinite(a[side]))return false;
  assert(b[side]===a[side],'B auto margin geometry',{label,node:actual.key,property,side,base:b[side],actual:a[side]});return true;
}
async function autoMarginNegatives(c,rows){
  const row=rows.find(row=>row.key.includes(':ARTICLE:reader-body reader-body-reader'));
  if(!row?.autoMargins||row.autoMargins.declarations['margin-left']!=='auto'||row.autoMargins.declarations['margin-right']!=='auto')return;
  const width=rows[0].viewport,key='auto-margin-'+width;if(adaptationNegatives.has(key))return;
  if(await c.evaluate('location.origin')!==new URL(process.env.G70_CANDIDATE_ORIGIN??'http://127.0.0.1:3482').origin)return;
  for(const fault of ['article-right-1px','parent-padding-1px']){
    await evaluate(c,fault=>{const el=document.querySelector('article.reader-body.reader-body-reader'),parent=el.parentElement;window.__g70.autoMarginRestore={el,parent,article:el.getAttribute('style'),parentStyle:parent.getAttribute('style')};
      if(fault==='article-right-1px'){const values=getComputedStyle(el).translate.split(/\s+/);el.style.translate=((parseFloat(values[0])||0)+1)+'px '+(parseFloat(values[1])||0)+'px';}
      else parent.style.paddingLeft=(parseFloat(getComputedStyle(parent).paddingLeft)+1)+'px';
    },fault);
    let detected=false,criterion;
    try{const changed=await snapshot(c,false);try{compareStyles(rows,changed,key+'/'+fault,false);}catch(error){criterion=error.message;detected=criterion.startsWith('B auto margin geometry')||criterion.startsWith('B standard/old custom computed style');if(!detected)throw error;}}
    finally{await c.evaluate('(()=>{const r=__g70.autoMarginRestore;r.article===null?r.el.removeAttribute("style"):r.el.setAttribute("style",r.article);r.parentStyle===null?r.parent.removeAttribute("style"):r.parent.setAttribute("style",r.parentStyle);delete __g70.autoMarginRestore;})()');await wait(c,"document.querySelector('.reader-body-reader')?.dataset.measuring==='false'",'auto margin negative restored');}
    assert(detected,'自动边距负对照检出 '+fault);if(fault==='article-right-1px')assert(criterion.startsWith('B auto margin geometry'),'右移必须由自动边距几何检出');
    compareStyles(rows,await snapshot(c,false),key+'/restore',false);report.negative.push({adaptation:key+'-'+fault,detected,criterion});
  }
  for(const mode of ['both-fixed','one-fixed']){
    const b=structuredClone(row),a=structuredClone(row);b.textLayout=a.textLayout=false;b.referenceStyles=a.referenceStyles=null;
    if(mode==='both-fixed')b.autoMargins.declarations['margin-left']='24.5px';a.autoMargins.declarations['margin-left']='0px';b.styles[0]['margin-left']='24.5px';a.styles[0]['margin-left']='0px';
    let detected=false;try{compareStyles([b],[a],key+'/'+mode,false);}catch(error){detected=error.message.startsWith('B standard/old custom computed style');}
    assert(detected,'非双方 auto 不得几何替代 '+mode);report.negative.push({adaptation:key+'-'+mode,detected});
  }adaptationNegatives.add(key);
  console.log(JSON.stringify({autoMarginNegative:{width,detected:report.negative.filter(row=>row.adaptation?.startsWith(key+'-')).length}}));
}
function savedSectionFacts(){
  const section=document.querySelector('.side-section[aria-labelledby="saved-title"]');if(!section)return null;
  return {title:section.querySelector('#saved-title').textContent.replace(/\s+/g,' ').trim(),empty:section.querySelector(':scope>.side-empty')?.textContent??null,items:[...section.querySelectorAll('.saved-list>li')].map(li=>{const tag=li.querySelector('.saved-kind');return{kind:tag?.dataset.kind,text:tag?.textContent};})};
}
function assertSavedSection(f){
  if(!f)return;assert(f.title==='收藏 · '+f.items.length,'G76收藏标题与实际条目总数',f);
  assert(f.items.length?f.empty===null:f.empty==='在白话或脉络解读下点书签，就会收在这里。','G76收藏空提示',f);
  for(const item of f.items)assert(['gloss','explain'].includes(item.kind)&&item.text===(item.kind==='gloss'?'白话':'脉络解读'),'G76收藏类型签',item);
}
async function snapshot(c,checkMargins=true){
  await c.evaluate('Promise.all([...document.querySelectorAll(".gloss-block,.explain-surface")].flatMap(el=>el.getAnimations({subtree:true})).filter(animation=>animation.animationName==="gloss-block-in").map(animation=>animation.finished.catch(()=>{})))');
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});await settle(c);
  await checkBranding(c);
  const white=await evaluate(c,whiteBlockFacts),ui=await evaluate(c,g76UIFacts);
  const result=await evaluate(c,()=>{
    for(const a of document.getAnimations()){a.pause();a.currentTime=0;}
    const skip=new Set(['SCRIPT','STYLE','LINK','META','TITLE','NEXT-ROUTE-ANNOUNCER']);
    const separate='.wordmark,.reader-sidebar-brand,.brand-wordmark,.shelf-mobile-brand,.shelf-brand-footer,.action-row,.explain-result,.saved-kind,.mode-label,.reader-saved-mobile,.landing-demo-pointer'+(innerWidth<768?',.shelf-heading,.reader-mobile-heading,.reader-mobile-progress-track,.reader-selection-mobile,.reader-typography-aa':'');
    const newVariables=new Set(['--brand-english','--brand-lockup','--font-brand','--font-brand-chinese']);
    const selector='.action-row-save,.action-row-explain,.action-row-notice,.landing-step-answer,.landing-demo-step-text,.mode-label,.reader-saved-empty,.saved-empty,.side-section[aria-labelledby="saved-title"]>.side-empty';
    const protectedNode=el=>el.matches('.reader-body,.reader-body-reader,.sentence,.gloss-panel-text,.explain-result-text,.shell,.col-middle')||!!el.closest('.sentence,.gloss-panel-text,.explain-result-text');
    const nodes=[...document.querySelectorAll('html,body,body *')].filter(el=>!skip.has(el.tagName)&&!el.closest(separate)&&!el.matches('.gloss-block'));
    const readStyles=el=>[null,'::before','::after'].map(p=>{const s=getComputedStyle(el,p);return Object.fromEntries([...s].filter(k=>k!=='--reader-gloss-font-size'&&!newVariables.has(k)).map(k=>[k,s.getPropertyValue(k)]));});
    const box=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{x:r.x,y:r.y,w:r.width,h:r.height,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',scroll:el.scrollWidth,client:el.clientWidth};};
    const panels=[...document.querySelectorAll(".gloss-panel")];
    const rows=nodes.map((el,i)=>({key:i+':'+el.tagName+':'+(el.tagName==='HTML'?'':el.className),styles:readStyles(el),derived:getComputedStyle(el).getPropertyValue('--reader-gloss-font-size'),box:box(el),viewport:innerWidth,autoMargins:window.__g70.autoMarginFacts(el),g76:{
      panel:el.matches(".gloss-panel")?panels.indexOf(el):null,inlinePanel:el.matches(".gloss-panel-inline:has(> .gloss-block, > .explain-result)"),
      panels:panels.map((panel,id)=>el===panel||el.contains(panel)?id:null).filter(id=>id!==null),
      parentPanels:panels.map((panel,id)=>el.parentElement?.contains(panel)?id:null).filter(id=>id!==null),
      white:!!el.closest(".gloss-panel-text"),blockEntry:el.parentElement?.matches(".gloss-block")&&!el.matches(".action-row"),motion:matchMedia("(prefers-reduced-motion: no-preference)").matches,headerGrid:innerWidth<768&&el.matches(".col-left"),
      landingTracks:el.matches(".landing-layout")&&innerWidth>=1000?{demo:el.querySelector(".landing-demonstration").getBoundingClientRect().height,actions:el.querySelector(".landing-action-area").getBoundingClientRect().height,gap:parseFloat(getComputedStyle(el).rowGap)}:null,
      expectedPanelHeight:el.matches(".gloss-panel")&&el.querySelector(":scope>.gloss-block")?[...el.children].reduce((sum,child)=>sum+child.getBoundingClientRect().height+parseFloat(getComputedStyle(child).marginTop)+parseFloat(getComputedStyle(child).marginBottom),0)+parseFloat(getComputedStyle(el).paddingTop)+parseFloat(getComputedStyle(el).paddingBottom)+parseFloat(getComputedStyle(el).borderTopWidth)+parseFloat(getComputedStyle(el).borderBottomWidth):null
    }}));
    const affected=new Set(),changes=[],baseline=!document.querySelector('.brand-wordmark');
    const legacySaved=document.querySelector('.side-section[aria-labelledby="saved-title"]>.side-empty')?.textContent==='点白话下面的「收藏」，这句白话就固定下来，不会再变，并收在这里。';
    const replacements=[['点白话下面的「收藏」，这句白话就固定下来，不会再变，并收在这里。','在白话或脉络解读下点书签，就会收在这里。'],['听不懂','脉络解读'],['取消留下','取消收藏'],['留下的白话','收藏的白话'],['留下','收藏']];
    for(const el of document.querySelectorAll(selector)){
      if(protectedNode(el)||el.closest(separate))continue;
      for(const node of el.childNodes){if(node.nodeType!==Node.TEXT_NODE)continue;const before=node.nodeValue;let after=before;
        if(baseline||legacySaved)for(const [oldName,newName] of replacements)after=after.replaceAll(oldName,newName);
        if(!baseline&&!/脉络解读|收藏/.test(before)&&!el.matches('.side-section[aria-labelledby="saved-title"]>.side-empty')||baseline&&before===after)continue;
        changes.push([node,before,after]);affected.add(el);
        if(el.parentElement){affected.add(el.parentElement);for(const sibling of el.parentElement.children)affected.add(sibling);}
      }
    }
    try{
      if(baseline||legacySaved)for(const [node,,after] of changes)node.nodeValue=after;
      for(let i=0;i<nodes.length;i++){const el=nodes[i];if(!affected.has(el)||protectedNode(el))continue;
        rows[i].textLayout=true;rows[i].referenceStyles=baseline||legacySaved?readStyles(el):null;rows[i].expectedBox=baseline||legacySaved?box(el):null;
        const siblings=[...el.parentElement?.children??[]].filter(other=>other!==el&&!other.contains(el)&&!el.contains(other));
        rows[i].overlap=siblings.some(other=>{const a=box(el),b=box(other);return a.visible&&b.visible&&Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>.5&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>.5;});
      }
    }finally{for(const [node,before] of changes)node.nodeValue=before;}
    return rows;
  });
  result[0].g76Bundle={white,ui,saved:await evaluate(c,savedSectionFacts)};
  if(checkMargins)await autoMarginNegatives(c,result);
  return result;
}

function unchangedStylesNegative(rows,width){
  nodeIdentityNegative(rows,width);
  const key='unchanged-styles-'+width;if(adaptationNegatives.has(key))return;
  const control=rows.map(row=>({...row,textLayout:false,referenceStyles:null}));
  const changed=structuredClone(control),index=changed.findIndex(row=>row.key.includes(':reader-body ' )||row.key.includes(':reader-body-reader'));
  assert(index>=0,'未改正文节点负对照对象存在');changed[index].styles[0].color='rgb(1, 2, 3)';
  let detected=false;try{compareStyles(control,changed,'负对照');}catch(error){detected=error.message.startsWith('B standard/old custom computed style');}
  assert(detected,'未改正文属性仍逐项比较负对照');report.negative.push({adaptation:key,detected});adaptationNegatives.add(key);
}
function normalizeBuildKey(key){
  return key.replace(/[^\s:]*-module__([A-Za-z0-9_$]+)__([A-Za-z0-9_$-]+)/g,'$1_$2');
}
function nodeIdentityNegative(rows,width){
  const key='build-node-identity-'+width;if(adaptationNegatives.has(key))return;
  assert(normalizeBuildKey('14:H1:titlefont_560e4402-module__PZ6qqW__className')===normalizeBuildKey('14:H1:PZ6qqW_className'),'构建类名规范化正对照');
  assert(new Set(['titlefont_560e4402-module__PZ6qqW__className','titlefont_560e4402-module__ABC123__className','titlefont_560e4402-module__PZ6qqW__other'].map(normalizeBuildKey)).size===3,'构建类名规范化保留唯一标识与局部类名');
  const control=rows.map(row=>({...row,textLayout:false,referenceStyles:null}));
  const changed=structuredClone(control),index=changed.findIndex(row=>row.key.includes(':reader-body ' )||row.key.includes(':reader-body-reader'));
  assert(index>=0,'节点身份负对照对象存在');changed[index].key=changed[index].key.replace(/:\w+:/,':SECTION:');
  let detected=false;try{compareStyles(control,changed,'错误节点负对照');}catch(error){detected=error.message.startsWith('B DOM identity');}
  assert(detected,'规范化后错误节点仍检出');report.negative.push({adaptation:key,detected});adaptationNegatives.add(key);
}
const TEXT_SIZE_PROPERTIES=new Set(['width','height','inline-size','block-size','perspective-origin','transform-origin']);
function textLayoutCriterion(base,actual){
  const expected=base.expectedBox,box=actual.box;
  for(const field of ['x','y','w','h'])assert(Math.abs(box[field]-expected[field])<=.5,'改名尺寸与直接推移量',{key:base.key,field,old:base.box[field],expected:expected[field],actual:box[field]});
  if(box.visible){assert(box.scroll<=box.client&&box.x>=-.5&&box.x+box.w<=actual.viewport+.5,'改名文字无溢出',{key:base.key,box});assert(!actual.overlap,'改名文字无重叠',base.key);}
  for(const property of ['font-size','font-family','font-weight'])assert(base.styles[0][property]===actual.styles[0][property],'改名字体保持对照',{key:base.key,property});
}
function textSizeNegatives(base,actual,label){
  const key='text-size-'+label;if(adaptationNegatives.has(key))return;
  const index=base.findIndex((row,i)=>row.textLayout&&row.expectedBox?.visible&&actual[i].box.visible);
  if(index<0)return;
  const original=actual[index];
  for(const fault of ['少字尺寸','多字尺寸','高度','推移量','溢出','字号']){
    const changed=structuredClone(original);
    if(fault==='少字尺寸')changed.box.w-=1;
    if(fault==='多字尺寸')changed.box.w+=1;
    if(fault==='高度')changed.box.h+=1;
    if(fault==='推移量')changed.box.x+=1;
    if(fault==='溢出')changed.box.scroll=changed.box.client+1;
    if(fault==='字号')changed.styles[0]['font-size']='1px';
    let detected=false;try{textLayoutCriterion(base[index],changed);}catch{detected=true;}
    assert(detected,'改名尺寸负对照 '+fault);report.negative.push({adaptation:key+'-'+fault,detected});
  }adaptationNegatives.add(key);
}
function projectG76Styles(base,actual,label,negative=true){
  const width=actual[0].viewport,reference=base[0].g76Bundle,current=actual[0].g76Bundle;
  assertWhiteBlocks(reference.white,current.white,width);assertG76UI(reference.ui,current.ui,width);assertSavedSection(current.saved);
  const projected=structuredClone(base);
  assert(projected.length===actual.length,"G76结构规范化后的节点数",{label,base:projected.length,actual:actual.length});
  const deltas=new Map();
  for(let i=0;i<actual.length;i++){
    const a=actual[i],b=projected[i];assert(normalizeBuildKey(a.key)===normalizeBuildKey(b.key),"G76保留节点身份",{label,base:b.key,actual:a.key});
    if(a.g76.panel!==null){
      if(a.g76.expectedPanelHeight!==null)assert(Math.abs(a.box.h-a.g76.expectedPanelHeight)<=.5,"G76面板高度等于实际块结构",{label,key:a.key,actual:a.box.h,expected:a.g76.expectedPanelHeight});
      deltas.set(a.g76.panel,a.box.h-b.box.h);
    }
  }
  const sum=ids=>ids.reduce((value,id)=>value+(deltas.get(id)??0),0);
  const dimension=new Set(["height","block-size"]),origin=new Set(["perspective-origin","transform-origin"]);
  for(let i=0;i<actual.length;i++){
    const a=actual[i],b=projected[i],dy=a.box.h-b.box.h;
    const root=a.g76.panel!==null,derived=!root&&a.g76.panels.length>0;
    if(derived&&dy!==0)assert(Math.abs(dy-sum(a.g76.panels))<=.5,"G76容器增高等于子面板尺寸差",{label,key:a.key,actual:dy,panels:sum(a.g76.panels)});
    for(let p=0;p<3;p++)for(const property of Object.keys(a.styles[p])){
      const before=b.styles[p][property],after=a.styles[p][property];if(before===after)continue;
      if(a.g76.blockEntry&&p===0&&["animation-name","animation-duration","animation-timing-function"].includes(property)){
        const expected={"animation-name":"gloss-block-in","animation-duration":"0.22s","animation-timing-function":"cubic-bezier(0.2, 0.7, 0.2, 1)"};
        assert(a.g76.motion&&after===expected[property],"G76块进入动画按设计",{label,key:a.key,property,after});
        b.styles[p][property]=after;continue;
      }
      if(a.g76.inlinePanel&&p===0&&["padding-left","padding-inline-start","border-left-width","border-inline-start-width","width","inline-size"].includes(property)){
        const widthProperty=property==="width"||property==="inline-size";
        // CSSOM 以六位有效数字序列化像素值，几何宽度仍逐项精确比较。
        const expected=widthProperty?Number(a.box.w.toPrecision(6)):0;
        assert(a.box.w===b.box.w&&parseFloat(after)===expected,"G76竖线移入白话后面板外框保持",{label,key:a.key,property,after,expected,baseWidth:b.box.w,actualWidth:a.box.w});
        b.styles[p][property]=after;continue;
      }
      if(a.g76.headerGrid&&p===0&&property==="grid-template-columns"){b.styles[p][property]=after;continue;}
      if(root&&["min-height","min-block-size"].includes(property)&&p===0){b.styles[p][property]=after;continue;}
      if((root||derived)&&dimension.has(property)&&p===0){
        assert(Math.abs((parseFloat(after)-parseFloat(before))-dy)<=.5,"G76高度属性与实测尺寸差相同",{label,key:a.key,property,before,after,dy});b.styles[p][property]=after;continue;
      }
      if((root||derived)&&origin.has(property)&&p===0){
        const old=before.split(" ").map(parseFloat),now=after.split(" ").map(parseFloat);
        assert(Math.abs(now[0]-old[0])<=.5&&Math.abs(now[1]-old[1]-dy/2)<=.5,"G76尺寸原点随实测尺寸变化",{label,key:a.key,property,before,after,dy});b.styles[p][property]=after;continue;
      }
      if(derived&&property==="grid-template-rows"&&p===0){
        const old=before.match(/-?[\d.]+px/g)??[],now=after.match(/-?[\d.]+px/g)??[];
        if(a.g76.landingTracks){
          const tracks=a.g76.landingTracks;
          assert(old.length===2&&now.length===2&&Math.abs(parseFloat(now[0])-parseFloat(old[0]))<=.5&&Math.abs(parseFloat(now[1])-Math.max(tracks.actions,tracks.demo-parseFloat(old[0])-tracks.gap))<=.5,"G76演示卡跨两行且按钮区提供最小轨道高度",{label,key:a.key,before,after,tracks});
        }else assert(old.length===now.length&&Math.abs(now.reduce((n,v)=>n+parseFloat(v),0)-old.reduce((n,v)=>n+parseFloat(v),0)-sum(a.g76.panels))<=.5,"G76网格行高只跟随子面板增高",{label,key:a.key,before,after,dy});
        b.styles[p][property]=after;continue;
      }
      if(["bottom","inset-block-end"].includes(property)&&a.g76.parentPanels.length>0&&p===0){
        assert(Math.abs((parseFloat(after)-parseFloat(before))-sum(a.g76.parentPanels))<=.5,"G76相邻绝对定位边界跟随父面板增高",{label,key:a.key,property,before,after});b.styles[p][property]=after;
      }
    }
  }
  if(negative){
    if(current.saved){
      for(const fault of ['标题计数','空提示','类型签']){
        if(fault==='空提示'&&current.saved.empty===null||fault==='类型签'&&!current.saved.items.length)continue;
        const changed=structuredClone(current.saved);if(fault==='标题计数')changed.title='收藏 · 999';if(fault==='空提示')changed.empty='错误提示';if(fault==='类型签')changed.items[0].kind='错误';
        let detected=false;try{assertSavedSection(changed);}catch{detected=true;}assert(detected,'G76收藏区负对照 '+fault);report.negative.push({adaptation:'g76-saved-'+label+'-'+fault,detected});
      }
      const sideIndex=actual.findIndex(a=>a.key.includes(':reader-book-title'));
      if(sideIndex>=0){const changed=structuredClone(actual);changed[sideIndex].styles[0]['font-size']='1px';let detected=false;try{compareStyles(projected,changed,label+'书名负对照');}catch{detected=true;}assert(detected,'G76其余侧栏仍逐项相等负对照');report.negative.push({adaptation:'g76-sidebar-unchanged-'+label,detected});}
    }
    const count=whiteBlockNegatives(reference.white,current.white,width)+g76UINegatives(reference.ui,current.ui,width);
    report.negative.push({adaptation:"g76-components-"+label,detected:true,count});
    const inlinePanelIndex=actual.findIndex(a=>a.g76.inlinePanel);
    if(inlinePanelIndex>=0){
      const changed=structuredClone(actual),panel=changed[inlinePanelIndex];
      panel.box.w+=1;
      panel.styles[0]["inline-size"]=Number(panel.box.w.toPrecision(6))+"px";
      let detected=false;try{projectG76Styles(base,changed,label,false);}catch{detected=true;}assert(detected,"G76面板外框宽度新增1px负对照检出");report.negative.push({adaptation:"g76-panel-width-"+label,detected});
    }
    const trackIndex=actual.findIndex(a=>a.g76.landingTracks);
    if(trackIndex>=0){
      const changed=structuredClone(actual),value=changed[trackIndex].styles[0]["grid-template-rows"].split(" ");
      value[1]=(parseFloat(value[1])+1)+"px";changed[trackIndex].styles[0]["grid-template-rows"]=value.join(" ");
      let detected=false;try{projectG76Styles(base,changed,label,false);}catch{detected=true;}assert(detected,"G76网格轨道新增1px负对照检出");report.negative.push({adaptation:"g76-grid-track-"+label,detected});
    }
    const index=actual.findIndex((a,i)=>a.g76.panel===null&&a.g76.panels.length>0&&a.box.h!==base[i].box.h);
    if(index>=0){const changed=structuredClone(actual);changed[index].box.h+=1;let detected=false;try{projectG76Styles(base,changed,label,false);}catch{detected=true;}assert(detected,"G76容器新增1px负对照检出");report.negative.push({adaptation:"g76-container-height-"+label,detected});}
  }
  return projected;
}
function compareStyles(base,actual,label,count=true){
  assert(base.length===actual.length,'B DOM node count '+label,{base:base.length,actual:actual.length});let vars=0;
  for(let i=0;i<base.length;i++){
    assert(normalizeBuildKey(base[i].key)===normalizeBuildKey(actual[i].key),'B DOM identity '+label,{i,base:base[i].key,actual:actual[i].key});
    if(base[i].textLayout&&base[i].expectedBox)textLayoutCriterion(base[i],actual[i]);
    for(let p=0;p<3;p++){
      const keys=new Set([...Object.keys(base[i].styles[p]),...Object.keys(actual[i].styles[p])]);
      for(const k of keys){
        const expected=p===0&&base[i].referenceStyles&&TEXT_SIZE_PROPERTIES.has(k)?base[i].referenceStyles[p][k]:base[i].styles[p][k];
        const value=actual[i].styles[p][k];
        if(p===0&&compareAutoMargin(base[i],actual[i],k,label))continue;
        assert(expected===value,'B standard/old custom computed style',{label,node:actual[i].key,pseudo:p,property:k,base:expected,actual:value});
      }
    }
    if(base[i].derived!==actual[i].derived)vars++;
  }
  if(!count)return;
  textSizeNegatives(base,actual,label);
  report.B++;report.styles.push({label,nodes:actual.length,standardDifferences:0,newVariableDifferences:vars});
}

async function defaultStates(c,nav,own,width){const out={};await evaluate(c,key=>localStorage.setItem(key,JSON.stringify({version:1,fontSize:21,lineHeight:1.75,lineChars:32,bodyFont:'sans',glossFont:'serif'})),KEY);await evaluate(c,id=>localStorage.removeItem('gloss:doc:'+id),own.split('/').at(-1));await nav('/');await wait(c,"!!document.querySelector('.landing-demo-visible .gloss-panel')",'landing demo panel');await wait(c,"document.querySelector('.landing-demo-visible .gloss-panel')?.dataset.state==='done'",'landing demo completed');assert(await c.evaluate("getComputedStyle(document.querySelector('.landing-demo-visible .gloss-panel')).fontSize")==='14px','Landing ignores stored 21px');out.landing=await snapshot(c);
    // Restore the actual imported document, preserving its parser output from this browser.
    await evaluate(c,doc=>localStorage.setItem('gloss:doc:'+doc.docId,JSON.stringify(doc)),windowDocCache.get(c));await nav('/');await ownedShelf(c,width);out.shelf=await snapshot(c);
    await reset(c,nav,own);out.imported=await snapshot(c);await nav('/read/sample');await wait(c,"document.querySelector('.reader-body-reader')?.dataset.measuring==='false'",'sample');out.sample=await snapshot(c);await reset(c,nav,own);await openPanel(c,0);out.temporary=await snapshot(c);await click(c,'.action-row-save');out.savedInline=await snapshot(c);
    await bubble(c,width);out.savedBubble=await snapshot(c);
    await click(c,'.action-row-explain');await c.evaluate('__g70.gate=Infinity');await wait(c,"!!document.querySelector('.explain-result-text')",'explain text');await wait(c,"document.querySelector('.explain-result')?.getAttribute('aria-busy')==='false'",'explain completed');await settle(c);out.explain=await snapshot(c);
    await revealControls(c,width);out[width<768?'mobileDrawer':'desktopPopover']=await snapshot(c);await reset(c,nav,own);await openPanel(c,0,0);out.generating=await snapshot(c);return out;}
const windowDocCache=new WeakMap();
async function displacement(c,index,source){await evaluate(c,index=>{dispatchEvent(new WheelEvent('wheel'));const g=__g19.glyphs().find(g=>g.index===index&&g.char.trim());scrollTo({top:scrollY+g.y-150,behavior:'instant'});},index);await settle(c);const selected=await evaluate(c,index=>__g19.glyphs().find(g=>g.index===index&&g.char.trim()),index);await evaluate(c,key=>__g70.start(key),selected.key);if(source==='touch'){await c.call('Emulation.setTouchEmulationEnabled',{enabled:true});await c.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:selected.x+1,y:selected.y+8}]});await c.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}else{await c.call('Emulation.setTouchEmulationEnabled',{enabled:false});for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.call('Input.dispatchMouseEvent',{type,x:selected.x+1,y:selected.y+8,pointerType:source,button:type==='mouseMoved'?'none':'left',buttons:type==='mousePressed'?1:0,clickCount:1});}await settle(c);const t=await c.evaluate('__g70.end()');return{key:selected.key,dx:t.after.x-t.before.x,dy:t.after.y-t.before.y,frames:[...new Map(t.frames.map(f=>{const row={dx:f.dx,dy:f.dy,heightDelta:f.panels.filter(p=>p.bottom<=f.y).reduce((s,p)=>s+p.height,0)-t.before.panels.filter(p=>p.bottom<=t.before.y).reduce((s,p)=>s+p.height,0)};return[JSON.stringify(row),row];})).values()],state:t.before.panels.map(p=>[p.index,p.state]),translate:[t.before.translate,t.after.translate]};}
function category(r){if(r.dx===0&&r.dy===0)return'zero';if(r.dx===0&&r.frames.every(f=>f.dy===f.heightDelta))return'growth';if(Math.abs(r.dy)<.5&&r.frames.every(f=>Math.abs(f.dy)<.5&&f.heightDelta===0))return'rounding';return'other';}
async function points(c,nav,own){const rows=[];for(const size of SIZES)for(const source of ['mouse','touch','pen'])for(const kind of ['empty','temporary-above','saved-above','generating-above']){await reset(c,nav,own,size);if(kind!=='empty'){await openPanel(c,0,kind==='generating-above'?0:Infinity);if(kind==='saved-above')await click(c,'.action-row-save');}const r=await displacement(c,kind==='empty'?0:3,source);rows.push({id:[size,source,kind].join('/'),size,...r});}return rows;}
function comparePoints(base1,base2,actual,width){assert(base1.length===base2.length&&actual.length===base1.length,'Same D cases');for(let i=0;i<actual.length;i++){const a=actual[i],b=base1[i],b2=base2[i];report.baseline.total++;const stable=JSON.stringify(b)===JSON.stringify(b2);if(!stable){report.baseline.unstable++;console.log(JSON.stringify({unstableBaseline:{width,id:b.id,first:b,second:b2}}));}assert(report.baseline.unstable/report.baseline.total<=.1,'Baseline instability >10%',report.baseline);assert(stable,'Two identical baseline passes required for case',b.id);assert(a.id===b.id&&a.key===b.key&&JSON.stringify(a.state)===JSON.stringify(b.state),'Same D identity/state',{a,b});if(a.size===17.5){assert(a.dx===b.dx&&a.dy===b.dy,'Default clicked dx/dy equality',{a,b});const allowed=new Set(b.frames.map(f=>JSON.stringify([f.dx,f.dy])));assert(a.frames.every(f=>allowed.has(JSON.stringify([f.dx,f.dy]))),'Default per-frame equality',{a,b});}else if(category(b)==='zero'){assert(a.dx===0&&a.dy===0&&a.frames.every(f=>f.dx===0&&f.dy===0),'Main zero requires strict candidate zero',{a,b});}else{const cat=category(a);assert(cat!=='other'&&cat===category(b),'Same nondefault displacement category',{a,b});if(cat==='growth'){assert(a.frames.every(f=>f.dy===f.heightDelta),'Own above-panel growth sum',a);report.nonzero.growth++;}else{assert(Math.abs(a.dy)<.5&&a.dx===b.dx,'Subpixel translate class',a);report.nonzero.rounding++;}}report.D++;}}
async function locks(c,nav,own,width){for(const kind of ['empty','temporary-above','temporary-below','saved-above','saved-below','both','busy-reserved','busy-reveal','explain']){await reset(c,nav,own,17.5);if(kind!=='empty'){await openPanel(c,0,kind.startsWith('busy')?0:Infinity);if(kind.startsWith('saved')||kind==='both')await click(c,'.action-row-save');if(kind==='both')await openPanel(c,2);if(kind==='explain'){await click(c,'.action-row-explain');await c.evaluate('__g70.gate=0');}if(kind==='busy-reveal'){await c.evaluate('__g70.gate=16');await wait(c,"document.querySelector('.gloss-panel-text')?.textContent.length>=8",'partial reveal');}}
    await revealControls(c,width);await align(c,kind.endsWith('below')?0:4);let ref=await c.evaluate('__g70.productReference()');if(!ref){report.noAnchor++;console.log(JSON.stringify({width,kind,result:'无锚点'}));continue;}const heights=await c.evaluate('__g70.panels()');await evaluate(c,key=>__g70.start(key),ref.key);await change(c,'fontSize',21);await change(c,'fontSize',15);if(kind.startsWith('busy')||kind==='explain'){await c.evaluate('__g70.gate=Infinity');await wait(c,"document.querySelector('.gloss-panel')?.dataset.state==='done'",'generation complete during gesture');}await settle(c);const t=await c.evaluate('__g70.end()');console.log(JSON.stringify({criterionCObservation:{width,kind,scriptKey:t.key,observations:t.observations,diagnostic:c.g70Diagnostics,scrollBefore:t.before.scrollY,scrollAfter:t.after.scrollY}}));for(const f of t.frames){const abs=f.translate==='none'?0:Math.max(...f.translate.split(/\s+/).map(v=>Math.abs(parseFloat(v))));assert(abs<1,'C strict lock and translate',{width,kind,key:t.key,frame:f});}const observations=(t.observations??[]).filter(o=>o.productFrames.length);assert(observations.length>0,'C actual gesture samples exist',{width,kind});for(const o of observations)for(const f of o.productFrames)assert(f.dy===0,'C strict lock and translate',{width,kind,key:o.productKey,scriptKey:t.key,frame:f});if(kind!=='empty')assert(t.frames.some(f=>f.panels.some(p=>heights.find(h=>h.index===p.index)?.height!==p.height)),'Panel height actually changes',{width,kind,heights});if(width<768)assert(observations.every(o=>o.productKey===ref.key)&&t.locks.every(l=>l.key===ref.key),'Continuous A-/A+ same reference',{width,kind,ref,locks:t.locks,observations});report.C++;report.tallest.push({width,kind,strictZero:true,largeToSmall:true,panelChanged:kind!=='empty'});
  }
  // Existing book-start exception is recorded separately, never counted as strict passes.
  await reset(c,nav,own,21);await revealControls(c,width);await c.evaluate("dispatchEvent(new WheelEvent('wheel'));scrollTo({top:0,behavior:'instant'})");await settle(c);const ref=await c.evaluate('(()=>{try{return __g19.reference()}catch{return null}})()');if(ref){await evaluate(c,key=>__g70.start(key,true),ref.key);await change(c,'fontSize',15);const t=await c.evaluate('__g70.end()');console.log(JSON.stringify({criterionCObservation:{width,kind:'book-start',scriptKey:t.key,observations:t.observations,diagnostic:c.g70Diagnostics,scrollBefore:t.before.scrollY,scrollAfter:t.after.scrollY}}));const exceptions=t.frames.filter(f=>f.dy!==0);assert(exceptions.every(f=>f.scrollY===0&&t.target<0&&f.dy===t.target),'Existing book-start signed deficit',t);if(exceptions.length)report.topExceptions++;else report.C++;}else report.noAnchor++;
}
async function negative(c,nav,own,width){async function detects(label,inject,check,restore){await inject();let detected=false;try{await check();}catch{detected=true;}await restore();assert(detected,'Negative not detected '+label);report.negative.push({width,label,detected});}
  await reset(c,nav,own,21);await openPanel(c,0);const style=async css=>evaluate(c,css=>{const s=document.createElement('style');s.id='g70-negative';s.textContent=css;document.head.append(s);},css),remove=()=>c.evaluate("document.querySelector('#g70-negative').remove()");
  await detects('fixed-panel-14',()=>style('.reader-body-reader .gloss-panel{font-size:14px!important}'),()=>checkSize(c,21,false),remove);
  await detects('fixed-buttons-14',()=>style('.reader-body-reader .action-row-save,.reader-body-reader .action-row-explain{font-size:14px!important}'),()=>checkSize(c,21,false),remove);
  await revealControls(c,width);await align(c,4);await detects('compensation-disabled',async()=>{await c.evaluate("__g70.oldScrollTo=scrollTo;__g70.oldScrollBy=scrollBy;window.scrollTo=()=>{};window.scrollBy=()=>{};__g70.disable=new MutationObserver(()=>{document.querySelector('.reader-body-reader').style.translate=''});__g70.disable.observe(document.querySelector('.reader-body-reader'),{attributes:true,attributeFilter:['style']});__g70.start(__g19.reference().key)");},async()=>{await change(c,'fontSize',15);const t=await c.evaluate('__g70.end()');assert(t.frames.every(f=>f.dy===0),'Disabled lock drift');},()=>c.evaluate('__g70.disable.disconnect();window.scrollTo=__g70.oldScrollTo;window.scrollBy=__g70.oldScrollBy'));
  await evaluate(c,key=>localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)),fontSize:21})),KEY);await evaluate(c,id=>localStorage.removeItem('gloss:doc:'+id),own.split('/').at(-1));await nav('/');await wait(c,"!!document.querySelector('.landing-demo-visible .gloss-panel')",'negative landing');await detects('landing-leak',()=>style('.landing-demo-visible .gloss-panel{font-size:16.8px!important}'),async()=>assert(await c.evaluate("getComputedStyle(document.querySelector('.landing-demo-visible .gloss-panel')).fontSize")==='14px','Landing isolated'),remove);await evaluate(c,doc=>localStorage.setItem('gloss:doc:'+doc.docId,JSON.stringify(doc)),windowDocCache.get(c));
  await reset(c,nav,own);const glyph=await c.evaluate('__g19.glyphs().find(g=>g.char.trim())');await detects('original-one-pixel-shift',()=>style('.reader-body-reader .sentence{position:relative;left:1px}'),async()=>{const after=await evaluate(c,key=>__g19.rect(key),glyph.key);assert(after.x===glyph.x&&after.y===glyph.y,'Clicked glyph strict geometry');},remove);
}
function layoutHashSnapshot(){
 const changes=[],baseline=!document.querySelector('.brand-wordmark');
 if(baseline)for(const el of document.querySelectorAll('.action-row-save,.action-row-explain,.action-row-notice,.mode-label,.reader-saved-empty,.saved-empty')){
  for(const node of el.childNodes){if(node.nodeType!==Node.TEXT_NODE)continue;const old=node.nodeValue;let text=old;for(const [a,b]of [['听不懂','脉络解读'],['取消留下','取消收藏'],['留下的白话','收藏的白话'],['留下','收藏']])text=text.replaceAll(a,b);if(text!==old){changes.push([node,old]);node.nodeValue=text;}}
 }
 try{
  // 只移除授权面板的正常流占位；原文文本框本身的宽高和余下坐标仍逐项相等。
  const body=document.querySelector('.reader-body-reader');
  const flows=[...body.querySelectorAll('.reader-paragraph')].filter(parent=>parent.querySelector('.gloss-panel')).map(parent=>{
   const panels=[...parent.querySelectorAll('.gloss-panel')],p=parent.getBoundingClientRect(),style=getComputedStyle(parent),source=[...parent.querySelectorAll('.reader-para')],sourceHeight=source.reduce((sum,el)=>sum+el.getBoundingClientRect().height,0),advance=p.height-sourceHeight;
   if(panels.length!==1||!source.length||advance<0||[style.paddingTop,style.paddingBottom,style.borderTopWidth,style.borderBottomWidth].some(value=>parseFloat(value)!==0))throw Error('面板正常流模型不符');
   const panel=panels[0],rect=panel.getBoundingClientRect();return {parent,panel,bottom:rect.bottom,advance,sourceHeight,panelHeight:rect.height};
  });
  window.__g70.hashFlow=flows.map(({advance,sourceHeight,panelHeight})=>({advance,sourceHeight,panelHeight}));
  return [...document.querySelectorAll('.shell,.shell *')].flatMap(el=>{
   if(el.closest('.wordmark,.reader-sidebar-brand,.brand-wordmark,.gloss-panel,.side-section[aria-labelledby="saved-title"]'))return [];
   if(body.contains(el)&&el.querySelector('.gloss-panel')&&!el.querySelector('.sentence'))return [];
   const style=getComputedStyle(el),r=el.getBoundingClientRect();let y=r.y,height=r.height;
   if(el===body||body.contains(el)||el.contains(body))for(const flow of flows){if(el.contains(flow.panel))height-=flow.advance;else if(r.top>=flow.bottom)y-=flow.advance;}
   if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||r.width<=0||height<=0||y+height<=0||y>=innerHeight)return [];
   return [[el.tagName,r.x,y,r.width,height]];
  });
 }finally{for(const [node,old]of changes)node.nodeValue=old;}
}
async function layoutHash(c,nav,own){
 await reset(c,nav,own);await openPanel(c,0);await reset(c,nav,own);
 const snap=layoutHashSnapshot,hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const before=await evaluate(c,snap);await openPanel(c,0);const after=await evaluate(c,snap),origin=await c.evaluate('location.origin'),key='layout-hash-'+origin;
 if(!adaptationNegatives.has(key)){
  for(const [fault,selector,transform]of [['body-x1','.reader-body-reader','translateX(1px)'],['source-y1','.reader-para','translateY(1px)']]){
   const moved=await evaluate(c,(selector,transform)=>{const el=document.querySelector(selector),before=el.getBoundingClientRect();window.__g70HashRestore={el,style:el.getAttribute('style')};el.style.transform=transform;const after=el.getBoundingClientRect();return {x:after.x-before.x,y:after.y-before.y};},selector,transform);
   assert(fault==='body-x1'?moved.x===1:moved.y===1,'哈希负对照实际移动1px',{fault,moved});
   let detected;try{detected=hash(await evaluate(c,snap))!==hash(after);}finally{await c.evaluate('(()=>{const r=__g70HashRestore;r.style===null?r.el.removeAttribute("style"):r.el.setAttribute("style",r.style);delete window.__g70HashRestore;})()');}
   assert(detected,'整页几何哈希检出正文1px '+fault);assert(hash(await evaluate(c,snap))===hash(after),'哈希负对照恢复');report.negative.push({adaptation:key+'-'+fault,detected});
  }adaptationNegatives.add(key);
 }
 (report.hashFlows??=[]).push({origin,flows:await c.evaluate('__g70.hashFlow')});
 return {before:hash(before),after:hash(after)};
}

// E inspects the existing Reader clock through the DOM owner; no product diagnostics.
function installReveal(){
  const g=window.__g70;g.events=[];g.analyticsRequests=[];g.clockIds=new WeakMap();g.clockRefs=new Map();g.nextClockId=0;
  addEventListener('gloss:analytics',event=>g.events.push({...event.detail}));
  const nativeFetch=fetch;window.fetch=function(input,options){if(/\/api\/analytics(?:$|\?)/.test(String(input)))g.analyticsRequests.push({url:String(input),body:options?.body??null});return nativeFetch.apply(this,arguments);};
  const beacon=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(url,data){if(String(url).includes('/api/analytics'))g.analyticsRequests.push({url:String(url),beacon:true});return beacon(url,data);};
  g.clock=index=>{const body=document.querySelector('.reader-body-reader'),key=Object.keys(body??{}).find(k=>k.startsWith('__reactFiber$'));for(let fiber=body?.[key];fiber;fiber=fiber.return){let guard=0;for(let hook=fiber.memoizedState;hook&&typeof hook==='object'&&'memoizedState'in hook&&guard++<200;hook=hook.next){const map=hook.memoizedState?.current,clock=map instanceof Map?map.get(index)?.clock:null;if(clock&&typeof clock.sample==='function'&&typeof clock.visibleMs==='number'){if(!g.clockIds.has(clock))g.clockIds.set(clock,++g.nextClockId);g.clockRefs.set(index,clock);return{id:g.clockIds.get(clock),visibleMs:clock.visibleMs,active:true};}}}const ended=g.clockRefs.get(index);return ended?{id:g.clockIds.get(ended),visibleMs:ended.visibleMs,active:false}:null;};
  g.analytics=()=>({events:g.events.length,requests:g.analyticsRequests.length,storage:Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('gloss:analytics')).sort().map(k=>[k,localStorage.getItem(k)]))});
  g.beginReveal=(index,key)=>{const initial=document.querySelector('.gloss-panel[data-sentence-index="'+index+'"]'),rect=g.characterRect(key);const t=g.revealTrace={index,key,before:{count:Array.from(initial?.querySelector('.gloss-panel-text')?.textContent??'').length,clock:g.clock(index),analytics:g.analytics(),scrollY,rect},frames:[],stop:false,raf:null};let lastPanel=initial,mount=0;function tick(){if(t.stop)return;const panel=document.querySelector('.gloss-panel[data-sentence-index="'+index+'"]');if(panel&&panel!==lastPanel){mount++;lastPanel=panel;}const r=g.characterRect(key);t.frames.push({count:panel?Array.from(panel.querySelector('.gloss-panel-text')?.textContent??'').length:null,state:panel?.dataset.state,mount,clock:g.clock(index),analytics:g.analytics(),dy:r?r.y-rect.y:null,dx:r?r.x-rect.x:null,translate:getComputedStyle(document.querySelector('.reader-body-reader')).translate,scrollY});if(document.hidden||t.frames.length>=360){g.error=document.hidden?'document hidden':'E sampler reached stop bound';t.stop=true;return;}t.raf=requestAnimationFrame(tick);}t.raf=requestAnimationFrame(tick);};
  g.endReveal=()=>{const t=g.revealTrace;t.stop=true;cancelAnimationFrame(t.raf);return{...t,afterAnalytics:g.analytics()};};
}
async function revealGesture(c,width,gesture){
  if(gesture==='A+'||gesture==='A-'){await click(c,gesture==='A+'?'[aria-label="字号增大"]':'[aria-label="字号减小"]');return;}
  if(gesture==='reset'){await click(c,(width<768?'.reader-typography-sheet':'.reader-typography-popover')+' .reader-typography-reset');return;}
  const selector='.reader-typography-popover input[data-typography="fontSize"]';
  const point=await evaluate(c,selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing desktop font-size slider');const r=el.getBoundingClientRect(),fraction=(Number(el.value)-Number(el.min))/(Number(el.max)-Number(el.min));return{x:r.left+8+(r.width-16)*fraction,y:r.top+r.height/2};},selector);
  await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  for(const size of [18,19,21]){await evaluate(c,(selector,size)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(size));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},selector,size);await frames(c);}
  await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await settle(c);
}
async function revealChecks(c,nav,own,width,negative=false){
  const source=await evaluate(c,id=>JSON.parse(localStorage.getItem('gloss:doc:'+id)),own.split('/').at(-1));
  const gestures=width<768?['A+','A-','reset']:['slider','reset'];
  const total=Array.from(FIXED).length,index=8;
  for(const theme of ['parchment','dark'])for(const saved of [false,true])for(const phase of (saved?['complete']:['complete','partial']))for(const gesture of gestures){
    const id=['g70-e',width,theme,saved?'saved':'temporary',phase,gesture==='A+'?'plus':gesture==='A-'?'minus':gesture].join('-'),path='/read/'+id,size=gesture==='reset'?21:17.5;
    await evaluate(c,(doc,id,theme,key,settings)=>{localStorage.setItem('gloss:doc:'+id,JSON.stringify({...doc,docId:id}));localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');localStorage.setItem('gloss:settings:reading-mode','review');localStorage.setItem('gloss:settings:gloss-shape','inline');localStorage.setItem(key,JSON.stringify(settings));},source,id,theme,KEY,{...DEFAULT,fontSize:size});
    await nav(path);await wait(c,"document.querySelector('.reader-body-reader')?.dataset.measuring==='false'",'E reader measured');
    assert(await c.evaluate('document.documentElement.dataset.theme')===theme,'E effective theme matches scenario',{width,theme,saved,phase,gesture});
    await openPanel(c,index,phase==='partial'?Math.floor(total/2):Infinity);
    if(phase==='partial')await wait(c,`Array.from(document.querySelector('.gloss-panel[data-sentence-index="${index}"] .gloss-panel-text')?.textContent??'').length>=${Math.floor(total/2)}`,'E genuine partial reveal');
    if(saved){await evaluate(c,index=>__g70.clock(index),index);await click(c,'.action-row-save');}
    await revealControls(c,width);
    if(gesture==='reset')await evaluate(c,width=>{const button=document.querySelector((width<768?'.reader-typography-sheet':'.reader-typography-popover')+' .reader-typography-reset');if(!button)throw Error('Missing E reset button');button.scrollIntoView({block:'nearest',behavior:'instant'});},width);
    await align(c,index+2);
    const ref=await c.evaluate('__g70.productReference()');assert(ref,'E original-text anchor exists',{width,theme,saved,phase,gesture});
    await evaluate(c,(index,key)=>__g70.beginReveal(index,key),index,ref.key);
    const before=await c.evaluate('__g70.revealTrace.before');assert(before.clock&&before.clock.visibleMs>0,'E clock already accrued real visible time',{width,theme,saved,phase,gesture,before});assert(before.clock.active===!saved,'E expected active or explicitly ended clock',{width,theme,saved,phase,gesture,before});assert(before.scrollY>0,'E non-book-start anchor',{width,theme,saved,phase,gesture,before});
    assert(phase==='complete'?before.count===total:before.count>4&&before.count<total,'E real initial reveal state',{phase,total,before});
    if(negative)await c.evaluate('__g70.replayFault=true;__g70.replayFaultHits=0');
    await revealGesture(c,width,gesture);await c.evaluate('__g70.gate=Infinity');
    if(negative){const hits=await c.evaluate('__g70.replayFaultHits??0');assert(c.g70FaultFiles.size===1&&hits>0,'回放负对照唯一模块单处源码注入且运行命中大于0',{modules:c.g70FaultFiles.size,hits,width,theme,saved,phase,gesture});console.log(JSON.stringify({replayInjection:{modules:c.g70FaultFiles.size,hits,width,theme,saved,phase,gesture}}));}
    await wait(c,`document.querySelector('.gloss-panel[data-sentence-index="${index}"]')?.dataset.state==='done'`,'E reveal reaches full text');await settle(c);
    const t=await c.evaluate('__g70.endReveal()'),first=t.frames.find(f=>f.mount>0&&f.count!==null),rows=t.frames.filter(f=>f.mount>0&&f.count!==null),label={width,theme,saved,phase,gesture};
    assert(first&&rows.length,'E actual remount observed',label);
    const fall=rows.some(f=>f.count<before.count),monotonic=rows.every((f,i)=>i===0||f.count>=rows[i-1].count),full=rows.every(f=>f.count===total);
    if(negative&&!saved){assert(fall,'E base negative detects reveal fallback',{...label,before,rows});report.revealNegative.push({...label,detected:true,from:before.count,to:Math.min(...rows.map(f=>f.count))});}
    else{
      assert(phase==='complete'?full:!fall&&monotonic,'E first-frame and monotonic reveal',{...label,total,before,rows});
      if(phase==='partial')assert(first.count<total,'E partial remount must not jump to full text',{...label,total,first});
      for(const f of t.frames){assert(f.dy===0,'E strict original glyph lock',{...label,key:ref.key,frame:f});const n=f.translate==='none'?0:Math.max(...f.translate.split(/\s+/).map(v=>Math.abs(parseFloat(v))));assert(n<1,'E translate less than 1px',{...label,frame:f});}
      if(!negative)report.E++;
    }
    assert(rows.at(-1).count===total,'E finishes full text',{...label,total,last:rows.at(-1)});
    if(!negative){
      assert(t.frames.every((f,i)=>f.clock?.id===before.clock.id&&f.clock.active===before.clock.active&&f.clock.visibleMs>=before.clock.visibleMs&&(i===0||f.clock.visibleMs>=t.frames[i-1].clock.visibleMs)),'E same clock and nondecreasing accrued time',{...label,before,frames:t.frames});
      assert(JSON.stringify(first.analytics)===JSON.stringify(before.analytics),'E no event/queue/request change at remount',{...label,before:before.analytics,first:first.analytics});
      if(phase==='complete')assert(JSON.stringify(t.afterAnalytics)===JSON.stringify(before.analytics),'E completed remount emits no new events or sends',{...label,before:before.analytics,after:t.afterAnalytics});
      else{if(width<768){assert(t.afterAnalytics.events===before.analytics.events,'E mobile sheet pauses natural completion until reader resumes',{...label,before:before.analytics,after:t.afterAnalytics});await evaluate(c,()=>document.querySelector('[aria-label="关闭阅读设置"]').click());await settle(c);}const details=await evaluate(c,start=>__g70.events.slice(start),before.analytics.events);assert(details.length===1&&details[0].event==='gloss_complete','E partial natural completion emits exactly its original completion',{...label,details});assert(t.afterAnalytics.requests===before.analytics.requests&&JSON.stringify(t.afterAnalytics.storage)===JSON.stringify(before.analytics.storage),'E partial local queue/sends unchanged',{...label,before:before.analytics,after:t.afterAnalytics});}
      report.reveal.push({...label,total,before:before.count,first:first.count,final:rows.at(-1).count,frames:t.frames.length,clockBefore:before.clock.visibleMs,clockAfter:rows.at(-1).clock.visibleMs,extraRemountEvents:0,strictZero:true});
    }
    console.log(JSON.stringify({criterionE:{...label,negative,fall,total,before:before.count,first:first.count,final:rows.at(-1).count,frames:t.frames.length}}));
  }
}
async function suite(origin,width,candidate,revealNegative=false){return launch(origin,width,async(c,nav,own)=>{windowDocCache.set(c,await evaluate(c,id=>JSON.parse(localStorage.getItem('gloss:doc:'+id)),own.split('/').at(-1)));const styles=await defaultStates(c,nav,own,width);unchangedStylesNegative(styles.imported,width);const pointsResult=await points(c,nav,own);let hashes;if(width===1024)hashes=await layoutHash(c,nav,own);if(candidate){for(const size of SIZES)for(const saved of [false,true])for(const shape of ['inline','bubble']){await reset(c,nav,own,size);await openPanel(c,0);if(saved)await click(c,'.action-row-save');if(shape==='bubble'){await bubble(c,width);}await checkSize(c,size);}await locks(c,nav,own,width);await negative(c,nav,own,width);}if([375,768,1280].includes(width)&&(candidate||revealNegative))await revealChecks(c,nav,own,width,revealNegative);return{styles,points:pointsResult,hashes};},revealNegative);}

async function diagnose(origin,order){return launch(origin,768,async(c,nav,own)=>{await reset(c,nav,own,17.5);await revealControls(c,768);await align(c,4);const ref=await c.evaluate('__g19.reference()');await evaluate(c,key=>__g70.start(key),ref.key);const steps=[];for(const value of [21,15]){const start=c.g70Diagnostics.length;await change(c,'fontSize',value);steps.push({value,diagnostic:c.g70Diagnostics.slice(start),state:await c.evaluate('({script:__g70.characterRect(__g70.trace.key),scriptBlocked:__g70.obstructed(__g70.trace.key),scrollY,observations:__g70.trace.observations})')});}await settle(c);const trace=await c.evaluate('__g70.end()');const row={origin,order,scriptKey:ref.key,dx:trace.after.x-trace.before.x,dy:trace.after.y-trace.before.y,steps,trace};console.log(JSON.stringify({diagnosis:row}));return row;});}
if(process.env.G70_DIAG_ONLY==='1'){const rows=[];for(let order=1;order<=6;order++)rows.push(await diagnose(order%2?'http://127.0.0.1:3482':'http://127.0.0.1:3483',order));await writeFile(resolve(import.meta.dirname,'../tmp-g70-diagnosis.json'),JSON.stringify(rows,null,2));console.log('G-70 diagnosis collection completed');}
else {

const baselineOrigin=process.env.G70_BASELINE_ORIGIN??'http://127.0.0.1:3483',candidateOrigin=process.env.G70_CANDIDATE_ORIGIN??'http://127.0.0.1:3482';
for(const width of WIDTHS){console.log(JSON.stringify({width,stage:'baseline-pass-1'}));const b1=await suite(baselineOrigin,width,false,true);console.log(JSON.stringify({width,stage:'baseline-pass-2'}));const b2=await suite(baselineOrigin,width,false);console.log(JSON.stringify({width,stage:'candidate'}));const a=await suite(candidateOrigin,width,true);for(const state of Object.keys(b1.styles)){compareStyles(projectG76Styles(b1.styles[state],a.styles[state],width+'/'+state),a.styles[state],width+'/'+state);}comparePoints(b1.points,b2.points,a.points,width);if(width===1024){assert(JSON.stringify(a.hashes)===JSON.stringify(b1.hashes),'Default 1024 visible layout hashes',{a:a.hashes,b:b1.hashes});report.hashes.push({width,...a.hashes});}console.log(JSON.stringify({width,completed:true,counts:{A:report.A,B:report.B,C:report.C,D:report.D,E:report.E}}));}
console.log(JSON.stringify(report));
console.log('G-70 gloss-size checks passed');

}
