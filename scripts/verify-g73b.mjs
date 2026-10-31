// G-73b：先执行短屏硬门槛，失败即停止后续矩阵，所有取样均有截止时间。
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,freePort}=await import('./verify-g19.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,label,detail)=>{if(!ok)throw Error(label+' '+JSON.stringify(detail??null));};
const origin='http://127.0.0.1:3501';
const shotDir=resolve('tmp-g73b-shots');await mkdir(shotDir,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'gloss-g73b-')),port=await freePort();
const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--disable-sync','--no-default-browser-check','--no-first-run',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-allow-origins=*','about:blank'],{stdio:'ignore',windowsHide:true});
let c,scenes=0,passed=0,shots=0,negatives=0,detected=0;
const requests=[];
const directEvents=[],eventBreakpoints=new Map(),eventSources=new Set();let captureError=null;
const baselineOrigin='http://127.0.0.1:3502';
const evaluate=(fn,...args)=>c.evaluate(`(${fn.toString()})(${args.map(a=>JSON.stringify(a)).join(',')})`);
async function wait(expression,label){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await c.evaluate(expression))return;await sleep(50);}throw Error('等待失败 '+label);}
async function single(){const pages=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t=>t.type==='page');assert(pages.length===1,'只有一个页面',pages.length);}
async function snap(name){const image=await c.call('Page.captureScreenshot',{format:'png'});await writeFile(join(shotDir,name+'.png'),Buffer.from(image.data,'base64'));shots++;}
function geometry(){
 const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
 const area=document.querySelector('.landing-action-area'),layout=document.querySelector('.landing-layout');
 const card=document.querySelector('.landing-demonstration'),stage=document.querySelector('.landing-demo-stage');
 const row=document.querySelector('.landing-demo-visible .action-row'),current=document.querySelector('.landing-demo-step-current');
 return{viewport:{width:innerWidth,height:innerHeight},actions:rect(area),tailPadding:parseFloat(getComputedStyle(layout).paddingBottom),tailSpace:document.documentElement.scrollHeight-(card.getBoundingClientRect().bottom+scrollY),reservedHeight:parseFloat(document.querySelector('.landing-page').style.getPropertyValue('--landing-actions-height')),card:rect(card),stage:rect(stage),row:row?rect(row):null,current:current?rect(current):null,scrollY};
}
try{
 let target;const deadline=Date.now()+20000;
 while(Date.now()<deadline){const response=await fetch(`http://127.0.0.1:${port}/json`).catch(()=>null);if(response){const pages=(await response.json()).filter(t=>t.type==='page');assert(pages.length===1,'启动只有一个页面',pages.length);target=pages[0];break;}await sleep(100);}
 assert(target,'Edge 启动');c=new Cdp(target.webSocketDebuggerUrl);await single();
 // 直接入队事件在 optout 下也只读捕获调用实参，不改变退出设置。
 c.socket.on('message',async data=>{
  const m=JSON.parse(data);
  try{
   if(m.method==='Debugger.scriptParsed'&&m.params.url.startsWith(origin+'/_next/')&&!eventSources.has(m.params.url)){
    eventSources.add(m.params.url);const {scriptSource}=await c.call('Debugger.getScriptSource',{scriptId:m.params.scriptId});
    for(const match of scriptSource.matchAll(/\{event:"(?:landing_view|reader_enter|sample_doc_enter)"[^}]*\}/g)){
     const prior=scriptSource.slice(0,match.index),lineNumber=prior.split('\n').length-1,columnNumber=match.index-prior.lastIndexOf('\n')-1;
     const {breakpointId}=await c.call('Debugger.setBreakpointByUrl',{url:m.params.url,lineNumber,columnNumber});eventBreakpoints.set(breakpointId,match[0]);
    }
   }
   if(m.method==='Debugger.paused'){
    try{const id=m.params.hitBreakpoints?.find(id=>eventBreakpoints.has(id));if(id){const r=await c.call('Debugger.evaluateOnCallFrame',{callFrameId:m.params.callFrames[0].callFrameId,expression:'JSON.stringify('+eventBreakpoints.get(id)+')',returnByValue:true});if(r.exceptionDetails)throw Error('埋点实参捕获失败');directEvents.push(JSON.parse(r.result.value));}}
    finally{await c.call('Debugger.resume');}
   }
  }catch(e){captureError=e.message;}
 });
 await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Debugger.enable');await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});c.socket.on('message',data=>{const m=JSON.parse(data);if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);});
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('gloss:analytics:optout','1');window.__g73bEvents=[];addEventListener('gloss:analytics',e=>window.__g73bEvents.push(e.detail));`});
 // 先用减少动态效果记录三种手机高度，避免把自动播放准备过程算成产品结论。
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 for(const [width,height] of [[375,667],[390,844],[430,932]]){
  await c.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await c.call('Page.navigate',{url:origin+'/'});await wait("!!document.querySelector('.landing-demo-visible .action-row')",'演示终态');await c.evaluate('document.fonts.ready');
  const value=await evaluate(geometry);console.log(JSON.stringify({footerMeasurement:value}));
  scenes++;assert(Math.abs(value.actions.height-value.reservedHeight)<.5&&value.tailPadding>=value.actions.height+24,'实测等高尾部留白',value);passed++;
  await c.evaluate("scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})");await sleep(100);
  const end=await evaluate(geometry);scenes++;assert(end.row.y>=0&&end.row.bottom<=end.actions.y,'末尾操作行能滚至吸底区上方',end);passed++;
  await snap(`${width}-${height}-reduce-footer`);
 }
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:1,deviceScaleFactor:1,mobile:false});
 await c.call('Page.navigate',{url:origin+'/'});await wait("!!document.querySelector('.landing-demo-visible')",'短屏准备');await c.evaluate('document.fonts.ready');
 await c.evaluate("scrollTo({top:document.querySelector('.landing-demonstration').getBoundingClientRect().top+scrollY,behavior:'instant'})");
 await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:667,deviceScaleFactor:1,mobile:false});
 await wait("!!document.querySelector('.landing-demo-pointer-explain-clicking')",'短屏解释点击检查点');
 const checkpoint=await evaluate(geometry);await snap('375-667-explain-clicking');console.log(JSON.stringify({shortScreenCheckpoint:checkpoint}));
 scenes++;assert(checkpoint.row&&checkpoint.current&&checkpoint.row.y>=0&&checkpoint.row.bottom<=checkpoint.actions.y&&checkpoint.current.y>=0&&checkpoint.current.bottom<=checkpoint.actions.y,'375×667 原节奏下步骤与演示操作行必须同时位于吸底区上方',checkpoint);passed++;
 console.log(JSON.stringify({shortScreenGatePassed:true,scenes,passed,shots,shotDir}));
 const check=async(label,predicate,...args)=>{scenes++;assert(await evaluate(predicate,...args),label);passed++;};
 const negative=async(label,predicate,selector,property,value,...args)=>{
  assert(await evaluate(predicate,...args),label+' 正对照');
  const previous=await evaluate((sel,prop,v)=>{const el=document.querySelector(sel),old=[el.style.getPropertyValue(prop),el.style.getPropertyPriority(prop)];el.style.setProperty(prop,v,'important');return old;},selector,property,value);
  negatives++;
  try{assert(!await evaluate(predicate,...args),label+' 负对照未检出');detected++;console.log(JSON.stringify({negative:label,detected:true}));}
  finally{await evaluate((sel,prop,old)=>{const el=document.querySelector(sel);old[0]?el.style.setProperty(prop,old[0],old[1]):el.style.removeProperty(prop);},selector,property,previous);}
 };
 const layoutValid=(width)=>{
  const css=sel=>getComputedStyle(document.querySelector(sel)),box=sel=>document.querySelector(sel).getBoundingClientRect();
  const title=css('h1'),header=css('.landing-header'),layout=css('.landing-layout'),actions=css('.landing-action-area'),card=css('.landing-demonstration');
  const mobile=width<768,desktop=width>=1000;
  const probe=document.createElement('span');probe.style.cssText='position:absolute;visibility:hidden;font-size:clamp(52px, 5.4vw, 80px)';document.body.append(probe);const expectedSize=mobile?'46px':getComputedStyle(probe).fontSize;probe.remove();
  return document.querySelector('h1').textContent==='哪句不懂，点哪句。'&&title.fontWeight==='900'&&title.fontSize===expectedSize&&
   css('h1 em').textDecorationLine.includes('underline')&&css('h1 em').textDecorationThickness===(mobile?'3px':'4px')&&
   document.querySelectorAll('h1 em').length===1&&document.querySelector('h1>span:last-child em').textContent==='哪句'&&
   css('.landing-subtitle').display===(mobile?'block':'none')&&css('.landing-steps').display===(desktop?'block':'none')&&
   css('.landing-demo-steps').display===(desktop?'none':'block')&&actions.position===(mobile?'fixed':'static')&&
   header.paddingTop===(mobile?'14px':desktop?'28px':'24px')&&header.paddingLeft===(mobile?'20px':desktop?'64px':'24px')&&
   (!desktop||(box('.landing-formats').height<21&&box('.landing-formats').right<=box('.landing-demonstration').left))&&box('.landing-layout').width<=1312&&(!desktop||Math.abs(parseFloat(layout.columnGap)-72)<.01)&&
   card.borderTopWidth==='1px'&&card.borderRadius==='10px'&&card.overflow==='hidden'&&card.boxShadow!=='none'&&
   css('.landing-primary').minHeight===(mobile?'56px':'60px')&&css('.landing-secondary').minHeight==='44px'&&
   css('.landing-header .feedback-shelf-icon').display!=='none'&&document.documentElement.scrollWidth<=document.documentElement.clientWidth;
 };
 const negativeData=(label,predicate,valid,mutate)=>{
  assert(predicate(valid),label+' 正对照');const bad=structuredClone(valid);mutate(bad);negatives++;assert(!predicate(bad),label+' 负对照未检出');detected++;console.log(JSON.stringify({negative:label,detected:true}));
 };
 const negativeRuntime=async(label,predicate,mutate,restore)=>{
  assert(await evaluate(predicate),label+' 正对照');await evaluate(mutate);negatives++;
  try{assert(!await evaluate(predicate),label+' 负对照未检出');detected++;console.log(JSON.stringify({negative:label,detected:true}));}finally{await evaluate(restore);}
 };
 const sameOrigin=()=>requests.filter(url=>/^https?:/.test(url)).every(url=>new URL(url).origin===origin);
 for(const theme of ['parchment','moon-white','eye-green','dark'])for(const width of [1024,1280,1440,375,390,430]){
  const height=width<768?({375:667,390:844,430:932}[width]):900;
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:1,deviceScaleFactor:1,mobile:false});
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await c.call('Page.navigate',{url:origin+'/'});await wait("!!document.querySelector('.landing-demo-visible')",'矩阵准备');
  await evaluate(theme=>{localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);document.documentElement.dataset.theme=theme;},theme);
  await c.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await c.evaluate('document.fonts.ready');
  await check(theme+'/'+width+' 结构与样式',layoutValid,width);await snap(`${theme}-${width}-initial`);
  const font=await evaluate(async()=>{const h=document.querySelector('h1'),family=getComputedStyle(h).fontFamily;await document.fonts.load('900 46px '+family,'哪句不懂，点。');return{family,checked:document.fonts.check('900 46px '+family,'哪句不懂，点。'),faces:[...document.fonts].filter(f=>family.includes(f.family)).map(f=>({status:f.status,weight:f.weight}))};});
  scenes++;assert(font.checked&&font.faces.some(f=>f.status==='loaded'&&f.weight==='900'),'标题FontFace实际加载',font);passed++;
  await c.call('DOM.enable');await c.call('CSS.enable');const {root}=await c.call('DOM.getDocument');const {nodeId}=await c.call('DOM.querySelector',{nodeId:root.nodeId,selector:'h1'});const {fonts}=await c.call('CSS.getPlatformFontsForNode',{nodeId});scenes++;assert(fonts.some(f=>f.isCustomFont&&f.glyphCount>0),'标题实际渲染自托管字体',fonts);passed++;
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait("!!document.querySelector('.explain-result-text')&&!document.querySelector('.landing-demo-pointer')",'矩阵终态');
  await snap(`${theme}-${width}-final`);
  if(theme==='parchment'&&width===375){await negative('标题字重',layoutValid,'h1','font-weight','400',width);await negative('下划线',layoutValid,'h1 em','text-decoration-thickness','1px',width);await negative('吸底',layoutValid,'.landing-action-area','position','static',width);await negative('阴影',layoutValid,'.landing-demonstration','box-shadow','none',width);}
 }

 const networkValid=urls=>urls.filter(url=>/^https?:/.test(url)).every(url=>new URL(url).origin===origin);
 negativeData('第三方请求',networkValid,requests,urls=>urls.push('https://fonts.googleapis.com/css2?family=Bad'));
 const fontValid=()=>{const h=document.querySelector('h1'),f=getComputedStyle(h).fontFamily;return [...document.fonts].some(face=>f.includes(face.family)&&face.weight==='900'&&face.status==='loaded');};
 await negative('字体未加载',fontValid,'h1','font-family','serif');
 await negative('断点/旧G62:146,186,253,273,281,309,317',layoutValid,'.landing-demo-steps','display','none',430);
 await negative('旧G62:145–150 反馈入口取样',()=>{const el=document.querySelector('.landing-header .feedback-button');return el&&getComputedStyle(el).display!=='none';},'.landing-header .feedback-button','display','none');
 await negative('旧G60b:161 页头反馈几何',()=>{const b=document.querySelector('.landing-header .feedback-button').getBoundingClientRect();return b.width>0&&b.left>=0&&b.right<=innerWidth;},'.landing-header .feedback-button','transform','translateX(2000px)');
 await negativeRuntime('旧G60b:192 名称取样',()=>document.querySelector('.landing-header .feedback-button').getAttribute('aria-label')==='体验反馈',()=>document.querySelector('.landing-header .feedback-button').setAttribute('aria-label','错误'),()=>document.querySelector('.landing-header .feedback-button').setAttribute('aria-label','体验反馈'));
 const g62=await readFile(new URL('./verify-g62.mjs',import.meta.url),'utf8');
 const marginExpression=/check\((.*),'layout gutter and margins'/.exec(g62)[1];
 const columnsExpression=/if\(width>=1000\)check\((.*),'two columns'/.exec(g62)[1];
 const marginPredicate=new Function('geometry','return '+marginExpression),columnPredicate=new Function('geometry','return '+columnsExpression);
 const facts={gutter:'stable',left:'0px',right:'0px',copy:{right:400,width:300},card:{x:472,width:360},padding:0};
 negativeData('旧G62:320 页面边距',marginPredicate,facts,g=>g.left='20px');
 negativeData('旧G62:321 列间距',columnPredicate,facts,g=>g.card.x+=10);
 negativeData('旧G62:321 列比',columnPredicate,facts,g=>g.card.width+=100);
 negativeData('旧G62:321 左栏偏移',columnPredicate,facts,g=>g.padding=56);
 scenes++;assert(sameOrigin(),'无第三方运行时请求',requests.filter(url=>/^https?:/.test(url)&&new URL(url).origin!==origin));passed++;

 // 在相同演示正文宽度下逐字比较两个版本；外部位置只用于各版本内部不变量。
 async function captureDemo(url,width){
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:1,deviceScaleFactor:1,mobile:false});
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await c.call('Page.navigate',{url:url+'/'});await wait("!!document.querySelector('.landing-demo-visible')",'逐字基线准备');await c.evaluate('document.fonts.ready');
  await evaluate(width=>{document.querySelector('.landing-demonstration').style.width=(width<768?width-55:480)+'px';},width);
  await c.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await c.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await evaluate(()=>{
   const glyphs=()=>{const stage=document.querySelector('.landing-demo-stage').getBoundingClientRect(),out=[];
    for(const span of document.querySelectorAll('.landing-demo-visible .sentence')){
     const walker=document.createTreeWalker(span,NodeFilter.SHOW_TEXT);let text;
     while(text=walker.nextNode()){let offset=0;for(const char of text.data){const r=document.createRange();r.setStart(text,offset);r.setEnd(text,offset+char.length);const b=r.getBoundingClientRect();out.push({key:span.dataset.index+':'+(Number(span.dataset.offset)+offset),char,x:b.x-stage.x,y:b.y-stage.y});offset+=char.length;}}
    }return out;
   };
   window.__demoProbe={phases:{},cardTop:document.querySelector('.landing-demonstration').getBoundingClientRect().top,started:performance.now()};
   const sample=()=>{
    const pointer=document.querySelector('.landing-demo-pointer');const phase=pointer?.className.split(' ').find(c=>c.startsWith('landing-demo-pointer-'))?.replace('landing-demo-pointer-','');
    if(phase&&!window.__demoProbe.phases[phase])window.__demoProbe.phases[phase]={glyphs:glyphs(),cardTop:document.querySelector('.landing-demonstration').getBoundingClientRect().top,gloss:document.querySelector('.landing-demo-visible .gloss-panel-text')?.textContent??'',explain:document.querySelector('.explain-result-text')?.textContent??''};
    if(phase==='settled'&&performance.now()-(window.__demoProbe.settledAt??=performance.now())>=1250){clearInterval(window.__demoProbe.timer);window.__demoProbe.done=true;}
    if(performance.now()-window.__demoProbe.started>25000){clearInterval(window.__demoProbe.timer);window.__demoProbe.timeout=true;}
   };
   window.__demoProbe.timer=setInterval(sample,16);sample();
  });
  try{await wait('window.__demoProbe.done','逐字播放完成');return await c.evaluate('window.__demoProbe');}
  finally{await c.evaluate('clearInterval(window.__demoProbe?.timer)');}
 }
 const demoValid=probe=>{
  const first=probe.phases.waiting,final=probe.phases.settled;if(!first||!final)return false;
  const start=new Map(first.glyphs.map(g=>[g.key,g]));
  return Object.values(probe.phases).every(p=>Math.abs(p.cardTop-probe.cardTop)<.5&&p.glyphs.filter(g=>Number(g.key.split(':')[0])<=10).every(g=>{const b=start.get(g.key);return b&&g.char===b.char&&Math.abs(g.x-b.x)<.5&&Math.abs(g.y-b.y)<.5;}));
 };
 const sameDisplacement=(current,base)=>{
  for(const phase of ['waiting','gloss-ready','explain-clicking','settled']){
   const a=current.phases[phase],b=base.phases[phase];if(!a||!b||a.gloss!==b.gloss||a.explain!==b.explain)return false;
   const firstA=new Map(current.phases.waiting.glyphs.map(g=>[g.key,g])),firstB=new Map(base.phases.waiting.glyphs.map(g=>[g.key,g])),other=new Map(b.glyphs.map(g=>[g.key,g]));
   if(a.glyphs.length!==b.glyphs.length)return false;
   for(const g of a.glyphs){const h=other.get(g.key),ga=firstA.get(g.key),gb=firstB.get(g.key);if(!h||!ga||!gb||g.char!==h.char||Math.abs((g.x-ga.x)-(h.x-gb.x))>=.5||Math.abs((g.y-ga.y)-(h.y-gb.y))>=.5)return false;}
  }return true;
 };
 for(const width of [375,390,430,1024,1280,1440]){
  const current=await captureDemo(origin,width),base=await captureDemo(baselineOrigin,width);
  scenes++;assert(demoValid(current),'卡片顶边与被点字位移零 '+width,current.phases);passed++;
  scenes++;assert(sameDisplacement(current,base),'跨03c7884逐字位移一致 '+width);passed++;console.log(JSON.stringify({baselineGlyphComparison:{width,passed:true}}));
  if(width===1280){negativeData('桌面卡片增高重居中',demoValid,current,p=>p.phases['gloss-ready'].cardTop+=41.53125);negativeData('被点句字移动',demoValid,current,p=>p.phases['gloss-ready'].glyphs.find(g=>g.key.startsWith('10:')).y+=2);negativeData('基线逐字位移差异',p=>sameDisplacement(p,base),current,p=>p.phases.settled.glyphs.at(-1).y+=2);}
 }
 await c.call('Page.navigate',{url:origin+'/'});await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait("!!document.querySelector('.landing-demo-visible')",'基线比较后恢复');
 for(const width of [767,768,999,1000]){
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await check('断点 '+width,layoutValid,width);
 }

 await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:667,deviceScaleFactor:1,mobile:false});
 await negative('尾部留白',()=>{const h=document.querySelector('.landing-action-area').getBoundingClientRect().height;return parseFloat(getComputedStyle(document.querySelector('.landing-layout')).paddingBottom)>=h+24;},'.landing-layout','padding-bottom','0px');
 // 导入浮层隐藏吸底区，关闭后恢复焦点；事件只在本地捕获。
 await c.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
 await c.evaluate("window.__g73bEvents=[];document.querySelector('.landing-secondary').click()");await wait("!!document.querySelector('.import-panel')",'导入');
 await snap('390-import-dialog');
 await check('导入时隐藏吸底',()=>getComputedStyle(document.querySelector('.landing-action-area')).visibility==='hidden'&&document.querySelector('.landing-action-area').inert);
 await snap('390-import');await c.evaluate("document.querySelector('.import-close').click()");await sleep(100);
 await check('关闭导入焦点',()=>document.activeElement===document.querySelector('.landing-secondary')&&getComputedStyle(document.querySelector('.landing-action-area')).visibility==='visible');
 await check('导入事件一次',()=>window.__g73bEvents.filter(e=>e.event==='landing_cta_click').length===1&&window.__g73bEvents.some(e=>e.event==='landing_cta_click'&&e.target==='import'));

 await c.evaluate("window.__g73bEvents=[];document.querySelector('.landing-demo-header button').click()");await sleep(100);
 await check('重播零事件',()=>window.__g73bEvents.length===0);
 negativeData('重复CTA事件',rows=>rows.filter(e=>e.event==='landing_cta_click'&&e.target==='import').length===1,[{event:'landing_cta_click',target:'import'}],rows=>rows.push({...rows[0]}));
 directEvents.length=0;
 await c.call('Page.navigate',{url:origin+'/'});await wait("!!document.querySelector('.landing-primary')",'新落地访问');
 await sleep(100);scenes++;assert(!captureError&&directEvents.filter(e=>e.event==='landing_view').length===1,'landing_view 每次显示一次',{directEvents,captureError});passed++;
 await c.evaluate("window.__g73bEvents=[];document.querySelector('.landing-primary').click()");await wait("location.pathname==='/read/sample'&&!!document.querySelector('.reader-body')",'示例导航');
 await wait("!!document.querySelector('.sentence')",'阅读器就绪');await sleep(100);
 const sampleCta=await c.evaluate("window.__g73bEvents.filter(e=>e.event==='landing_cta_click')");
 scenes++;assert(sampleCta.length===1&&sampleCta[0].target==='sample','sample CTA一次',sampleCta);passed++;
 const entryValid=rows=>rows.filter(e=>e.event==='reader_enter'&&e.source==='landing').length===1&&rows.filter(e=>e.event==='sample_doc_enter'&&e.from==='landing').length===1;
 scenes++;assert(!captureError&&entryValid(directEvents),'示例与阅读器来源',{directEvents,captureError});passed++;
 negativeData('阅读入口来源',entryValid,directEvents,rows=>{rows.find(e=>e.event==='reader_enter').source='direct';});
 negativeData('示例入口来源',entryValid,directEvents,rows=>{rows.find(e=>e.event==='sample_doc_enter').from='direct';});
 await c.call('Page.navigate',{url:origin+'/'});await wait("!!document.querySelector('.landing-primary')",'回落地页');
 // 真实触摸输入与点击冲突，关闭态/展开态都验证，示例只提供移除。
 await evaluate(()=>{const entries={};for(let n=0;n<12;n++){const id='swipe'+n;localStorage.setItem('gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs:['测试句子。'],headings:[],footnotes:[],meta:{format:'txt',fileName:'测试.txt',charCount:5},savedAt:1}));localStorage.setItem('gloss:structure:'+id,JSON.stringify({version:1,prompt:'structure-v1',structure:'验证用已缓存结构。',savedAt:1}));entries[id]={docId:id,title:'测试书'+n,author:null,addedAt:1,lastOpenedAt:n+2,colorId:'book-0',widthSeed:n};}localStorage.setItem('gloss:shelf:v1',JSON.stringify({version:1,migratedAt:1,entries}));});
 await c.call('Page.reload');await wait("!!document.querySelector('.mobile-book')",'书架');
 const gesture=async(selector,dx,dy)=>{
  const p=await evaluate(sel=>{const r=document.querySelector(sel).getBoundingClientRect();return{x:r.left+r.width*.7,y:r.top+r.height/2};},selector);
  await c.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});
  for(let i=1;i<=5;i++)await c.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+dx*i/5,y:p.y+dy*i/5,id:1}]});
  await c.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(220);
 };
 const closed=()=>!document.querySelector('.mobile-swipe-open')&&location.pathname==='/';
 await c.evaluate('window.__g73bEvents=[]');
 for(const [dx,dy]of[[-47,0],[-9,0],[-40,60],[-48,45]]){await gesture('.mobile-current',dx,dy);await check('不误开 '+dx+'/'+dy,closed);}
 // 故障注入：阻断短横移的处理，真实触摸应误进阅读页，同一 closed 判据必须检出。
 await evaluate(()=>{window.__blockMove=e=>{if(e.target.closest('.mobile-current'))e.stopImmediatePropagation();};document.addEventListener('pointermove',window.__blockMove,true);});
 try{await gesture('.mobile-current',-9,0);negatives++;assert(!await evaluate(closed),'9px误导航负对照未检出');detected++;}
 finally{await evaluate(()=>document.removeEventListener('pointermove',window.__blockMove,true));await c.call('Page.navigate',{url:origin+'/'});await wait("!!document.querySelector('.mobile-current')",'短横移负对照恢复');}
 await c.evaluate('window.__g73bEvents=[]');
 await negativeRuntime('低阈值误展开',closed,()=>document.querySelector('.mobile-swipe').classList.add('mobile-swipe-open'),()=>document.querySelector('.mobile-swipe').classList.remove('mobile-swipe-open'));
 await check('滑动零事件',()=>window.__g73bEvents.length===0);

 await c.evaluate('scrollTo(0,0)');await gesture('.mobile-current',0,-80);
 const scrolled=()=>scrollY>0;await check('竖向滚动优先',scrolled);
 await c.evaluate('scrollTo(0,0)');await evaluate(()=>document.querySelector('.mobile-swipe').style.touchAction='none');
 try{await gesture('.mobile-current',0,-80);negatives++;assert(!await evaluate(scrolled),'竖向滚动被拦负对照未检出');detected++;}
 finally{await evaluate(()=>document.querySelector('.mobile-swipe').style.removeProperty('touch-action'));await c.evaluate('scrollTo(0,0)');}
 await gesture('.mobile-current',-80,0);await check('正在读左滑',()=>document.querySelectorAll('.mobile-swipe-open').length===1&&!!document.querySelector('.mobile-swipe-open .mobile-current'));
 await snap('390-current-open');await gesture('.mobile-current',80,0);await check('右滑收回',closed);
 for(const method of ['outside','scroll','escape']){
  await gesture('.mobile-book',-80,0);
  await evaluate(method=>{if(method==='outside')document.querySelector('.shelf-heading').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));else if(method==='scroll')window.scrollBy(0,20);else window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));},method);await sleep(200);await check('收回 '+method,closed);
 }
 await evaluate(()=>document.querySelector('.mobile-more').click());await sleep(50);
 await snap('390-keyboard-actions');
 await check('无障碍入口',()=>document.querySelector('.mobile-more').disabled&&document.activeElement===document.querySelector('.mobile-swipe-actions button'));
 await evaluate(()=>document.querySelector('.mobile-books .mobile-more').click());await check('最多一处展开',()=>document.querySelectorAll('.mobile-swipe-open').length===1);

 await negativeRuntime('同一时刻两行',()=>document.querySelectorAll('.mobile-swipe-open').length===1,()=>document.querySelector('.mobile-swipe:not(.mobile-swipe-open)').classList.add('negative-extra','mobile-swipe-open'),()=>document.querySelector('.negative-extra').classList.remove('negative-extra','mobile-swipe-open'));
 await evaluate(()=>document.querySelector('.mobile-swipe-open .mobile-swipe-actions button').click());await wait("!!document.querySelector('.spine-menu')",'色板');
 const menuBounds=()=>{const r=document.querySelector('.spine-menu').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&!document.querySelector('.spine-menu').textContent.includes('从书架移除');};
 await check('手机色板边界',menuBounds);await negative('旧G73a:98,104,115–117 色板入口与边界',menuBounds,'.spine-menu','left','-500px');await snap('390-color');

 const lastBookValid=()=>document.querySelector('.mobile-books .mobile-swipe:last-child .mobile-book')?.dataset.docId==='sample';
 await check('旧G73a:97 最后一行取样',lastBookValid);
 await negativeRuntime('旧G73a:97 最后一行错误',lastBookValid,()=>document.querySelector('.mobile-books .mobile-swipe:last-child .mobile-book').dataset.docId='wrong',()=>document.querySelector('.mobile-books .mobile-swipe:last-child .mobile-book').dataset.docId='sample');
 await evaluate(()=>document.querySelector('.spine-menu .color-swatch').click());await check('换色存储',()=>JSON.parse(localStorage.getItem('gloss:shelf:v1')).entries.swipe10.colorId==='book-0');
 await evaluate(()=>{const row=document.querySelector('[data-swipe-id="sample"]');row.querySelector('.mobile-more').click();});
 await check('示例仅移除',()=>document.querySelector('[data-swipe-id="sample"] .mobile-swipe-actions').querySelectorAll('button').length===1);await snap('390-sample-open');
 await evaluate(()=>document.querySelector('[data-swipe-id="sample"] .mobile-swipe-actions button').click());await check('先确认未直接删除',()=>!!document.querySelector('.remove-confirm')&&!!document.querySelector('[data-swipe-id="sample"]'));await snap('390-remove');

 await negativeRuntime('提前直接删除',()=>!!document.querySelector('.remove-confirm')&&localStorage.getItem('gloss:sample:removed')!=='1'&&!!document.querySelector('[data-swipe-id="sample"]'),()=>localStorage.setItem('gloss:sample:removed','1'),()=>localStorage.removeItem('gloss:sample:removed'));
 await negative('旧G73a:105 移除确认缺失',()=>{const el=document.querySelector('.remove-confirm');return !!el&&getComputedStyle(el).display!=='none';},'.remove-confirm','display','none');
 await evaluate(()=>document.querySelector('.remove-confirm button').click());
 await check('长按不接管',()=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('.mobile-book').dispatchEvent(e);return !e.defaultPrevented&&!document.querySelector('.spine-menu');});

 await negativeRuntime('长按被接管',()=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('.mobile-book').dispatchEvent(e);return !e.defaultPrevented;},()=>{window.__badContext=e=>e.preventDefault();document.querySelector('.mobile-book').addEventListener('contextmenu',window.__badContext);},()=>document.querySelector('.mobile-book').removeEventListener('contextmenu',window.__badContext));
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await check('左滑减少动态效果',()=>getComputedStyle(document.querySelector('.mobile-swipe-front')).transitionDuration==='0s');
 await negative('减少动态效果',()=>getComputedStyle(document.querySelector('.mobile-swipe-front')).transitionDuration==='0s','.mobile-swipe-front','transition','transform 180ms linear');

 // 最终书架截图：四主题、三种手机宽度，各操作状态独立拍摄。
 for(const theme of ['parchment','moon-white','eye-green','dark'])for(const width of [375,390,430]){
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:({375:667,390:844,430:932}[width]),deviceScaleFactor:1,mobile:false});
  await evaluate(theme=>{localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);},theme);
  await c.call('Page.reload');await wait("!!document.querySelector('.mobile-current')",'书架截图准备');await snap(`${theme}-${width}-shelf-closed`);
  await evaluate(()=>document.querySelector('.mobile-more').click());await snap(`${theme}-${width}-shelf-current-open`);
  await evaluate(()=>document.querySelector('.mobile-books .mobile-more').click());await snap(`${theme}-${width}-shelf-list-open`);
  await evaluate(()=>document.querySelector('.mobile-swipe-open .mobile-swipe-actions button').click());await wait("!!document.querySelector('.spine-menu')",'截图色板');await snap(`${theme}-${width}-shelf-color`);
  await evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await evaluate(()=>{document.querySelector('[data-swipe-id="sample"]').scrollIntoView({block:'center',behavior:'instant'});});await sleep(100);
  await evaluate(()=>document.querySelector('[data-swipe-id="sample"] .mobile-more').click());await snap(`${theme}-${width}-shelf-sample-open`);
  await evaluate(()=>document.querySelector('[data-swipe-id="sample"] .mobile-swipe-actions button').click());await wait("!!document.querySelector('.remove-confirm')",'截图确认');await snap(`${theme}-${width}-shelf-remove`);
  await evaluate(()=>document.querySelector('.remove-confirm button').click());
 }
 await check('页面可见',()=>!document.hidden&&document.visibilityState==='visible');
 scenes++;assert(requests.filter(url=>new URL(url).pathname.startsWith('/api/')).length===0,'验证零API请求',requests.filter(url=>new URL(url).pathname.startsWith('/api/')).map(url=>new URL(url).pathname));passed++;
 await single();const result={scenes,passed,negatives,detected,shots,shotDir};await writeFile(join(shotDir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));

}catch(error){console.log(JSON.stringify({stopped:true,error:error.message,scenes,passed,negatives,detected,shots,shotDir}));throw error;}
finally{
 c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);
 const absolute=resolve(profile);assert(absolute.startsWith(resolve(tmpdir(),'gloss-g73b-')),'安全清理');await rm(absolute,{recursive:true,force:true});
}
