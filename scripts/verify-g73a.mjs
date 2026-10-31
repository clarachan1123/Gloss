import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,freePort}=await import('./verify-g19.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,label)=>{if(!value)throw Error(label);};
async function wait(c,expression){for(let n=0;n<200;n++){if(await c.evaluate(expression))return;await sleep(50);}throw Error('等待失败 '+expression);}
const profile=await mkdtemp(join(tmpdir(),'gloss-g73a-')),port=await freePort();
const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--disable-sync','--no-default-browser-check','--no-first-run',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-allow-origins=*','about:blank'],{stdio:'ignore',windowsHide:true});
let c,scenes=0,shots=0,negatives=0;
const readerEvents=[],readerBreakpoints=new Map(),readerSourceURLs=new Set();let captureError=null;
const run=async(fn,...args)=>c.evaluate(`(${fn.toString()})(${args.map(a=>JSON.stringify(a)).join(',')})`);
const check=async(label,fn,...args)=>{assert(await run(fn,...args),label);scenes++;};
async function negative(label,predicate,mutate,restore,...args){
 assert(await run(predicate,...args),label+' 正对照');await run(mutate);
 try{assert(!await run(predicate,...args),label+' 负对照未检出');negatives++;}finally{await run(restore);}
}
const hiddenHeading=()=>{const h=document.querySelector('.shelf-heading h1');return h?.textContent==='我的书架'&&getComputedStyle(h).clipPath==='inset(50%)'&&h.getBoundingClientRect().width===1;};
const mobileLayout=()=>!document.querySelector('.book-spine,.book-cover,.shelf-ledge,.book-detail')&&document.documentElement.scrollWidth<=document.documentElement.clientWidth;
const goldContrast=()=>{
 const root=getComputedStyle(document.documentElement),probe=document.createElement('i');document.body.append(probe);
 const rgb=v=>v.match(/[\d.]+/g).slice(0,3).map(Number),color=v=>{probe.style.color=v;return rgb(getComputedStyle(probe).color);};
 const lum=arr=>arr.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const gold=color(root.getPropertyValue('--shelf-text')),ratios=Array.from({length:11},(_,i)=>{const l=[lum(gold),lum(color(root.getPropertyValue('--shelf-book-'+i)))].sort((a,b)=>b-a);return(l[0]+.05)/(l[1]+.05);});
 probe.remove();return gold.join(',')==='244,227,186'&&Math.min(...ratios)>=4.5;
};
const menuBounds=()=>{const r=document.querySelector('.spine-menu')?.getBoundingClientRect();return !!r&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;};
const currentOrder=()=>document.querySelector('.mobile-current')?.getAttribute('href')==='/read/probe19'&&[...document.querySelectorAll('.mobile-book')].map(e=>e.dataset.docId).join(',')===[...Array.from({length:19},(_,i)=>'probe'+(18-i)),'sample'].join(',');
const key=async(name)=>{await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name});};
async function reload(){await c.call('Page.reload');await wait(c,"!!document.querySelector('.shelf-page')");await sleep(400);}
async function snapshot(name){const image=await c.call('Page.captureScreenshot',{format:'png'});await writeFile(join(shotDir,name+'.png'),Buffer.from(image.data,'base64'));shots++;}
const shotDir=resolve('tmp-g73b-shots/g73a');await mkdir(shotDir,{recursive:true});
try{
 let tabs;for(let n=0;n<200;n++){try{tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json();if(tabs.some(t=>t.type==='page'))break;}catch{}await sleep(50);}
 assert(tabs.filter(t=>t.type==='page').length===1,'只有一个页面');c=new Cdp(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 // 阅读页直接入队，optout 会阻止存储；在调用处只读捕获实参，不改变退出设置或发送请求。
 c.socket.on('message',async data=>{
  const message=JSON.parse(data);
  try{
   if(message.method==='Debugger.scriptParsed'&&message.params.url.startsWith('http://127.0.0.1:3493/_next/')){
    const {scriptSource}=await c.call('Debugger.getScriptSource',{scriptId:message.params.scriptId});
    const match=/\{event:"reader_enter",source:[^}]+\}/.exec(scriptSource);
    if(match&&!readerSourceURLs.has(message.params.url)){readerSourceURLs.add(message.params.url);const offset=match.index,prior=scriptSource.slice(0,offset),lineNumber=prior.split('\n').length-1,columnNumber=offset-prior.lastIndexOf('\n')-1;
     const {breakpointId}=await c.call('Debugger.setBreakpointByUrl',{url:message.params.url,lineNumber,columnNumber});readerBreakpoints.set(breakpointId,match[0]);}
   }
   if(message.method==='Debugger.paused'){
    try{const id=message.params.hitBreakpoints?.find(id=>readerBreakpoints.has(id));if(id){const result=await c.call('Debugger.evaluateOnCallFrame',{callFrameId:message.params.callFrames[0].callFrameId,expression:'JSON.stringify('+readerBreakpoints.get(id)+')',returnByValue:true});if(result.exceptionDetails)throw Error('本地埋点捕获表达式失败');readerEvents.push(JSON.parse(result.result.value));}}
    finally{await c.call('Debugger.resume');}
   }
  }catch(error){captureError=error.message;}
 });
 await c.call('Debugger.enable');
 const call=c.call.bind(c);
 c.call=async(method,params={})=>{
  if(!['Page.navigate','Page.reload'].includes(method))return call(method,params);
  let handler,timer;const loaded=new Promise((resolve,reject)=>{handler=data=>{if(JSON.parse(data).method==='Page.domContentEventFired')resolve();};c.socket.on('message',handler);timer=setTimeout(()=>reject(Error('导航准备失败')),10000);});
  try{const result=await call(method,params);await loaded;return result;}finally{clearTimeout(timer);c.socket.off('message',handler);}
 };
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('gloss:analytics:optout','1');window.__events=[];addEventListener('gloss:analytics',e=>{__events.push(e.detail);const rows=JSON.parse(sessionStorage.getItem('g73a-events')||'[]');rows.push(e.detail);sessionStorage.setItem('g73a-events',JSON.stringify(rows));});`});
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__shelfVisibleAt=null;const observer=new MutationObserver(()=>{const shelf=document.querySelector('.book-slot,.mobile-current');if(shelf&&shelf.getBoundingClientRect().width>0){observer.disconnect();requestAnimationFrame(()=>window.__shelfVisibleAt=performance.now());}});observer.observe(document,{childList:true,subtree:true});`});
 await c.call('Page.navigate',{url:'http://127.0.0.1:3493/'});await wait(c,"document.readyState==='complete'");
 await c.evaluate(`(()=>{for(let n=0;n<20;n++){const id='probe'+n;localStorage.setItem('gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs:['本地测试正文。'],headings:[],footnotes:[],meta:{format:'txt',fileName:n===1?'这是一本很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的书.txt':'测试书'+n+'.txt',charCount:7},savedAt:100+n}));}localStorage.setItem('gloss:shelf:v1',JSON.stringify({version:1,migratedAt:1,entries:Object.fromEntries(Array.from({length:20},(_,n)=>['probe'+n,{docId:'probe'+n,title:n===1?'这是一本很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的书':'测试书'+n,author:null,addedAt:100+n,lastOpenedAt:1000+n,colorId:'book-'+n%11,widthSeed:n}]))}));})()`);
 const originalBooks=await run(()=>Object.fromEntries(Object.entries(localStorage)));
 const margins=()=>{const first=document.querySelector('.book-slot').getBoundingClientRect(),last=document.querySelector('.import-spine').getBoundingClientRect(),board=document.querySelector('.shelf-ledge').getBoundingClientRect();return{left:first.left-board.left,right:board.right-last.right};};
 const centered=()=>{const first=document.querySelector('.book-slot').getBoundingClientRect(),last=document.querySelector('.import-spine').getBoundingClientRect(),board=document.querySelector('.shelf-ledge').getBoundingClientRect();return Math.abs((first.left-board.left)-(board.right-last.right))<=1;};
 for(const width of [1024,1280,1440])for(const count of [2,6]){
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
  await run(count=>{for(const key of Object.keys(localStorage))if(key.startsWith('gloss:doc:'))localStorage.removeItem(key);const entries={};for(let n=0;n<count-1;n++){const id='center'+n;localStorage.setItem('gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs:['居中验证。'],headings:[],footnotes:[],meta:{format:'txt',fileName:'居中.txt',charCount:5},savedAt:1}));entries[id]={docId:id,title:'居中验证'+n,author:null,addedAt:1,lastOpenedAt:2,colorId:'book-0',widthSeed:n};}localStorage.setItem('gloss:shelf:v1',JSON.stringify({version:1,migratedAt:1,entries}));},count);
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await reload();
  await check('居中 合着 '+width+'/'+count,centered);console.log(JSON.stringify({center:{width,count,state:'closed',...await run(margins)}}));
  if(width===1024&&count===2)await negative('居中',centered,()=>document.querySelector('.shelf-track').style.justifyContent='flex-start',()=>document.querySelector('.shelf-track').style.removeProperty('justify-content'));
  const point=await run(()=>{const r=document.querySelector('.book-slot').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+100};});
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await wait(c,"!!document.querySelector('.book-cover')");await sleep(400);
  const hit=await run(p=>{const el=document.elementFromPoint(p.x,p.y)?.closest('.book-slot'),open=document.querySelector('.book-slot-open'),r=open.getBoundingClientRect();return{id:el?.dataset.docId,open:open.dataset.docId,pointer:p,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};},point);
  console.log(JSON.stringify({center:{width,count,state:'open',...await run(margins)},hit}));assert(hit.id==='center0'&&hit.open==='center0','居中导致鼠标下换书，停止');scenes++;
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+1,y:point.y});await sleep(200);await check('居中翻开不连锁 '+width+'/'+count,()=>document.querySelector('.book-slot-open').dataset.docId==='center0');
  await check('居中 翻开 '+width+'/'+count,centered);
 }
 await run(values=>{localStorage.clear();for(const [key,value]of Object.entries(values))localStorage.setItem(key,value);},originalBooks);
 // 十九本自有书加示例共二十本，取最大书脊宽，保证 1440 宽也形成溢出。
 await run(()=>{localStorage.removeItem('gloss:doc:probe19');const shelf=JSON.parse(localStorage.getItem('gloss:shelf:v1'));delete shelf.entries.probe19;for(const entry of Object.values(shelf.entries))entry.widthSeed=8;localStorage.setItem('gloss:shelf:v1',JSON.stringify(shelf));});
 for(const width of [1024,1280,1440]){
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await reload();
  const result=await run(()=>{const shelf=document.querySelector('.shelf'),track=document.querySelector('.shelf-track'),board=document.querySelector('.shelf-ledge').getBoundingClientRect(),first=document.querySelector('.book-slot').getBoundingClientRect(),padding=parseFloat(getComputedStyle(track).paddingLeft);shelf.scrollLeft=50;return{left:first.left-board.left,padding,scrollLeft:shelf.scrollLeft,overflow:track.scrollWidth>shelf.clientWidth};});
  console.log(JSON.stringify({overflowAlignment:{width,...result}}));assert(result.overflow&&result.left<=result.padding&&result.scrollLeft>0,'溢出左排及横滚');scenes++;
 }
 await run(values=>{localStorage.clear();for(const [key,value]of Object.entries(values))localStorage.setItem(key,value);},originalBooks);
 for(const theme of ['parchment','moon-white','eye-green','dark'])for(const width of [375,390,430,1024,1280,1440]){
 await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
 await c.evaluate(`localStorage.setItem('gloss:settings:appearance','${theme==='dark'?'dark':'light'}');localStorage.setItem('gloss:settings:theme','${theme==='dark'?'parchment':theme}')`);
 await c.call('Page.reload');await wait(c,"!!document.querySelector('.shelf-page')");await sleep(400);
 const snap=async state=>{const image=await c.call('Page.captureScreenshot',{format:'png'});await writeFile(join(shotDir,`${theme}-${width}-${state}.png`),Buffer.from(image.data,'base64'));shots++;};
 await check('读屏标题 '+theme+width,hiddenHeading);await check('十一书色对比度 '+theme+width,goldContrast);
 if(width<768){assert(await c.evaluate("!document.querySelector('.book-spine,.book-cover,.shelf-ledge,.book-detail')&&document.documentElement.scrollWidth<=document.documentElement.clientWidth"),'手机结构及溢出');assert(await c.evaluate("document.querySelector('.mobile-current').getAttribute('href')==='/read/probe19'&&document.querySelectorAll('.mobile-book').length===20&&document.querySelector('.mobile-books .mobile-swipe:last-child .mobile-book').dataset.docId==='sample'"),'手机顺序');scenes+=2;await snap('closed');
 await c.evaluate("document.querySelector('.mobile-books .mobile-more').click();document.querySelector('.mobile-books .mobile-swipe-actions button').click()");
 }else{assert(await c.evaluate("!document.querySelector('.book-slot-open,.book-detail')"),'初始全合');scenes++;await snap('closed');
 const p=await c.evaluate("(()=>{const r=document.querySelector('.book-slot').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+100}})()");await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await wait(c,"!!document.querySelector('.book-cover')");await sleep(400);await snap('open');
 await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await sleep(200);assert(await c.evaluate("document.querySelectorAll('.book-cover').length===1"),'移开保持');scenes++;
 await c.evaluate("document.querySelectorAll('.book-slot')[1].focus()");assert(await c.evaluate("document.activeElement===document.querySelectorAll('.book-slot')[1]&&document.activeElement.classList.contains('book-slot-open')"),'键盘焦点');scenes++;
 await c.evaluate("document.querySelector('.book-cover').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:500,clientY:400}))");}
 await wait(c,"!!document.querySelector('.spine-menu')");assert(await c.evaluate("!document.querySelector('.book-detail')&&(()=>{const r=document.querySelector('.spine-menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"),'菜单与详情');scenes++;await snap('menu');
 await c.evaluate("innerWidth<768?(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.mobile-books .mobile-more').click();document.querySelectorAll('.mobile-books .mobile-swipe-actions button')[1].click();})():[...document.querySelectorAll('.spine-menu button')].find(b=>b.textContent==='从书架移除').click()");await wait(c,"!!document.querySelector('.remove-confirm')");await snap('remove');await c.evaluate("document.querySelector('.remove-confirm button').click()");
 await c.evaluate("document.querySelector('.import-spine,.mobile-list-heading button').click()");await wait(c,"!!document.querySelector('.import-panel')");await snap('import');await c.evaluate("document.querySelector('.import-close').click()");
 }
 // 负对照复用正对照函数，并在每次检出后恢复原样。
 await run(()=>{localStorage.setItem('gloss:settings:appearance','light');localStorage.setItem('gloss:settings:theme','parchment');});
 await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});await reload();
 await negative('读屏标题',hiddenHeading,()=>document.querySelector('h1').style.clipPath='none',()=>document.querySelector('h1').style.removeProperty('clip-path'));
 await negative('手机溢出',mobileLayout,()=>document.querySelector('.mobile-books').style.width='1200px',()=>document.querySelector('.mobile-books').style.removeProperty('width'));
 await negative('手机顺序',currentOrder,()=>document.querySelector('.mobile-current').setAttribute('href','/read/wrong'),()=>document.querySelector('.mobile-current').setAttribute('href','/read/probe19'));
 await negative('金字对比度',goldContrast,()=>document.documentElement.style.setProperty('--shelf-text','#000000'),()=>document.documentElement.style.removeProperty('--shelf-text'));
 await run(()=>{document.querySelector('.mobile-books .mobile-more').click();document.querySelector('.mobile-books .mobile-swipe-actions button').click();});
 await wait(c,"!!document.querySelector('.spine-menu')");
 await negative('菜单边界',menuBounds,()=>{window.oldMenuLeft=document.querySelector('.spine-menu').style.left;document.querySelector('.spine-menu').style.left='-500px';},()=>document.querySelector('.spine-menu').style.left=window.oldMenuLeft);
 await key('Escape');await check('手机 Esc 焦点恢复',()=>!document.querySelector('.spine-menu')&&document.activeElement===document.querySelector('.mobile-book'));
 await c.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await reload();
 const spineTruncation=()=>{const el=document.querySelector('[data-doc-id="probe1"] .spine-title'),style=getComputedStyle(el);return style.writingMode==='vertical-rl'&&style.whiteSpace==='nowrap'&&style.textOverflow==='ellipsis'&&el.scrollHeight>el.clientHeight;};
 await check('长书名书脊单列截断',spineTruncation);
 await negative('书脊截断',spineTruncation,()=>document.querySelector('[data-doc-id="probe1"] .spine-title').style.textOverflow='clip',()=>document.querySelector('[data-doc-id="probe1"] .spine-title').style.removeProperty('text-overflow'));
 // 使用真实鼠标坐标核对行内替换后的命中范围与相邻切换。
 const point=await run(()=>{const r=document.querySelector('.book-slot').getBoundingClientRect();return{x:r.left+20,y:r.top+120};});
 await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await wait(c,"!!document.querySelector('.book-cover')");await sleep(400);
 const next=await run(()=>{const r=document.querySelectorAll('.book-slot')[1].getBoundingClientRect();return{x:r.left+20,y:r.top+120};});
 await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',...next});await sleep(600);
 const hit=p=>{const b=document.querySelector('.book-slot-open'),r=b.getBoundingClientRect();return b.dataset.docId==='probe1'&&p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom;};
 await check('相邻切换一次且封面包含鼠标',hit,next);
 await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:next.x+1,y:next.y});await sleep(200);await check('不连锁翻书',()=>document.querySelector('.book-slot-open').dataset.docId==='probe1');
 await negative('翻书命中盒',hit,()=>document.querySelector('.book-slot-open').style.transform='translateX(-1000px)',()=>document.querySelector('.book-slot-open').style.removeProperty('transform'),next);
 await run(()=>document.querySelectorAll('.book-slot')[0].focus());await key('Tab');await check('Tab 到下一本且链接不替换',()=>document.activeElement===document.querySelectorAll('.book-slot')[1]&&document.activeElement.classList.contains('book-slot-open'));
 const focusValid=()=>document.activeElement===document.querySelector('.book-slot-open');
 await negative('焦点保持',focusValid,()=>document.activeElement.blur(),()=>document.querySelector('.book-slot-open').focus());
 await check('长书名封面三行',()=>{const t=document.querySelector('.cover-title');return getComputedStyle(t).webkitLineClamp==='3'&&t.scrollHeight>t.clientHeight;});await snapshot('parchment-1280-long-title');
 await run(()=>document.querySelectorAll('.book-slot')[19].focus());await sleep(600);
 const overflow=()=>{const s=document.querySelector('.shelf'),t=document.querySelector('.shelf-track'),b=document.querySelector('.book-slot-open').getBoundingClientRect(),l=document.querySelector('.shelf-ledge');return t.scrollWidth>s.clientWidth&&b.left>=0&&b.right<=innerWidth&&l.offsetWidth>=t.scrollWidth;};
 await check('二十本溢出自动横滚与层板延展',overflow);await snapshot('parchment-1280-twenty-books-overflow');
 await negative('层板延展',overflow,()=>document.querySelector('.shelf-ledge').style.width='10px',()=>document.querySelector('.shelf-ledge').style.removeProperty('width'));
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await run(()=>document.querySelectorAll('.book-slot')[1].focus());
 const reduced=()=>getComputedStyle(document.querySelector('.book-cover')).animationName==='none';await check('减少动态效果',reduced);
 await negative('减少动态效果',reduced,()=>document.querySelector('.book-cover').style.animation='shelf-open 320ms linear',()=>document.querySelector('.book-cover').style.removeProperty('animation'));
 await c.call('Emulation.setEmulatedMedia',{features:[]});
 for(const method of ['Escape','outside','scroll']){
  await run(()=>document.querySelector('.book-cover').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:400,clientY:400})));await wait(c,"!!document.querySelector('.spine-menu')");
  if(method==='Escape')await key('Escape');else if(method==='scroll')await run(()=>window.dispatchEvent(new Event('scroll')));else await run(()=>document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})));
  await wait(c,"!document.querySelector('.spine-menu')");
  await check('菜单关闭与焦点 '+method,()=>!document.querySelector('.spine-menu')&&document.activeElement===document.querySelector('.book-slot-open'));
 }
 for(const [width,selector,entry,open] of [[1280,'.book-slot','cover',false],[1280,'.book-slot','cover',true],[1280,'.continue-reading','continue',false],[375,'.mobile-current','continue',false],[375,'.mobile-book','cover',false],[1280,'.book-slot[data-doc-id="sample"]',null,true]]){
  console.log(JSON.stringify({entryCase:{width,selector,entry,open}}));
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await c.call('Page.navigate',{url:'http://127.0.0.1:3493/'});await wait(c,"!!document.querySelector('.shelf-page')");await sleep(300);await run(()=>sessionStorage.setItem('g73a-events','[]'));readerEvents.length=0;
  if(open){await run(sel=>document.querySelector(sel).focus(),selector);await sleep(400);}
  await run(sel=>document.querySelector(sel).scrollIntoView({block:'center',behavior:'instant'}),selector);
  await wait(c,`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('a')===el;})()`);
  const rect=await run(sel=>{const r=document.querySelector(sel).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);
  await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});await wait(c,"location.pathname.startsWith('/read/')&&!!document.querySelector('.reader-body')");
  for(let n=0;n<200&&!readerEvents.length&&!captureError;n++)await sleep(50);assert(!captureError,'本地捕获错误 '+captureError);
  const events=[...await run(()=>JSON.parse(sessionStorage.getItem('g73a-events'))),...readerEvents],valid=rows=>{const clicks=rows.filter(e=>e.event==='shelf_book_click');return(entry===null?clicks.length===0:clicks.length===1&&clicks[0].entry===entry)&&rows.some(e=>e.event==='reader_enter'&&e.source==='shelf');};assert(valid(events),'点击入口与 reader_enter '+selector+' '+JSON.stringify(events));scenes++;
  assert(!valid(events.map(e=>e.event==='reader_enter'?{...e,source:'direct'}:e)),'入口负对照未检出');negatives++;
  await run(()=>document.querySelector('.reader-shelf-back').click());await wait(c,"!!document.querySelector('.shelf-page')");await check('阅读页返回时全合',()=>!document.querySelector('.book-slot-open,.book-detail'));
 }
 await c.call('Page.navigate',{url:'http://127.0.0.1:3493/'});await wait(c,"!!document.querySelector('.shelf-page')");await run(()=>document.querySelector('.book-slot').focus());await run(()=>document.querySelector('.remove-book').click());await run(()=>document.querySelector('.remove-confirm button:last-child').click());await wait(c,"!document.querySelector('[data-doc-id=probe0]')");await check('移除正文与条目',()=>localStorage.getItem('gloss:doc:probe0')===null&&!!document.querySelector('[data-doc-id=probe1]'));
 await c.call('Debugger.disable');
 const fixture=await readFile(resolve('test-fixtures/社会哲学概论-全书.txt'),'utf8'),source=fixture.repeat(Math.ceil(200000/fixture.length)).slice(0,200000),paragraphs=source.match(/[\s\S]{1,400}/g);
 const seed=(count,paragraphs)=>{for(const k of Object.keys(localStorage))if(k.startsWith('gloss:doc:')||k.startsWith('gloss:pos:'))localStorage.removeItem(k);const entries={};for(let n=0;n<count;n++){const id='perf'+n;localStorage.setItem('gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs,headings:[],footnotes:[],meta:{format:'txt',fileName:'耗时.txt',charCount:paragraphs.join('').length},savedAt:1}));entries[id]={docId:id,title:'耗时'+n,author:null,addedAt:1,lastOpenedAt:1,colorId:'book-0',widthSeed:n};}localStorage.setItem('gloss:shelf:v1',JSON.stringify({version:1,migratedAt:1,entries}));};
 const detailMs=[],firstShelfMs=[];
 for(let n=0;n<3;n++){
  await run(seed,1,paragraphs);await c.call('Page.navigate',{url:'http://127.0.0.1:3493/'});await wait(c,"!!document.querySelector('.book-slot')");
  detailMs.push(await c.evaluate(`new Promise(resolve=>{const start=performance.now(),observer=new MutationObserver(()=>{if(document.querySelector('.book-detail dl')?.textContent.includes('20.0 万字')){observer.disconnect();resolve(performance.now()-start);}});observer.observe(document.body,{subtree:true,childList:true});document.querySelector('.book-slot').focus();})`));
  await run(seed,20,paragraphs.join('').slice(0,10000).match(/[\s\S]{1,400}/g));await c.call('Page.navigate',{url:'http://127.0.0.1:3493/'});await wait(c,'window.__shelfVisibleAt!==null');firstShelfMs.push(await c.evaluate('window.__shelfVisibleAt'));
 }
 const median=a=>[...a].sort((a,b)=>a-b)[1],report={scenes,passed:scenes,negatives,detected:negatives,shots,shotDir,detailMs,detailMedianMs:median(detailMs),firstShelfMs,firstShelfMedianMs:median(firstShelfMs),timingDefinition:'详情：focus 到计数和字数渲染；首屏：navigationStart 到书架可见后下一帧'};
 await writeFile(resolve('tmp-g73a-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 assert((await(await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t=>t.type==='page').length===1,'收尾只有一个页面');
}catch(error){if(c)console.log(JSON.stringify({failed:error.message,state:await run(()=>({path:location.pathname,focus:document.activeElement?.outerHTML.slice(0,300),events:sessionStorage.getItem('g73a-events')})),readerEvents,captureError}));throw error;}
finally{c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);const absolute=resolve(profile);assert(absolute.startsWith(resolve(tmpdir(),'gloss-g73a-')),'安全清理');await rm(absolute,{recursive:true,force:true});}
