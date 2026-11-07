// G-73d：生产构建双副本几何、左栏与抽屉手势验证。
import {spawn,execFileSync} from 'node:child_process';
const titleBaselineCss=execFileSync('git',['show','183a6ca:styles/reader.css'],{encoding:'utf8'});
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,evaluate}=await import('./verify-g19.mjs');
const profile=await mkdtemp(join(tmpdir(),'gloss-g73d-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--disable-sync','--user-data-dir='+profile,'--remote-debugging-port=9506','--remote-allow-origins=*','about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,label)=>{if(!ok)throw Error(label);};
let c,scenes=0,negatives=0,maxDelta=0;
const ev=(fn,...args)=>evaluate(c,fn,...args);
async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('等待失败 '+label);}
async function settle(){await ev(()=>document.fonts.ready);await ev(()=>new Promise(r=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(r)),400)));}
async function click(sel){await ev(sel=>{const el=[...document.querySelectorAll(sel)].find(e=>e.getClientRects().length);if(!el)throw Error('缺少可见控件 '+sel);el.click();},sel);await settle();}
function geometry(){
 const rect=r=>[r.left,r.top+scrollY,r.right,r.bottom+scrollY];
 const out={main:rect(document.querySelector('.col-main').getBoundingClientRect()),body:rect(document.querySelector('.reader-body').getBoundingClientRect()),chars:{}};
 const panels=[...document.querySelectorAll(".reader-body .gloss-panel")];out.panels=Object.fromEntries(panels.map(p=>[p.dataset.selectionId?"selection:"+p.dataset.selectionId:"sentence:"+p.dataset.sentenceIndex,p.getBoundingClientRect().height]));out.beforePanels={};
 const groups=new Map();
 for(const span of document.querySelectorAll('.reader-body [data-para] .sentence')){const key=span.closest('[data-para]').dataset.para;const list=groups.get(key)??[];list.push(span);groups.set(key,list);}
 for(const [key,spans] of groups){for(const [side,span] of [['first',spans[0]],['last',spans.at(-1)]]){const n=span.firstChild;if(!(n instanceof Text)||!n.length)throw Error('段落缺字 '+key);const r=document.createRange();const i=side==='first'?0:n.length-1;r.setStart(n,i);r.setEnd(n,i+1);out.chars[key+':'+side]=rect(r.getBoundingClientRect());out.beforePanels[key+':'+side]=panels.filter(p=>!!(p.compareDocumentPosition(span)&Node.DOCUMENT_POSITION_FOLLOWING)).map(p=>p.dataset.selectionId?'selection:'+p.dataset.selectionId:'sentence:'+p.dataset.sentenceIndex);}}
 return out;
}
function same(a,b,record=true){if(JSON.stringify(Object.keys(a.chars))!==JSON.stringify(Object.keys(b.chars)))return false;for(const [k,r] of Object.entries({...a.chars,main:a.main,body:a.body})){const v=({...b.chars,main:b.main,body:b.body})[k];if(!v)return false;for(let i=0;i<4;i++){if(record)maxDelta=Math.max(maxDelta,Math.abs(r[i]-v[i]));if(r[i]!==v[i])return false;}}return true;}
function samePanelFlow(base,current,record=true){
 const projected=structuredClone(current),keys=Object.keys(base.panels);if(JSON.stringify(keys)!==JSON.stringify(Object.keys(current.panels)))return false;
 const delta=key=>current.panels[key]-base.panels[key];
 for(const key of Object.keys(base.chars)){const before=base.beforePanels[key];if(JSON.stringify(before)!==JSON.stringify(current.beforePanels[key]))return false;const shift=before.reduce((sum,key)=>sum+delta(key),0);projected.chars[key][1]-=shift;projected.chars[key][3]-=shift;}
 // 容器末边仅扣除内部面板实测增高；其余中栏、正文和网格几何仍用原严格比较。
 const total=keys.reduce((sum,key)=>sum+delta(key),0);projected.main[3]-=total;projected.body[3]-=total;
 return same(base,projected,record);
}
const source=(await readFile('test-fixtures/社会哲学概论-全书.txt','utf8')).split(/\r?\n/).map(s=>s.trim()).filter(s=>s.length>30).slice(0,80);
const book={version:1,docId:'g73d',paragraphs:source,headings:source.map((s,i)=>({paraIndex:i,level:1,text:s.slice(0,30)})),footnotes:[],meta:{format:'txt',fileName:'社会哲学概论-全书.txt',charCount:source.join('').length},savedAt:1};
async function load(port,width,theme,kind,mode){
 await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
 await c.call('Page.navigate',{url:'http://127.0.0.1:'+port+'/read/sample'});
 await wait(()=>c.evaluate("document.readyState==='complete'&&!!document.querySelector('.reader-body .sentence')"),'示例');
 await ev((book,theme,mode)=>{localStorage.clear();localStorage.setItem('gloss:analytics:optout','1');localStorage.setItem('gloss:sample:breathed','1');localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');localStorage.setItem('gloss:settings:reading-mode',mode);localStorage.setItem('gloss:doc:g73d',JSON.stringify(book));},book,theme,mode);
 const url='http://127.0.0.1:'+port+'/read/'+(kind==='sample'?'sample':'g73d');
 await c.call('Page.navigate',{url});await wait(()=>c.evaluate("!!document.querySelector('.reader-body .sentence')&&!document.querySelector('.reader-body-measuring')&&document.querySelector('.reader-shelf-back')?.style.visibility==='visible'"),'正文');await settle();
 if(kind!=='sample'){
 await ev(async()=>{
 const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const spans=[...document.querySelectorAll('.reader-body .sentence')].slice(0,10),entries=[];
 for(const span of spans.slice(0,9))entries.push({paraIndex:Number(span.closest('[data-para]').dataset.para),start:Number(span.dataset.offset),sourceHash:await hash(span.textContent),text:'这是供左栏验收使用的很长很长的保存白话，必须单行省略。',savedAt:1,kind:'saved'});
 localStorage.setItem('gloss:saved:g73d',JSON.stringify({version:1,entries}));
 const span=spans[9],start={paraIndex:Number(span.closest('[data-para]').dataset.para),offset:Number(span.dataset.offset)},end={...start,offset:start.offset+span.textContent.length};
 localStorage.setItem('gloss:selection-saved:g73d',JSON.stringify({version:1,entries:[{resultKind:'range',start,end,sourceHash:await hash(span.textContent),text:'划选保存的白话',savedAt:1,promptVersion:'test',model:'test'}]}));
 });
 await c.call('Page.reload');await wait(()=>c.evaluate("document.querySelectorAll('.saved-link').length===10&&!document.querySelector('.reader-body-measuring')"),'混合保存');await settle();
 }
}
function footer(){const col=document.querySelector('.col-left'),b=col.querySelector('.feedback-button').getBoundingClientRect(),content=col.querySelector('.reader-sidebar-content').getBoundingClientRect(),r=col.getBoundingClientRect();return b.bottom===r.bottom-parseFloat(getComputedStyle(col).paddingBottom)&&b.top>=content.bottom&&b.bottom<=innerHeight;}
function upward(){const card=document.querySelector('.feedback-card'),r=card.getBoundingClientRect(),b=document.querySelector('.feedback-button').getBoundingClientRect(),a=card.querySelector('.feedback-arrow'),s=getComputedStyle(a);return card.dataset.side==='above'&&r.bottom<=b.top&&r.top>=0&&r.left>=0&&r.right<=document.documentElement.clientWidth&&s.bottom==='-6px'&&s.transform!=='none';}
async function negative(label,predicate,mutate,restore){assert(await ev(predicate),label+' 正对照');await ev(mutate);try{assert(!await ev(predicate),label+' 未检出');negatives++;}finally{await ev(restore);await settle();assert(await ev(predicate),label+' 恢复失败');}}
async function sidebar(){
 assert(await ev(()=>document.querySelector('.reader-book-title').textContent==='社会哲学概论-全书'&&document.querySelectorAll('.reader-book-stats>div').length===3&&!document.querySelector('.reader-book-stats').textContent.includes('页')&&document.querySelector('.reader-saved-count').textContent.trim()==='· 10'&&!!document.querySelector('.reader-saved-heading .mode-switch')),'书名数字混合计数与开关');
 assert(await ev(()=>[...document.querySelectorAll('.saved-link')].every(e=>{const s=getComputedStyle(e);return s.fontSize==='13px'&&s.whiteSpace==='nowrap'&&s.textOverflow==='ellipsis'&&s.borderLeftWidth==='2px';})),'列表单行');
 await ev(()=>document.querySelector('.reader-sidebar-content').scrollTop=100000);assert(await ev(footer),'长列表底部');
 await negative('footer 回内容流',footer,()=>{const e=document.querySelector('.feedback-reader');window.__footerParent=e.parentNode;window.__footerNext=e.nextSibling;document.querySelector('.reader-sidebar-content').prepend(e);},()=>{__footerParent.insertBefore(document.querySelector('.feedback-reader'),__footerNext);});
 await click('.feedback-button');assert(await ev(upward),'卡片向上');
 await negative('向下开',upward,()=>{const card=document.querySelector('.feedback-card');window.__top=card.style.top;card.style.top=document.querySelector('.feedback-button').getBoundingClientRect().bottom+8+'px';card.dataset.side='below';},()=>{const card=document.querySelector('.feedback-card');card.style.top=__top;card.dataset.side='above';});
 await click('.feedback-close');scenes++;
}
async function revisedSidebar(){
 const title=()=>{const s=getComputedStyle(document.querySelector('.reader-book-title'));return [s.fontWeight,s.fontSize,s.fontFamily];};
 const current=await ev(title);await ev(css=>{const e=document.createElement('style');e.id='title-baseline';e.textContent=css;document.head.append(e);},titleBaselineCss);const previous=await ev(title);await ev(()=>document.querySelector('#title-baseline').remove());assert(JSON.stringify(current)===JSON.stringify(previous),'书名保持183a6ca计算样式');
 assert(await ev(()=>{const doc=document.querySelector('#doc-title'),stats=document.querySelector('.reader-book-stats'),cells=[...stats.children];return getComputedStyle(doc).borderBottomWidth==='0px'&&getComputedStyle(stats).justifyContent==='flex-start'&&getComputedStyle(stats).columnGap==='18px'&&cells.map(e=>e.querySelector('span').textContent).join(',')==='全文字数,段,句'&&cells.every(e=>{const n=e.querySelector('strong'),l=e.querySelector('span'),s=getComputedStyle(n);return getComputedStyle(e).borderRightWidth==='0px'&&l.getBoundingClientRect().top<n.getBoundingClientRect().top&&getComputedStyle(l).fontSize==='11px'&&s.fontSize==='15px'&&s.fontWeight==='400'&&s.fontVariantNumeric.includes('tabular-nums');})&&[...document.querySelectorAll('.reader-sidebar-content .side-title,.saved-link')].every(e=>getComputedStyle(e).fontWeight==='400');}),'新版栏目数字与字重');scenes+=2;
}
// 数值均直接检查计算样式，颜色通过现有变量解析后比较。
async function detailedSidebar(){
 const result=await ev(()=>{
  const errors=[],s=q=>getComputedStyle(document.querySelector(q));
  const color=token=>{const e=document.createElement('span');e.style.color=`var(${token})`;document.body.append(e);const value=getComputedStyle(e).color;e.remove();return value;};
  const rule=color('--rule'),gloss=color('--gloss'),ink=color('--ink'),paper=color('--paper-main');
  const check=(q,expected)=>{const elements=[...document.querySelectorAll(q)];for(const e of elements){const c=getComputedStyle(e);for(const [k,v]of Object.entries(expected))if(c[k]!==v)errors.push(`${q} ${k}: ${c[k]} != ${v}`);}return elements.length;};
  const padding=innerWidth<1000?'20px':'28px';check('.col-left',{paddingTop:padding,paddingRight:padding,paddingBottom:innerWidth<1000?'20px':'32px',paddingLeft:padding});
  check('.reader-sidebar-content',{marginTop:'40px'});check('.reader-sidebar-content .side-section:not(:first-child)',{marginTop:'40px'});check('.col-left>.feedback-reader',{paddingTop:'40px',alignSelf:'flex-start'});
  check('.reader-shelf-back',{fontSize:'13px',color:gloss,minHeight:'36px',alignItems:'center'});
  check('.reader-sidebar-brand',{alignItems:'center'});
  const back=document.querySelector('.reader-shelf-back').getBoundingClientRect(),brand=document.querySelector('.reader-sidebar-brand').getBoundingClientRect();if(back.top+back.height/2!==brand.top+brand.height/2)errors.push('顶行垂直居中');
  const probe=document.createElement('span');probe.style.fontFamily='var(--font-brand)';document.body.append(probe);if(s('.reader-sidebar-brand .brand-english').fontFamily!==getComputedStyle(probe).fontFamily)errors.push('Glossline字体');probe.remove();check('.reader-sidebar-brand .brand-english',{fontWeight:'600',fontSize:'20px'});if(document.querySelector('.col-left .brand-chinese'))errors.push('左栏不应显示句下');
  check('#doc-title',{fontSize:'12px',letterSpacing:'1.44px',color:gloss,fontWeight:'400',marginTop:'0px',marginRight:'0px',marginBottom:'8px',marginLeft:'0px',paddingBottom:'0px',borderBottomWidth:'0px',textDecorationLine:'none'});
  check('.reader-book-title',{marginTop:'0px',marginRight:'0px',marginBottom:'0px',marginLeft:'0px'});
  check('.reader-book-stats',{marginTop:'18px',paddingTop:'14px',borderTopWidth:'1px',borderTopColor:rule,columnGap:'18px',rowGap:'18px',justifyContent:'flex-start'});
  check('.reader-book-stats span',{fontSize:'11px',letterSpacing:'0.88px',color:gloss});check('.reader-book-stats strong',{fontSize:'15px',marginTop:'4px',fontWeight:'400',fontVariantNumeric:'tabular-nums'});
  check('#toc-title',{fontSize:'11px',letterSpacing:'1.1px',color:gloss,fontWeight:'400',marginTop:'0px',marginRight:'0px',marginBottom:'12px',marginLeft:'0px',paddingBottom:'10px',borderBottomWidth:'1px',borderBottomColor:rule});
  check('.side-empty',{fontSize:'13px',lineHeight:'22.1px',color:gloss});
  check('.reader-saved-heading',{display:'flex',justifyContent:'space-between',alignItems:'center',paddingBottom:'8px',borderBottomWidth:'1px',borderBottomColor:rule,marginBottom:'14px'});
  check('#saved-title',{fontSize:'11px',letterSpacing:'1.1px',color:gloss,fontWeight:'400'});
  check('.reader-sidebar-mode .mode-options',{borderTopWidth:'1px',borderRightWidth:'1px',borderBottomWidth:'1px',borderLeftWidth:'1px',borderTopColor:rule,borderRadius:'0px'});
  check('.reader-sidebar-mode .mode-option',{fontSize:'12px',paddingTop:'0px',paddingRight:'10px',paddingBottom:'0px',paddingLeft:'10px',minHeight:'28px',borderTopWidth:'0px',borderRightWidth:'0px',borderBottomWidth:'0px',borderLeftWidth:'0px',borderRadius:'0px'});
  check('.reader-sidebar-mode .mode-option[aria-pressed=true]',{color:ink,backgroundColor:paper});check('.reader-sidebar-mode .mode-option[aria-pressed=false]',{color:gloss,backgroundColor:'rgba(0, 0, 0, 0)'});
  check('.saved-link',{paddingTop:'8px',paddingRight:'0px',paddingBottom:'8px',paddingLeft:'12px',borderLeftWidth:'2px',borderLeftColor:rule,fontSize:'13px',lineHeight:'22.1px',color:ink,whiteSpace:'nowrap',textOverflow:'ellipsis'});check('.saved-list li',{marginTop:'0px'});
  check('.feedback-reader>.feedback-button',{display:'inline-flex',columnGap:'8px',minHeight:'36px',paddingTop:'0px',paddingRight:'14px',paddingBottom:'0px',paddingLeft:'14px',fontSize:'13px',borderTopWidth:'1px',borderTopColor:ink,backgroundColor:'rgba(0, 0, 0, 0)'});
  const button=document.querySelector('.feedback-reader>.feedback-button'),r=button.getBoundingClientRect(),col=document.querySelector('.col-left').getBoundingClientRect();if(r.left!==col.left+parseFloat(s('.col-left').paddingLeft)||r.width>=col.width-2*parseFloat(s('.col-left').paddingLeft))errors.push('反馈非满宽且靠左');
  return errors;
 });assert(result.length===0,'设计稿逐项计算样式 '+JSON.stringify(result));scenes+=9;
}
// 条目跳转使用原生鼠标输入，覆盖页面事件委托的真实传播路径。
async function realClick(sel){
 await ev(sel=>document.querySelector(sel).scrollIntoView({block:'nearest',behavior:'instant'}),sel);await settle();
 const p=await ev(sel=>{const r=document.querySelector(sel).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},sel);
 await c.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
 await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle();
}
async function jumpHighlights(){
 await click('.reader-sidebar-mode .mode-option:first-child');await click('.reader-sidebar-mode .mode-option:last-child');
 const active=()=>[...document.querySelectorAll('.saved-link[data-jump-highlight="true"]')].map(e=>e.dataset.savedSelectionId||'sentence');
 const single='.saved-link:not([data-saved-selection-id])',selection='.saved-link[data-saved-selection-id]';
 for(const sel of [single,selection]){
 await realClick(sel);assert((await ev(active)).length===1,'跳转高亮');if(sel===single){assert(await ev(()=>!!document.querySelector('.gloss-panel-saved[data-sentence-index="0"]')&&!document.querySelector('.sentence[data-index="0"]').classList.contains('sentence-saved-collapsed')),'真实点击单句保持展开');scenes++;}await ev(()=>{scrollBy(0,10);dispatchEvent(new Event('scroll'));});await settle();assert((await ev(active)).length===1,'程序滚动保留');scenes++;
 await ev(()=>window.dispatchEvent(new WheelEvent('wheel',{deltaY:100})));await settle();assert((await ev(active)).length===0,'用户滚轮清除');scenes++;
 await realClick(sel);await realClick(sel===single?selection:single);assert((await ev(active)).length===1&&(await ev(active))[0]===(sel===single?await ev(()=>document.querySelector('.saved-link[data-saved-selection-id]').dataset.savedSelectionId):'sentence'),'高亮移到另一条');scenes++;
 await click('.reader-sidebar-mode .mode-option:first-child');await click('.reader-sidebar-mode .mode-option:last-child');assert((await ev(active)).length===0,'收起清除高亮');scenes++;
 }
 // 临时改变页面标记模拟故障；每次恢复原标记并重走真实清除路径。
 await realClick(single);await ev(()=>window.dispatchEvent(new WheelEvent('wheel',{deltaY:100})));await settle();
 await negative('滚动不清除',()=>!document.querySelector('[data-jump-highlight="true"]'),()=>document.querySelector('.saved-link').setAttribute('data-jump-highlight','true'),()=>document.querySelector('.saved-link').removeAttribute('data-jump-highlight'));
 await realClick(single);await negative('程序滚动误清除',()=>!!document.querySelector('[data-jump-highlight="true"]'),()=>document.querySelector('[data-jump-highlight]').removeAttribute('data-jump-highlight'),()=>document.querySelector('.saved-link').setAttribute('data-jump-highlight','true'));
 await click('.reader-sidebar-mode .mode-option:first-child');await click('.reader-sidebar-mode .mode-option:last-child');
 await negative('收起不清除',()=>!document.querySelector('[data-jump-highlight="true"]'),()=>document.querySelector('.saved-link').setAttribute('data-jump-highlight','true'),()=>document.querySelector('.saved-link').removeAttribute('data-jump-highlight'));
}
// 合成完整触摸链路并固定事件时间，避免机器速度影响甩动边界。
async function drag(sel,distance,fast=false){await ev((sel,distance,fast)=>{const target=document.querySelector(sel);const duration=fast?20:1000;for(const [type,y,time]of [['touchstart',0,0],['touchmove',distance,duration],['touchend',distance,duration+1]]){const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(e,{touches:{value:type==='touchend'?[]:[{clientY:y}]},timeStamp:{value:time+1000}});target.dispatchEvent(e);}},sel,distance,fast);await settle();}
async function openSettings(){await click('.reader-typography-aa');}
async function openFeedback(){await openSettings();await click('.reader-settings-feedback');}
function state(){return{focus:document.activeElement?.className,overflow:document.documentElement.style.overflow,inert:[...document.body.children].filter(e=>e.inert).length,aa:document.querySelector('.reader-typography-aa').getAttribute('aria-expanded')};}
async function gestures(kind){
 const sheet=kind==='feedback'?'.feedback-card':'.reader-typography-sheet',head=kind==='feedback'?'.feedback-header h2':'.reader-typography-sheet-header h2',open=kind==='feedback'?openFeedback:openSettings;
 await open();if(kind==='feedback'){await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await settle();}else await click('.reader-typography-sheet-header button');
 const expected=await ev(state),before=await ev(geometry);
 for(const [distance,fast,closed]of [[79,false,false],[81,false,true],[20,true,true]]){await open();await drag(head,distance,fast);assert(await ev(sel=>!!document.querySelector(sel),sheet)===!closed,kind+' 拖动边界 '+distance);if(!closed){if(kind==='feedback'){await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle();}else await click('.reader-typography-sheet-header button');}assert(JSON.stringify(await ev(state))===JSON.stringify(expected),kind+' 关闭状态与焦点');assert(same(before,await ev(geometry)),kind+' 开关正文零位移');scenes++;}
 const controls=kind==='feedback'?['.feedback-send','.feedback-form textarea','.feedback-form input']:['.reader-size-stepper button','.reader-typography-sheet [data-typography=lineHeight]'];
 for(const control of controls){await open();if(control.includes('lineHeight'))await click('.reader-more-typography');await drag(control,100);assert(await ev(sel=>!!document.querySelector(sel),sheet),kind+' 控件起拖误关');if(kind==='feedback'){await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle();}else await click('.reader-typography-sheet-header button');scenes++;}
 // 故障直接移除外壳模拟绕过关闭链路，状态比较必须识别未解锁/未归还焦点。
 await open();await ev(sel=>document.querySelector(sel).remove(),sheet);assert(JSON.stringify(await ev(state))!==JSON.stringify(expected),kind+' 绕过关闭未检出');negatives++;
}
try{
 await wait(async()=>{try{const tabs=await(await fetch('http://127.0.0.1:9506/json')).json();const t=tabs.find(t=>t.type==='page');if(!t)return false;c=new Cdp(t.webSocketDebuggerUrl);return true;}catch{return false;}},'Edge');
 await c.call('Page.enable');await c.call('Runtime.enable');
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:"const nativeFetch=window.fetch;window.fetch=(...args)=>String(args[0]).startsWith('/api/')?Promise.resolve(new Response(null,{status:503})):nativeFetch(...args);"});
 for(const width of [375,768,800,900,999,1000,1280,1440])for(const theme of ['parchment','dark'])for(const kind of ['sample','long'])for(const mode of ['review','reading']){
 const pair=[];
 for(const port of [3506,3507]){await load(port,width,theme,kind,mode);const snaps=[];for(const position of ['top','middle']){await ev(position=>scrollTo(0,position==='top'?0:Math.floor((document.documentElement.scrollHeight-innerHeight)/2)),position);await settle();snaps.push(await ev(geometry));}pair.push(snaps);}
 for(let i=0;i<2;i++){assert(samePanelFlow(pair[0][i],pair[1][i]),'几何差异 '+JSON.stringify({width,theme,kind,mode,position:i,maxDelta}));scenes++;
 const base=pair[0][i],current=pair[1][i],below=Object.keys(current.chars).find(key=>current.beforePanels[key].length),above=Object.keys(current.chars).find(key=>!current.beforePanels[key].length);
 for(const [name,key] of [["下方原文",below],["上方或被点句",above]])if(key){const bad=structuredClone(current);bad.chars[key][1]+=1;bad.chars[key][3]+=1;assert(!samePanelFlow(base,bad,false),name+"额外1px负对照");negatives++;}
 }
 console.log(JSON.stringify({width,theme,kind,mode,geometry:2,maxDelta}));
 }
 for(const width of [768,800,900,999,1000,1280])for(const theme of ['parchment','moon-white','eye-green','dark']){
 await load(3507,width,theme,'long','reading');await sidebar();await revisedSidebar();await detailedSidebar();
 await ev(()=>{localStorage.removeItem('gloss:saved:g73d');localStorage.removeItem('gloss:selection-saved:g73d');const doc=JSON.parse(localStorage.getItem('gloss:doc:g73d'));doc.headings=[];localStorage.setItem('gloss:doc:g73d',JSON.stringify(doc));});
 await c.call('Page.reload');await wait(()=>c.evaluate("document.querySelector('.reader-body')?.getAttribute('data-measuring')==='false'&&document.querySelectorAll('.saved-link').length===0&&document.querySelectorAll('.reader-sidebar-content .side-empty').length===2"),'空目录与空列表就绪');await settle();await detailedSidebar();
 await load(3507,width,theme,'long','reading');
 }
 const baseline=await ev(geometry);await ev(()=>{const e=document.querySelector('.shell');window.__tracks=getComputedStyle(e).gridTemplateColumns;const tracks=__tracks.split(' ');tracks[0]=(parseFloat(tracks[0])+1)+'px';tracks[1]=(parseFloat(tracks[1])-1)+'px';e.style.gridTemplateColumns=tracks.join(' ');});assert(!same(baseline,await ev(geometry),false),'轨道+1px 未检出');negatives++;await ev(()=>document.querySelector('.shell').style.removeProperty('grid-template-columns'));assert(same(baseline,await ev(geometry),false),'轨道恢复');
 await jumpHighlights();
 for(const kind of ['feedback','settings']){await load(3507,375,'parchment','sample','review');await gestures(kind);}
 // 控件误关闭负对照采用真实点击关闭入口，原“仍打开”判据应失败。
 await load(3507,375,'parchment','sample','review');await openSettings();await ev(()=>document.querySelector('.reader-size-stepper button').addEventListener('touchend',()=>document.querySelector('.reader-typography-sheet-header button').click(),{once:true}));await drag('.reader-size-stepper button',100);assert(!await ev(()=>!!document.querySelector('.reader-typography-sheet')),'控件误关闭未检出');negatives++;await openSettings();await drag('.reader-size-stepper button',100);assert(await ev(()=>!!document.querySelector('.reader-typography-sheet')),'控件恢复');
 console.log(JSON.stringify({result:'PASS',scenes,maxDelta,negatives}));
}finally{c?.close();edge.kill();await sleep(1000);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
