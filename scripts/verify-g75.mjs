import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import ts from 'typescript';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,evaluate}=await import('./verify-g19.mjs');
const profile=await mkdtemp(join(tmpdir(),'gloss-g75-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--disable-sync','--user-data-dir='+profile,'--remote-debugging-port=9511','--remote-allow-origins=*','about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let c,scenes=0,negative=0;const candidateDemoSizes=[];
const assert=(ok,label,facts)=>{if(!ok)throw Error(label+' '+JSON.stringify(facts));scenes++;};
const ev=(fn,...args)=>evaluate(c,fn,...args);
async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('等待失败 '+label);}
async function load(path,width,origin='http://127.0.0.1:3511'){
 await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
 await c.call('Page.navigate',{url:origin+path});
 await wait(()=>c.evaluate("document.readyState==='complete'&&!!document.querySelector('.landing-page,.shelf-page,.reader-body')"),'页面');
 await c.evaluate('document.fonts.ready');await sleep(350);
}
async function theme(value){await ev(value=>{localStorage.setItem('gloss:settings:theme',value==='dark'?'parchment':value);localStorage.setItem('gloss:settings:appearance',value==='dark'?'dark':'light');document.documentElement.dataset.theme=value;},value);await sleep(350);}
async function brand(scope,size,reader=false){
 const facts=await ev((scope,reader)=>{const host=document.querySelector(scope),en=host.querySelector('.brand-english'),zh=host.querySelector('.brand-chinese'),s=getComputedStyle(en),probe=document.createElement('span');probe.style.fontFamily='var(--font-brand)';document.body.append(probe);const expected=getComputedStyle(probe).fontFamily;probe.style.color=reader?'var(--ink)':'var(--brand-english)';const color=getComputedStyle(probe).color;probe.style.fontFamily='var(--font-brand-chinese)';const zhFont=getComputedStyle(probe).fontFamily;probe.style.color='var(--gloss)';const zhColor=getComputedStyle(probe).color;probe.remove();const r=en.getBoundingClientRect();return {font:s.fontFamily,expected,weight:s.fontWeight,size:s.fontSize,color:s.color,expectedColor:color,zhFont,zhColor,zh:zh?{font:getComputedStyle(zh).fontFamily,weight:getComputedStyle(zh).fontWeight,color:getComputedStyle(zh).color,size:getComputedStyle(zh).fontSize,spacing:getComputedStyle(zh).letterSpacing,margin:getComputedStyle(zh).marginRight,x:zh.getBoundingClientRect().x,w:zh.getBoundingClientRect().width,y:zh.getBoundingClientRect().y}:null,en:{x:r.x,y:r.y,w:r.width,bottom:r.bottom}};},scope,reader);
 assert(facts.font===facts.expected&&facts.weight==='600'&&facts.size===size+'px','英文字体字号',facts);
 assert(facts.color===facts.expectedColor,'英文字标颜色',facts);
 assert(reader?!facts.zh:facts.zh?.size==='11px','中文结构',facts);
 if(!reader){assert(facts.zh.font===facts.zhFont&&facts.zh.weight==='500'&&facts.zh.color===facts.zhColor&&facts.zh.spacing==='5.5px'&&facts.zh.margin==='-5.5px','中文字标规格',facts);assert(facts.zh.y>=facts.en.bottom&&Math.abs((facts.zh.x+facts.zh.w/2)-(facts.en.x+facts.en.w/2))<3,'中文上下居中',facts);}
 return facts;
}
async function platformFont(selector){
 await c.call('DOM.enable');await c.call('CSS.enable');const {root}=await c.call('DOM.getDocument');const {nodeId}=await c.call('DOM.querySelector',{nodeId:root.nodeId,selector});const {fonts}=await c.call('CSS.getPlatformFontsForNode',{nodeId});return fonts;
}
async function negativeCheck(label,predicate,mutate,restore){
 assert(await ev(predicate),label+'正对照');await ev(mutate);
 try{assert(!await ev(predicate),label+'负对照未检出');negative++;console.log(JSON.stringify({negative:label,detected:true}));}finally{await ev(restore);}
}
const noOldWords=()=>!document.body.innerText.match(/听不懂|留下/);
const noOverflow=()=>{const width=document.documentElement.clientWidth;return document.documentElement.scrollWidth<=width&&[...document.querySelectorAll('.action-row,.action-row button')].filter(e=>{const s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&e.getBoundingClientRect().width>0&&!e.closest('.landing-demo-measure');}).every(e=>{const r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth&&r.left>=0&&r.right<=width;});};
function seed(){
 const id='g75',paragraphs=['春风吹过山谷。河水慢慢流向大海。这里还有一段可供选择的文字。','第二段讲述道路与远方。'];
 localStorage.setItem('gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs,headings:[],footnotes:[],meta:{format:'txt',fileName:'品牌验证.txt',charCount:paragraphs.join('').length},savedAt:1}));
 localStorage.setItem('gloss:structure:'+id,JSON.stringify({version:1,prompt:'structure-v1',structure:'本地验证。',savedAt:1}));
 localStorage.setItem('gloss:shelf:v1',JSON.stringify({version:1,migratedAt:1,entries:{g75:{docId:id,title:'品牌验证',author:null,addedAt:1,lastOpenedAt:2,colorId:'book-0',widthSeed:1}}}));
 localStorage.setItem('gloss:settings:reader-typography',JSON.stringify({version:1,fontSize:21,lineHeight:1.75,lineChars:32,bodyFont:'sans',glossFont:'serif'}));
 localStorage.setItem('gloss:settings:reading-mode','reading');
}
async function actionText(selector,expected){await wait(()=>ev((s,e)=>document.querySelector(s)?.getAttribute('aria-label')===e,selector,expected),'按钮 '+expected);assert(await ev((s,e)=>document.querySelector(s).getAttribute('aria-label')===e,selector,expected),'按钮文案',expected);}
async function point(ordinal,offset){return ev((ordinal,offset)=>{const e=document.querySelectorAll('.reader-body .sentence')[ordinal],n=e.firstChild,r=document.createRange();r.setStart(n,offset);r.setEnd(n,offset+1);const b=r.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};},ordinal,offset);}
async function selectionResult(width){
 await ev(width=>document.querySelector(width<768?'.reader-selection-mobile':'.reader-selection-desktop').click(),width);
 await ev(()=>scrollTo({top:0,behavior:'instant'}));await sleep(350);
 const a=await point(0,0),b=await point(1,4);
 if(width<768){await c.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});for(const p of [a,b]){await c.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await c.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}await c.call('Emulation.setTouchEmulationEnabled',{enabled:false});}
 else{await c.call('Input.dispatchMouseEvent',{type:'mousePressed',...a,button:'left',clickCount:1});await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',...b,button:'left',buttons:1});await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',clickCount:1});}
 await wait(()=>c.evaluate("!!document.querySelector('.reader-selection-bar [data-selection-control]')&&document.querySelector('.reader-selection-bar').dataset.selectionChars>0"),'划选准备');
 await ev(()=>[...document.querySelectorAll('.reader-selection-actions button')].find(b=>b.textContent==='确定').click());
 await wait(()=>c.evaluate("!!document.querySelector('[data-selection-id] .action-row-save:not(:disabled)')"),'划选结果');
 await actionText('[data-selection-id] .action-row-save','收藏');
 await ev(()=>document.querySelector('[data-selection-id] .action-row-save').click());await actionText('[data-selection-id] .action-row-save','取消收藏');
 assert(await ev(noOverflow),'划选结果零溢出',{width});assert(await c.evaluate("parseFloat(getComputedStyle(document.querySelector('[data-selection-id] .action-row-save')).fontSize)")===13,'划选结果下方控件13px');
}
try{
 const noticeSource=await readFile(new URL('../lib/parse/validate.ts',import.meta.url),'utf8');
 const noticeModule={};new Function('exports',ts.transpileModule(noticeSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(noticeModule);
 const noticeBrandValid=message=>message.includes('Glossline')&&!/\bGloss\b/.test(message);
 for(const code of ['A4','A5','A9']){
   const message=noticeModule.noticeContent(code).message;
   assert(noticeBrandValid(message),'解析提示新品牌 '+code);
   assert(!noticeBrandValid(message+' Gloss'),'解析提示旧品牌负对照未检出 '+code);negative++;console.log(JSON.stringify({negative:'解析提示独立Gloss '+code,detected:true}));
 }
 await wait(async()=>{try{const tabs=await(await fetch('http://127.0.0.1:9511/json')).json();const t=tabs.find(t=>t.type==='page');if(!t)return false;c=new Cdp(t.webSocketDebuggerUrl);return true;}catch{return false;}},'Edge');
 await c.call('Page.enable');await c.call('Runtime.enable');
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('gloss:analytics:optout','1');localStorage.setItem('gloss:sample:breathed','1');const originalFetch=window.fetch;window.__g75Api=[];window.fetch=async function(url,init){const path=String(url);if(path.includes('/api/')){__g75Api.push(path);if(path.endsWith('/api/gloss'))return new Response('这是⟦道路⟧在这里的意思。',{headers:{'Content-Type':'text/plain'}});if(path.endsWith('/api/range-gloss')||path.endsWith('/api/term'))return new Response('选中范围的白话。',{headers:{'Content-Type':'text/plain'}});if(path.endsWith('/api/explain'))return new Response('结合前后文的脉络解读。',{headers:{'Content-Type':'text/plain'}});return Response.json({structure:'本地模拟结构。'});}return originalFetch.apply(this,arguments);};"});
 for(const route of ['/icon.png','/apple-icon.png'])assert((await fetch('http://127.0.0.1:3511'+route)).status===200,'图标200',route);
 await load('/',1280);assert(await c.evaluate('document.title')==='Glossline 句下','首页标题');
 for(const value of ['parchment','moon-white','eye-green','dark']){await theme(value);await brand('.landing-header',26);}
 await negativeCheck('Landing字标文字判据',()=>document.querySelector('.landing-header .wordmark').textContent==='Glossline句下',()=>document.querySelector('.landing-header .brand-english').textContent='GLOSS',()=>document.querySelector('.landing-header .brand-english').textContent='Glossline');
 const englishFont=()=>{
  const element=document.querySelector('.landing-header .brand-english'), style=getComputedStyle(element);
  const family='Cormorant Garamond', first=style.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g,'');
  const loaded=[...document.fonts].some(face=>face.family.replace(/^["']|["']$/g,'')===family&&face.weight==='600'&&face.status==='loaded');
  const probe=document.createElement('span');
  Object.assign(probe.style,{position:'absolute',visibility:'hidden',whiteSpace:'nowrap',fontSize:style.fontSize,fontWeight:'600',letterSpacing:style.letterSpacing});
  probe.textContent='Glossline';document.body.append(probe);
  const width=font=>{probe.style.fontFamily=font;return probe.getBoundingClientRect().width;};
  const expected=width('"Cormorant Garamond"'), fallback=width('"Cormorant Garamond Fallback"');
  probe.remove();
  const actual=element.getBoundingClientRect().width;
  return {loaded,first,actual,expected,fallback,ok:loaded&&first===family&&Math.abs(expected-fallback)>.5&&Math.abs(actual-expected)<=.5};
 };
 const english=await ev(englishFont);assert(english.ok,'英文实际字体',english);
 await ev(()=>document.querySelector('.landing-header .brand-english').style.fontFamily='"Cormorant Garamond Fallback"');
 try{const fallback=await ev(englishFont);assert(!fallback.ok&&Math.abs(fallback.actual-fallback.fallback)<=.5,'英文实际字体回退负对照',fallback);negative++;}
 finally{await ev(()=>document.querySelector('.landing-header .brand-english').style.removeProperty('font-family'));}
 const latinURL=await ev(()=>{
   for(const sheet of document.styleSheets)for(const rule of sheet.cssRules){
     if(!(rule instanceof CSSFontFaceRule))continue;
     const font=rule.style;
     if(font.fontFamily.replace(/^["']|["']$/g,'')!=='Cormorant Garamond'||font.fontWeight!=='600'||!font.getPropertyValue('unicode-range').includes('U+0-FF'))continue;
     const source=font.src.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
     if(source)return new URL(source,sheet.href??location.href).href;
   }
   return null;
 });
 assert(latinURL,'找到英文字标拉丁字体请求');
 await c.call('Network.enable');await c.call('Network.setCacheDisabled',{cacheDisabled:true});
 try{
   await c.call('Page.navigate',{url:'about:blank'});
   await c.call('Network.setBlockedURLs',{urls:[latinURL]});
   await load('/',1280);
   const blocked=await ev(englishFont);
   assert(!blocked.ok&&!blocked.loaded,'英文实际字体请求阻断负对照',blocked);negative++;
 }finally{
   await c.call('Network.setBlockedURLs',{urls:[]});
   await c.call('Network.setCacheDisabled',{cacheDisabled:false});
 }
 await load('/',1280);
 assert((await ev(englishFont)).ok,'解除阻断后英文实际字体恢复');
 assert((await platformFont('.landing-header .brand-chinese')).some(f=>f.isCustomFont&&f.glyphCount===2),'句下实际自托管字体');
 await negativeCheck('字标回退Cinzel',()=>getComputedStyle(document.querySelector('.landing-header .brand-english')).fontFamily===getComputedStyle(document.documentElement).getPropertyValue('--font-brand').trim(),()=>document.querySelector('.landing-header .brand-english').style.fontFamily='var(--font-display)',()=>document.querySelector('.landing-header .brand-english').style.removeProperty('font-family'));
 await negativeCheck('句下系统字体',()=>{const p=document.createElement('span');p.style.fontFamily='var(--font-brand-chinese)';document.body.append(p);const expected=getComputedStyle(p).fontFamily;p.remove();return getComputedStyle(document.querySelector('.brand-chinese')).fontFamily===expected;},()=>document.querySelector('.brand-chinese').style.fontFamily='SimSun',()=>document.querySelector('.brand-chinese').style.removeProperty('font-family'));
 await negativeCheck('旧词残留',noOldWords,()=>{const e=document.createElement('p');e.id='g75-negative';e.textContent='听不懂';document.body.append(e);},()=>document.querySelector('#g75-negative').remove());
 for(const width of [320,375]){
  await load('/',width);await brand('.landing-header',22);
  assert(await ev(noOldWords),'落地页旧词零残留');
  await wait(()=>c.evaluate("!!document.querySelector('.landing-demo-visible .action-row')"),'演示操作行');
  assert(await ev(noOverflow),'落地页演示零溢出',{width});candidateDemoSizes.push(await c.evaluate("parseFloat(getComputedStyle(document.querySelector('.landing-demo-visible .action-row-save')).fontSize)"));
 }
 await load('/',1280);await ev(seed);
 await load('/',1280);assert(await c.evaluate('document.title')==='Glossline 句下','书架标题');
 for(const value of ['parchment','moon-white','eye-green','dark']){await theme(value);await brand('.shelf-heading',26);}
 for(const width of [320,375]){
  await load('/',width);
  const header=await ev(()=>{const s=q=>document.querySelector(q),r=e=>{const b=e.getBoundingClientRect();return {width:b.width,height:b.height,left:b.left,right:b.right}},img=s('.brand-lockup'),h=s('.shelf-mobile-title'),button=s('.shelf-heading .feedback-button');return {img:r(img),role:img.getAttribute('role'),label:img.getAttribute('aria-label'),heading:h.textContent,font:getComputedStyle(h).fontSize,weight:getComputedStyle(h).fontWeight,button:r(button),buttonLabel:button.getAttribute('aria-label'),gap:h.getBoundingClientRect().left-img.getBoundingClientRect().right};});
  assert(header.img.width===59&&header.img.height===36&&header.role==='img'&&header.label==='Glossline 句下'&&header.heading==='我的书架'&&header.font==='20px'&&header.weight==='700'&&header.gap===10&&header.button.width===44&&header.button.height===44&&header.buttonLabel==='体验反馈','手机书架页头',header);
  await negativeCheck('手机页头小标尺寸判据',()=>{const r=document.querySelector('.brand-lockup').getBoundingClientRect();return r.width===59&&r.height===36;},()=>document.querySelector('.brand-lockup').style.width='58px',()=>document.querySelector('.brand-lockup').style.removeProperty('width'));
  await negativeCheck('手机反馈入口名称判据',()=>document.querySelector('.shelf-heading .feedback-button').getAttribute('aria-label')==='体验反馈',()=>document.querySelector('.shelf-heading .feedback-button').setAttribute('aria-label','反馈'),()=>document.querySelector('.shelf-heading .feedback-button').setAttribute('aria-label','体验反馈'));
  await brand('.shelf-brand-footer',18);
  assert(await ev(()=>{const e=document.querySelector('.shelf-brand-footer'),s=getComputedStyle(e);return e.getAttribute('aria-hidden')==='true'&&s.opacity==='0.8'&&s.marginTop==='34px'&&s.textAlign==='center';}),'书单落款规格');
  for(const value of ['parchment','moon-white','eye-green','dark']){await theme(value);assert(await ev(dark=>getComputedStyle(document.querySelector('.brand-lockup')).backgroundImage.endsWith((dark?'brand-lockup-dark.png':'brand-lockup.png')+'")'),value==='dark'),'小标随主题切换',value);}
  await ev(()=>document.querySelector('.shelf-heading .feedback-button').click());await wait(()=>c.evaluate("!!document.querySelector('.feedback-card')"),'原反馈卡');
  await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(350);
 }
 await theme('dark');
 await negativeCheck('深色小标错误',()=>getComputedStyle(document.querySelector('.brand-lockup')).backgroundImage.includes('brand-lockup-dark.png'),()=>document.querySelector('.brand-lockup').style.backgroundImage='url(/brand/brand-lockup.png)',()=>document.querySelector('.brand-lockup').style.removeProperty('background-image'));
 for(const width of [768,800,900,999,1000,1280]){
  await load('/read/g75',width);
  const scope='.reader-sidebar-brand';
  for(const value of ['parchment','moon-white','eye-green','dark']){await theme(value);await brand(scope,20,true);}
  assert(await c.evaluate('document.title')==='品牌验证 · Glossline','阅读页标题',await ev(()=>({title:document.title,titles:[...document.querySelectorAll('title')].map(e=>e.textContent),file:document.querySelector('.reader-mobile-title')?.textContent})));
  const row=()=>{const t=document.querySelector('.reader-sidebar-top').getBoundingClientRect(),a=document.querySelector('.reader-shelf-back').getBoundingClientRect(),b=document.querySelector('.reader-sidebar-brand').getBoundingClientRect();return{t:{x:t.x,y:t.y,right:t.right,w:t.width},a:{x:a.x,y:a.y,bottom:a.bottom,w:a.width},b:{x:b.x,y:b.y,right:b.right,w:b.width},overflow:document.querySelector('.reader-sidebar-top').scrollWidth>document.querySelector('.reader-sidebar-top').clientWidth};};
  let f=await ev(row);assert(f.a.y===f.b.y&&f.a.x===f.t.x&&Math.abs(f.b.right-f.t.right)<.5&&!f.overflow,'顶行同行两端对齐',f);
  await ev(()=>{const t=document.querySelector('.reader-sidebar-top'),a=t.querySelector('.reader-shelf-back').getBoundingClientRect(),b=t.querySelector('.reader-sidebar-brand').getBoundingClientRect();t.style.width=(Math.max(a.width,b.width)+10)+'px';});
  f=await ev(row);assert(f.b.y===f.a.bottom+4&&f.b.x===f.t.x&&!f.overflow,'临时收窄自然换行',f);
  await ev(()=>document.querySelector('.reader-sidebar-top').style.flexWrap='nowrap');f=await ev(row);assert(f.overflow||f.b.right>f.t.right,'禁用换行负对照检出',f);negative++;
  await ev(()=>{const t=document.querySelector('.reader-sidebar-top');t.style.removeProperty('width');t.style.removeProperty('flex-wrap');});f=await ev(row);assert(f.a.y===f.b.y&&!f.overflow,'恢复同行',f);console.log(JSON.stringify({width,top:f}));
  const footer=()=>{const col=document.querySelector('.col-left'),b=col.querySelector('.feedback-button').getBoundingClientRect(),r=col.getBoundingClientRect();return Math.abs(b.bottom-r.bottom+parseFloat(getComputedStyle(col).paddingBottom))<.5;};
  assert(await ev(footer),'反馈位于可视底部');await ev(()=>document.querySelector('.feedback-button').click());await wait(()=>c.evaluate("!!document.querySelector('.feedback-card')"),'反馈卡');await sleep(350);assert(await ev(()=>{const c=document.querySelector('.feedback-card'),r=c.getBoundingClientRect(),b=document.querySelector('.feedback-button').getBoundingClientRect();return c.dataset.side==='above'&&r.bottom<=b.top&&r.top>=0&&r.left>=0&&r.right<=document.documentElement.clientWidth;}),'反馈向上且在视口内');await ev(()=>document.querySelector('.feedback-close').click());
  if(width===768){
   await negativeCheck('恢复旧左栏',()=>getComputedStyle(document.querySelector('.reader-sidebar-content')).display==='block'&&getComputedStyle(document.querySelector('.col-left>.wordmark')).display==='none',()=>document.querySelector('.reader-sidebar-content').style.display='contents',()=>document.querySelector('.reader-sidebar-content').style.removeProperty('display'));
   await negativeCheck('字标溢出左栏',()=>{const a=document.querySelector('.reader-sidebar-brand').getBoundingClientRect(),b=document.querySelector('.col-left').getBoundingClientRect();return a.left>=b.left&&a.right<=b.right;},()=>document.querySelector('.reader-sidebar-brand').style.transform='translateX(500px)',()=>document.querySelector('.reader-sidebar-brand').style.removeProperty('transform'));
   await negativeCheck('反馈回到上方',footer,()=>document.querySelector('.feedback-reader').style.transform='translateY(-100px)',()=>document.querySelector('.feedback-reader').style.removeProperty('transform'));
  }
 }
 for(const width of [320,375]){
  await load('/read/g75',width);
  assert(await ev(()=>![...document.querySelectorAll('.col-left .brand-wordmark')].some(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)),'手机阅读页无品牌');
  await ev(()=>document.querySelector('.sentence[data-index="0"]').click());
  await wait(()=>c.evaluate("!!document.querySelector('.action-row-save:not(:disabled)')"),'普通白话');
  await actionText('.action-row-save','收藏');await actionText('.action-row-explain','脉络解读');
  await ev(()=>document.querySelector('.action-row-save').click());await actionText('.action-row-save','取消收藏');
  await negativeCheck("书签无障碍名称",()=>document.querySelector(".action-row-save").getAttribute("aria-label")==="取消收藏",()=>document.querySelector(".action-row-save").setAttribute("aria-label","收藏"),()=>document.querySelector(".action-row-save").setAttribute("aria-label","取消收藏"));
  await negativeCheck("解读入口无障碍名称",()=>document.querySelector(".action-row-explain").getAttribute("aria-label")==="脉络解读",()=>document.querySelector(".action-row-explain").setAttribute("aria-label","听不懂"),()=>document.querySelector(".action-row-explain").setAttribute("aria-label","脉络解读"));
  assert(await ev(()=>getComputedStyle(document.querySelector('.action-row-save')).fontSize==='13px'),'下方控件13px');
  await negativeCheck("下方书签字号",()=>getComputedStyle(document.querySelector(".action-row-save")).fontSize==="13px",()=>document.querySelector(".action-row-save").style.fontSize="14px",()=>document.querySelector(".action-row-save").style.removeProperty("font-size"));
 assert(await ev(noOverflow),'操作行零溢出',{width});
  await ev(()=>{const roles=['.action-row-save','.action-row-explain'];window.__g75Roles=()=>roles.map(role=>{const s=getComputedStyle(document.querySelector(role));return {role,values:['fontFamily','fontSize','lineHeight','letterSpacing','textAlign','textIndent','color','wordBreak','lineBreak'].map(p=>s[p])};});window.__g75RoleBefore=JSON.stringify(__g75Roles());});
  await negativeCheck('G66按角色比较未改属性',()=>JSON.stringify(__g75Roles())===__g75RoleBefore,()=>document.querySelector('.action-row-save').style.color='red',()=>document.querySelector('.action-row-save').style.removeProperty('color'));
  await negativeCheck('操作行溢出',noOverflow,()=>document.querySelector('.action-row').style.width='2000px',()=>document.querySelector('.action-row').style.removeProperty('width'));
  await ev(()=>document.querySelector('.reader-typography-aa').click());await wait(()=>c.evaluate("!!document.querySelector('.reader-typography-sheet')"),'手机设置');
  await ev(()=>{const b=document.querySelector('.reader-more-typography');if(b?.getAttribute('aria-expanded')==='false')b.click();});await sleep(350);
  const settingsFavorites=()=>{const sheet=document.querySelector(".reader-typography-sheet"),group=sheet.querySelector('[role="group"][aria-label="收藏显示设置"]');return group?.querySelector(".mode-label")?.textContent==="收藏"&&[...group.querySelectorAll("button")].map(b=>b.textContent).join("|")==="显示|收起"&&!sheet.querySelector(".saved-list,.saved-link,#saved-title");};
  assert(await ev(settingsFavorites),"Aa保留显示收起并移出收藏列表");
  await negativeCheck("Aa收藏标签",settingsFavorites,()=>document.querySelector(".reader-typography-sheet .mode-label").textContent="收藏的白话",()=>document.querySelector(".reader-typography-sheet .mode-label").textContent="收藏");
  await negativeCheck("Aa不得恢复收藏列表",settingsFavorites,()=>{const list=document.createElement("ol");list.className="saved-list";list.id="g76-aa-negative";document.querySelector(".reader-typography-sheet").append(list);},()=>document.querySelector("#g76-aa-negative").remove());
  await ev(()=>document.querySelector('.reader-typography-sheet-header button').click());
  await ev(()=>{localStorage.removeItem('gloss:saved:g75');localStorage.removeItem('gloss:selection-saved:g75');});await load('/read/g75',width);
  await selectionResult(width);assert(await ev(noOldWords),'阅读页旧词零残留');
  await ev(()=>document.querySelector('.reader-shelf-back').click());await wait(()=>c.evaluate("!!document.querySelector('.shelf-page')"),'离开阅读页');assert(await c.evaluate('document.title')==='Glossline 句下','离页恢复标题');
 }
 await load('/read/g75',1280);
 await negativeCheck('G73d字标字号判据',()=>{const s=getComputedStyle(document.querySelector('.reader-sidebar-brand .brand-english'));return s.fontSize==='20px'&&s.fontWeight==='600'&&!document.querySelector('.col-left .brand-chinese');},()=>document.querySelector('.reader-sidebar-brand .brand-english').style.fontSize='14px',()=>document.querySelector('.reader-sidebar-brand .brand-english').style.removeProperty('font-size'));
 await ev(()=>{window.__g75MainX=document.querySelector('.col-main').getBoundingClientRect().x;});
 await negativeCheck('G19主题正文几何判据',()=>document.querySelector('.col-main').getBoundingClientRect().x===__g75MainX,()=>document.querySelector('.col-main').style.transform='translateX(1px)',()=>document.querySelector('.col-main').style.removeProperty('transform'));
 const savedHeading=()=>{const section=document.querySelector('[aria-labelledby="saved-title"]');return section.querySelector("#saved-title").textContent==="收藏 · "+section.querySelectorAll(".saved-link").length;};
 assert(await ev(savedHeading),"左栏收藏标题与条目总数");
 await negativeCheck("收藏标题旧词",savedHeading,()=>document.querySelector("#saved-title").firstChild.nodeValue="收藏的白话",()=>document.querySelector("#saved-title").firstChild.nodeValue="收藏");
 await negativeCheck("收藏计数",savedHeading,()=>document.querySelector("#saved-title .reader-saved-count").textContent=" · 999999",()=>{const section=document.querySelector('[aria-labelledby="saved-title"]');section.querySelector(".reader-saved-count").textContent=" · "+section.querySelectorAll(".saved-link").length;});
 await load('/',375);await ev(()=>{localStorage.clear();localStorage.setItem('gloss:analytics:optout','1');localStorage.setItem('gloss:sample:breathed','1');});await load('/',375);
 await negativeCheck('空书架落款',()=>!document.querySelector('.shelf-brand-footer'),()=>{const e=document.createElement('div');e.className='shelf-brand-footer';document.body.append(e);},()=>document.querySelector('.shelf-brand-footer').remove());
 // 对照副本用于字号下限，字体大小取同一最大正文设置。
 await load('/',375,'http://127.0.0.1:3510');await wait(()=>c.evaluate("!!document.querySelector('.landing-demo-visible .action-row-save')"),'基线演示');const baselineDemoSize=await c.evaluate("parseFloat(getComputedStyle(document.querySelector('.landing-demo-visible .action-row-save')).fontSize)");assert(candidateDemoSizes.every(size=>size===13),'演示下方控件13px',{candidateDemoSizes,baselineDemoSize});await ev(seed);await load('/read/g75',375,'http://127.0.0.1:3510');await ev(()=>document.querySelector('.sentence[data-index="0"]').click());await wait(()=>c.evaluate("!!document.querySelector('.action-row-save:not(:disabled)')"),'基线操作行');
 const baselineSize=await c.evaluate("parseFloat(getComputedStyle(document.querySelector('.action-row-save')).fontSize)");
 await load('/',375);await ev(seed);await load('/read/g75',375);await ev(()=>{localStorage.removeItem('gloss:saved:g75');localStorage.removeItem('gloss:selection-saved:g75');});await load('/read/g75',375);await ev(()=>document.querySelector('.sentence[data-index="0"]').click());await wait(()=>c.evaluate("!!document.querySelector('.action-row-save:not(:disabled)')"),'候选操作行');
 assert(await ev(()=>getComputedStyle(document.querySelector('.action-row-save')).fontSize==='13px'),'阅读下方控件13px',{baselineSize});
 console.log(JSON.stringify({scenes,negative,passed:true}));
}finally{try{if(c&&edge.exitCode===null)await c.call('Browser.close');}finally{c?.close();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);const absolute=resolve(profile);if(!absolute.startsWith(resolve(tmpdir(),'gloss-g75-')))throw Error('临时目录路径不符');try{await rm(absolute,{recursive:true,force:true});}catch(error){console.warn('临时浏览器目录清理失败：'+error.code);}}}
