// G-73d：生产构建双副本几何、左栏与抽屉手势验证。
import {spawn} from 'node:child_process';
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
 const groups=new Map();
 for(const span of document.querySelectorAll('.reader-body [data-para] .sentence')){const key=span.closest('[data-para]').dataset.para;const list=groups.get(key)??[];list.push(span);groups.set(key,list);}
 for(const [key,spans] of groups){for(const [side,span] of [['first',spans[0]],['last',spans.at(-1)]]){const n=span.firstChild;if(!(n instanceof Text)||!n.length)throw Error('段落缺字 '+key);const r=document.createRange();const i=side==='first'?0:n.length-1;r.setStart(n,i);r.setEnd(n,i+1);out.chars[key+':'+side]=rect(r.getBoundingClientRect());}}
 return out;
}
function same(a,b,record=true){if(JSON.stringify(Object.keys(a.chars))!==JSON.stringify(Object.keys(b.chars)))return false;for(const [k,r] of Object.entries({...a.chars,main:a.main,body:a.body})){const v=({...b.chars,main:b.main,body:b.body})[k];if(!v)return false;for(let i=0;i<4;i++){if(record)maxDelta=Math.max(maxDelta,Math.abs(r[i]-v[i]));if(r[i]!==v[i])return false;}}return true;}
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
 for(const width of [375,999,1000,1280,1440])for(const theme of ['parchment','dark'])for(const kind of ['sample','long'])for(const mode of ['review','reading']){
 const pair=[];
 for(const port of [3506,3507]){await load(port,width,theme,kind,mode);const snaps=[];for(const position of ['top','middle']){await ev(position=>scrollTo(0,position==='top'?0:Math.floor((document.documentElement.scrollHeight-innerHeight)/2)),position);await settle();snaps.push(await ev(geometry));}pair.push(snaps);}
 for(let i=0;i<2;i++){assert(same(pair[0][i],pair[1][i]),'几何差异 '+JSON.stringify({width,theme,kind,mode,position:i,maxDelta}));scenes++;}
 console.log(JSON.stringify({width,theme,kind,mode,geometry:2,maxDelta}));
 }
 for(const theme of ['parchment','moon-white','eye-green','dark']){await load(3507,1280,theme,'long','reading');await sidebar();}
 const baseline=await ev(geometry);await ev(()=>{const e=document.querySelector('.shell');window.__tracks=getComputedStyle(e).gridTemplateColumns;const tracks=__tracks.split(' ');tracks[0]=(parseFloat(tracks[0])+1)+'px';tracks[1]=(parseFloat(tracks[1])-1)+'px';e.style.gridTemplateColumns=tracks.join(' ');});assert(!same(baseline,await ev(geometry),false),'轨道+1px 未检出');negatives++;await ev(()=>document.querySelector('.shell').style.removeProperty('grid-template-columns'));assert(same(baseline,await ev(geometry),false),'轨道恢复');
 for(const kind of ['feedback','settings']){await load(3507,375,'parchment','sample','review');await gestures(kind);}
 // 控件误关闭负对照采用真实点击关闭入口，原“仍打开”判据应失败。
 await load(3507,375,'parchment','sample','review');await openSettings();await ev(()=>document.querySelector('.reader-size-stepper button').addEventListener('touchend',()=>document.querySelector('.reader-typography-sheet-header button').click(),{once:true}));await drag('.reader-size-stepper button',100);assert(!await ev(()=>!!document.querySelector('.reader-typography-sheet')),'控件误关闭未检出');negatives++;await openSettings();await drag('.reader-size-stepper button',100);assert(await ev(()=>!!document.querySelector('.reader-typography-sheet')),'控件恢复');
 console.log(JSON.stringify({result:'PASS',scenes,maxDelta,negatives}));
}finally{c?.close();edge.kill();await sleep(1000);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
