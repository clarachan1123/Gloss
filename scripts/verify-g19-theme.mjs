/** Invalid-key production service. All color expectations come from the target theme block. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const ORIGIN=process.env.G19_THEME_ORIGIN??'http://localhost:3472';
process.env.G19_IMPORT_ONLY='1';process.env.G19_ORIGIN=ORIGIN;
const {Cdp,setup,ready,freePort,settle,revealControls,align,open,save,evaluate,ownedShelfCheck,measured}=await import('./verify-g19.mjs');
const ROOT=resolve(import.meta.dirname,'..'), KEY='gloss:settings:theme';
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LIGHT_THEMES=['parchment','moon-white','eye-green'];
const THEMES=[...LIGHT_THEMES,'dark'];
const APPEARANCE='gloss:settings:appearance';
let originalChecks=0, extraChecks=0;
const DIRECTIONS=[['parchment','moon-white'],['moon-white','eye-green'],['eye-green','parchment'],['parchment','eye-green'],['eye-green','moon-white'],['moon-white','parchment']];
const WIDTHS=(process.env.G19_THEME_WIDTHS??'375,506,768,1024,1280').split(',').map(Number);
const CSS=await readFile(join(ROOT,'styles/tokens.css'),'utf8');
const TOKENS=Object.fromEntries(THEMES.map(t=>{const p=CSS.indexOf(`[data-theme="${t}"]`),b=CSS.slice(p,CSS.indexOf('}',p));return[t,Object.fromEntries([...b.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]]))];}));
const mainShelf=execFileSync('git',['-C',ROOT,'show','origin/main:styles/shelf.css'],{encoding:'utf8'});
const MAIN_LEDGE=/\.shelf-ledge\s*\{[^}]+\}/.exec(mainShelf)[0];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,label,detail)=>{if(!v)throw Error(label+(detail===undefined?'':': '+JSON.stringify(detail)));};
async function wait(c,expression){for(let i=0;i<200;i++){if(await c.evaluate(expression))return;await pause(100);}throw Error('Timeout: '+expression);}
async function choose(c,width,theme){await evaluate(c,(width,theme)=>{const scope=document.querySelector(width<768?'.reader-typography-sheet':'.col-right');scope.querySelector(`[data-reader-theme="${theme}"]`).click();},width,theme);await settle(c);}
async function prepare(c,width){
  await ownedShelfCheck(c,width);if(!await c.evaluate("localStorage.getItem('gloss:saved:sample')"))await save(c,5);
  // The shipped sample has no marked terms. Preserve its saved record format, adding a test-only term through the real renderer.
  const changed=await c.evaluate("(()=>{const key='gloss:saved:sample',record=JSON.parse(localStorage.getItem(key));if(record.entries[0].text.includes('⟦'))return false;record.entries[0].text=record.entries[0].text.replace('宗教','⟦宗教⟧');localStorage.setItem(key,JSON.stringify(record));return true})()");
  if(changed){await c.call('Page.reload');await ready(c);}
  await open(c,6);await revealControls(c,width);await align(c,8);
}
async function colors(c,theme,from,page,width){
  const result=await evaluate(c,(theme,from,page,width,tokens)=>{
    const color=hex=>{const p=document.createElement('i');p.style.color=hex;document.body.append(p);const c=getComputedStyle(p).color;p.remove();return c;};
    const rows=[];
    const check=(name,selector,property,token)=>{const el=document.querySelector(selector);if(!el)throw Error('Missing element '+name+' '+selector);
      const actual=getComputedStyle(el)[property],expected=color(tokens[theme][token]),previous=color(tokens[from][token]);
      const residue=expected!==previous&&actual===previous;
      rows.push({name,selector,property,token,actual,expected,previous,residue,passed:actual===expected&&!residue});};
    if(page==='reader'){
      check('中栏','.col-main','backgroundColor','--paper-main');check('侧栏','.col-right','backgroundColor','--paper-side');
      check('正文','.reader-body','color','--text-body');check('白话','.gloss-panel:not(.gloss-panel-saved)','color','--gloss');
      check('已留下白话','.gloss-panel-saved','color','--saved-inline');check('术语','.gloss-term','color','--term');
      check('分隔线','.col-right','borderLeftColor','--rule');check('设置面板','.reader-tool > span:last-child','color','--gloss');
      check('主题控件','.reader-paper-options','color','--ink');check('反馈按钮底色','.feedback-button','backgroundColor','--ink');
      check('反馈按钮文字','.feedback-button','color','--paper-main');
      if(width<768){check('Aa面板','.reader-typography-sheet','backgroundColor','--paper-side');check('Aa按钮边框','.reader-typography-aa','borderTopColor','--rule');}
    }else if(page==='shelf'){
      check('书架页面','body','backgroundColor','--paper-main');check('书架文字','.shelf-page','color','--ink');
    }else{
      check('落地页','.landing-page','backgroundColor','--paper-main');check('落地页文字','.landing-page','color','--ink');
      check('落地页演示卡片','.landing-demonstration','backgroundColor','--paper-side');
      check('落地页演示正文','.landing-demo-visible','color','--text-body');check('落地页反馈底色','.feedback-button','backgroundColor','--ink');
      check('落地页演示白话','.landing-demo-panel-play .gloss-panel','color','--gloss');
    }
    return rows;
  },theme,from,page,width,TOKENS);
  console.log(JSON.stringify({width,direction:from+'>'+theme,page,colors:result}));
  originalChecks+=result.length;assert(result.every(r=>r.passed),'Target token mismatch',result.filter(r=>!r.passed));return result;
}
async function hover(c,width,theme,from){
  const r=await c.evaluate('window.__g19.reference()');await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+1,y:r.y+1});await settle(c);
  const actual=await c.evaluate("getComputedStyle(document.querySelector('.sentence-hover')).color");
  const hex=TOKENS[theme]['--hover'],expected=`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
  originalChecks++;assert(actual===expected,'Hover target token',{actual,expected});console.log(JSON.stringify({width,direction:from+'>'+theme,element:'悬停文字',actual,expected,passed:true}));
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await settle(c);
}
async function ledge(c,width,theme,from,baseline=false){
  const result=await evaluate(c,(theme,from,tokens,mainRule,baseline)=>{
    const el=document.querySelector('.shelf-ledge'),css=getComputedStyle(el);
    const snapshot=()=>{const s=getComputedStyle(el);return{gradient:s.backgroundImage,edge:s.borderTopColor,shadow:s.boxShadow};};
    const current=snapshot(),rgba=s=>{let m=/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/.exec(s);
      if(m)return[...m.slice(1,4).map(v=>Math.round(Number(v)*255)),Number(m[4])];
      m=/rgba?\(([^)]+)\)/.exec(s);const n=m[1].split(',').map(Number);return[...n.slice(0,3),n[3]??1];};
    const parts=Object.fromEntries(['top','mid','bottom','edge','shadow'].map(part=>[part,css.getPropertyValue('--shelf-ledge-'+part).trim()]));
    const rgb=hex=>'rgb('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')+')';
    const expected=Object.fromEntries(['top','mid','bottom','edge','shadow'].map(part=>[part,rgb(tokens[theme]['--shelf-ledge-'+part])]));
    const actualShadow=rgba(current.shadow),shadowExpected=[...['--shelf-ledge-shadow'].flatMap(k=>[1,3,5].map(i=>parseInt(tokens[theme][k].slice(i,i+2),16))),.62];
    const passed=['top','mid','bottom'].every(part=>current.gradient.includes(expected[part]))&&current.edge===expected.edge&&JSON.stringify(actualShadow)===JSON.stringify(shadowExpected)&&Object.keys(parts).every(part=>parts[part]===expected[part]);
    let main=null,mainEquivalent=null;
    if(baseline){const style=document.createElement('style');style.textContent=mainRule;document.head.append(style);main=snapshot();style.remove();
      mainEquivalent=current.gradient===main.gradient&&current.edge===main.edge&&JSON.stringify(rgba(current.shadow))===JSON.stringify(rgba(main.shadow));}
    return{parts,expected,current,shadowRGBA:actualShadow,passed,main,mainEquivalent};
  },theme,from,TOKENS,MAIN_LEDGE,baseline);
  originalChecks+=5;console.log(JSON.stringify({width,direction:from+'>'+theme,element:'书架层板五项',...result}));assert(result.passed,'Ledge target tokens',result);
  if(baseline)assert(result.mainEquivalent,'Parchment ledge differs from main',result);
}
async function pages(c,width,from,to){
  await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(c,"!!document.querySelector('.shelf-ledge')");await settle(c);
  await colors(c,to,from,'shelf',width);await ledge(c,width,to,from,to==='parchment');
  await c.evaluate("localStorage.removeItem('gloss:doc:g19-owned');localStorage.removeItem('gloss:shelf:v1')");
  await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(c,"!!document.querySelector('.landing-demo-visible')");await settle(c);
  await wait(c,"!!document.querySelector('.landing-demo-panel-play .gloss-panel')");await settle(c);
  await colors(c,to,from,'landing',width);
}
async function cold(c,width,value){
  await evaluate(c,(key,value)=>{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);},KEY,value);
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
  const expected=LIGHT_THEMES.includes(value)?value:'parchment';
  const record=await c.evaluate('({frames:window.__themeFirstPaint,theme:document.documentElement.dataset.theme,transition:getComputedStyle(document.documentElement).transitionDuration,paints:window.__themePaintEvents})');
  const hex=TOKENS[expected]['--paper-main'],rgb=`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
  assert(record.theme===expected&&record.frames.length>0&&record.frames.every(f=>f.theme===expected&&f.background===rgb),'Cold start flash',record);
  assert(record.transition==='0s','Initial transition enabled',record);console.log(JSON.stringify({width,coldStoredValue:value,expected,firstFrame:record.frames[0],sampledFrames:record.frames.length,paints:record.paints,transition:record.transition,passed:true}));
}

async function expectRoles(c, theme, cases, label) {
  const result=await evaluate(c,(theme,cases,tokens)=>{
    const probe=document.createElement('i');document.body.append(probe);
    for(const [key,value]of Object.entries(tokens[theme]))probe.style.setProperty(key,value);
    const rows=cases.map(([name,selector,property,token,pseudo])=>{
      const el=document.querySelector(selector);if(!el)throw Error('Missing role element '+selector);
      probe.style.color='';probe.style.color=`var(${token})`;
      const expected=getComputedStyle(probe).color,actual=getComputedStyle(el,pseudo??null)[property];
      return{name,selector,property,token,actual,expected,passed:actual===expected};
    });probe.remove();return rows;
  },theme,cases,TOKENS);
  extraChecks+=result.length;console.log(JSON.stringify({width:await c.evaluate('innerWidth'),theme,label,roles:result}));
  assert(result.every(r=>r.passed),'Role token mismatch '+label,result.filter(r=>!r.passed));
}
async function appearance(c,width,value){
  if(width<768)await evaluate(c,value=>document.querySelector(`.reader-typography-sheet [data-reader-appearance="${value}"]`).click(),value);
  else for(let i=0;i<3&&await c.evaluate("localStorage.getItem('gloss:settings:appearance')||'system'")!==value;i++)await c.evaluate("document.querySelector('.reader-appearance-cycle').click()");
  await settle(c);
}
async function paperVisibility(c,width,dark){
  const selector=`${width<768?'.reader-typography-sheet':'.col-right'} .reader-paper-options`;
  const state=await evaluate(c,selector=>{const group=document.querySelector(selector),input=group.querySelector('input,button');return{hidden:group.hidden,display:getComputedStyle(group).display,rects:input.getClientRects().length};},selector);
  assert(state.hidden===dark&&(!dark||state.display==='none'&&state.rects===0),'Bottom group visibility',state);
  const {root}=await c.call('DOM.getDocument');const {nodeId}=await c.call('DOM.querySelector',{nodeId:root.nodeId,selector});
  const {nodes}=await c.call('Accessibility.getPartialAXTree',{nodeId,fetchRelatives:false});
  assert(nodes.length>0&&nodes[0].ignored===dark,'Bottom group AX visibility',{dark,nodes});extraChecks+=2;
  if(dark){const noFocus=await evaluate(c,selector=>{const input=document.querySelector(selector+' :is(input,button)');input.focus({preventScroll:true});return document.activeElement!==input;},selector);assert(noFocus,'Hidden bottom group cannot focus');extraChecks++;}
}
async function surfaceChecks(c,width,theme){
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);await prepare(c,width);await appearance(c,width,theme==='dark'?'dark':'light');
  if(theme!=='dark')await choose(c,width,theme);
  await expectRoles(c,theme,[['正文','.reader-body','color','--text-body'],['主底','.col-main','backgroundColor','--paper-main'],['侧底','.col-right','backgroundColor','--paper-side'],['术语','.gloss-term','color','--term'],['描边',width<768?'.reader-typography-sheet .reader-typography-reset':'.settings-cache-button','borderTopColor','--control-border']],'reader');
  await hover(c,width,theme,theme);originalChecks--;
  await paperVisibility(c,width,theme==='dark');
  if(width<768) {await c.evaluate("document.querySelector('[aria-label=\"关闭阅读排版\"]').click()");await settle(c);}
  if(await c.evaluate("!!document.querySelector('.reader-typography-popover')"))await c.evaluate("document.querySelector('.settings-typography-toggle').click()");
  await c.evaluate("document.querySelector('.feedback-button').click()");await wait(c,"!!document.querySelector('.feedback-card textarea')");
  await expectRoles(c,theme,[['卡片','.feedback-card','backgroundColor','--paper-main'],['输入','.feedback-form textarea','backgroundColor','--input-bg'],['占位','.feedback-form textarea','color','--placeholder','::placeholder'],['主按钮','.feedback-send','backgroundColor','--ink'],['主按钮字','.feedback-send','color','--paper-main']],'feedback');
  await evaluate(c,()=>{const t=document.querySelector('.feedback-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'甲'.repeat(1001));t.dispatchEvent(new Event('input',{bubbles:true}));});await settle(c);
  await expectRoles(c,theme,[['超字数','.feedback-error','color','--text-error']],'feedback-error');
  await c.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle(c);
  await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(c,"!!document.querySelector('.book-spine')");await settle(c);
  await expectRoles(c,theme,[['书架','.shelf-page','color','--ink'],['导入虚线','.import-spine','borderTopColor','--import-border']],'shelf');await ledge(c,width,theme,theme);originalChecks-=5;
  await c.evaluate("document.querySelector('.book-spine').click()");await settle(c);
  await evaluate(c,()=>document.querySelector('.remove-book').click());await settle(c);
  await expectRoles(c,theme,[['移除遮罩','.remove-confirm','backgroundColor','--overlay-remove'],['次按钮','.remove-confirm button','borderTopColor','--control-border']],'remove');
  await c.evaluate("document.querySelector('.remove-confirm button').click();document.querySelector('.import-spine').click()");await settle(c);
  await expectRoles(c,theme,[['导入背板','.import-backdrop','backgroundColor','--overlay-import'],['导入框','.import-panel textarea','backgroundColor','--input-bg'],['上传虚线','label[class*=fileLabel]','borderTopColor','--upload-border'],['关闭描边','.import-close','borderTopColor','--control-border']],'import');
  if(theme==='dark'){
    await c.evaluate("document.querySelector('.import-panel textarea').focus({preventScroll:true})");
    await expectRoles(c,theme,[['输入聚焦','.import-panel textarea','borderTopColor','--ink'],['上传占位','.import-panel textarea','color','--placeholder','::placeholder'],['焦点','.import-panel textarea','outlineColor','--hover']],'import-focus');
  }
  await c.evaluate("document.querySelector('.import-close').click();localStorage.removeItem('gloss:doc:g19-owned');localStorage.removeItem('gloss:shelf:v1')");
  await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(c,"!!document.querySelector('.landing-demo-visible')");await settle(c);
  await expectRoles(c,theme,[['落地页','.landing-page','backgroundColor','--paper-main'],['落地页字','.landing-page','color','--ink'],['次按钮','.landing-secondary','borderTopColor','--secondary-border'],['主按钮','.landing-primary','backgroundColor','--ink']],'landing');
}
async function coldAppearance(c,width){
  for(const a of ['system','light','dark'])for(const system of ['light','dark']){
    await evaluate(c,(key,a)=>{localStorage.setItem(key,a);localStorage.setItem('gloss:settings:theme','moon-white');},APPEARANCE,a);
    await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:system}]});
    await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
    const expected=a==='dark'||a==='system'&&system==='dark'?'dark':'moon-white';
    const record=await c.evaluate('({frames:__themeFirstPaint,theme:document.documentElement.dataset.theme,transition:getComputedStyle(document.documentElement).transitionDuration})');
    const hex=TOKENS[expected]['--paper-main'],rgb=`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
    assert(record.frames.length>0&&record.frames.every(f=>f.theme===expected&&f.background===rgb)&&record.theme===expected&&record.transition==='0s','Appearance cold flash',{a,system,expected,record});
    extraChecks++;console.log(JSON.stringify({width,coldAppearance:a,system,expected,frames:record.frames.length,passed:true}));
  }
}
async function crossPage(c,width,port){
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  const {targetId}=await c.call('Target.createTarget',{url:ORIGIN+'/read/sample',background:true});
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json')).json();const target=targets.find(t=>t.id===targetId);assert(target,'Cross-page target');
  const peer=new Cdp(target.webSocketDebuggerUrl);
  try{
    await peer.call('Runtime.enable');await wait(peer,"document.readyState==='complete'&&!!document.querySelector('.reader-body')");
    for(const [key,value,expected]of [[APPEARANCE,'light','moon-white'],[KEY,'eye-green','eye-green'],[APPEARANCE,'dark','dark']]){
      await evaluate(peer,(key,value)=>localStorage.setItem(key,value),key,value);await wait(c,'document.documentElement.dataset.theme==='+JSON.stringify(expected));extraChecks++;
    }
    await peer.evaluate('localStorage.clear()');await wait(c,"document.documentElement.dataset.theme==='parchment'");extraChecks++;
  }finally{peer.close();await c.call('Target.closeTarget',{targetId});await c.call('Page.bringToFront');}
  console.log(JSON.stringify({width,crossPage:true,clear:true}));
}

// 2c only: compare each frame interval against the same interval's panel growth.
function installTheme2c(){
  const snapshot=()=>{
    const viewport=window.visualViewport,left=viewport?.offsetLeft??0,top=viewport?.offsetTop??0;
    const right=left+(viewport?.width??innerWidth),bottom=Math.min(top+(viewport?.height??innerHeight),document.querySelector('.reader-typography-sheet')?.getBoundingClientRect().top??Infinity);
    const panels=[...document.querySelectorAll('.gloss-panel')].map(el=>{const r=el.getBoundingClientRect();return{index:el.dataset.sentenceIndex,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};});
    const glyphs=window.__g19.glyphs().filter(g=>{if(!g.char.trim())return false;const r=window.__g19.rect(g.key);return r.y>=top&&r.bottom<=bottom&&r.x>=left&&r.x+r.width<=right;});
    const clicked=[...document.querySelectorAll('.reader-body .sentence[data-index="6"]')].flatMap(el=>[...el.getClientRects()].map(r=>({top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height})));
    return{time:performance.now(),glyphs,clicked,panels,scrollY,open:innerWidth<768?!!document.querySelector('.reader-typography-sheet'):document.querySelector('.settings-typography-toggle').getAttribute('aria-expanded')==='true'};
  };
  const compare=(before,after)=>{
    const p=before.panels.find(p=>p.index==='6'),q=after.panels.find(p=>p.index==='6');
    if(!p||!q)throw Error('2c white panel missing');
    const dh=q.height-p.height,rows=[];
    for(const g of before.glyphs){
      const group=g.bottom<=p.top?'A':g.y>=p.bottom?'B':null;if(!group)continue;
      const now=window.__g19.rect(g.key),dx=now.x-g.x,dy=now.y-g.y,error=group==='A'?dy:dy-dh;
      rows.push({group,key:g.key,index:g.index,dx,dy,dh,error,passed:Math.abs(dx)<1&&Math.abs(error)<1});
    }
    return{before,after,dh,rows};
  };
  const state={snapshot,compare,frames:[],raf:null,stop:true};
  window.__theme2c=state;
  state.begin=()=>new Promise(resolve=>requestAnimationFrame(()=>{
    state.frames=[];state.stop=false;window.__g19.events=[];let previous=snapshot();state.initial=previous;
    const tick=()=>{state.raf=null;if(state.stop)return;const next=snapshot();state.frames.push(compare(previous,next));previous=next;state.raf=requestAnimationFrame(tick);};
    state.raf=requestAnimationFrame(tick);resolve(previous);
  }));
  state.end=()=>{state.stop=true;if(state.raf!==null)cancelAnimationFrame(state.raf);state.raf=null;
    const rows=state.frames.flatMap(f=>f.rows),a=rows.filter(r=>r.group==='A'),b=rows.filter(r=>r.group==='B');
    const failure=rows.find(r=>!r.passed),last=snapshot();
    return{frames:state.frames.length,A:{samples:a.length,maxDy:Math.max(0,...a.map(r=>Math.abs(r.dy))),maxDx:Math.max(0,...a.map(r=>Math.abs(r.dx)))},B:{samples:b.length,maxError:Math.max(0,...b.map(r=>Math.abs(r.error))),maxDx:Math.max(0,...b.map(r=>Math.abs(r.dx)))},failure,initial:state.initial,last,events:window.__g19.events,panels:last.panels.map(p=>p.index),open:last.open,hidden:document.hidden,frameDetails:failure?state.frames.filter(f=>f.rows.some(r=>!r.passed)):[]};
  };
}
async function ensureGroupA(c,width,label){
  let a=await c.evaluate("(()=>{const s=__theme2c.snapshot(),p=s.panels.find(p=>p.index==='6');return s.glyphs.filter(g=>g.bottom<=p.top).length})()");
  if(!a){
    await c.evaluate("(()=>{const g=__g19.glyphs().find(g=>g.index===6&&g.char.trim());window.scrollTo({top:scrollY+g.y-innerHeight*.35,behavior:'instant'})})()");await pause(300);
    a=await c.evaluate("(()=>{const s=__theme2c.snapshot(),p=s.panels.find(p=>p.index==='6');return s.glyphs.filter(g=>g.bottom<=p.top).length})()");
  }
  assert(a>0,'A 组为空 '+label,{width,label});return a;
}
async function measuredTheme2c(c,width,label,operation){
  await ensureGroupA(c,width,label);await c.evaluate('__theme2c.begin()');await operation();await settle(c);
  await c.evaluate('new Promise(resolve=>{let frames=0;const tick=()=>{if(++frames>=60)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick)})');
  const result=await c.evaluate('__theme2c.end()');console.log(JSON.stringify({width,scenario:'appearance-stream:'+label,...result}));
  assert(!result.hidden&&result.A.samples>0,'2c visible sampling '+label,result);
  if(result.failure)throw Error(result.failure.group+' 组位移 '+label+': '+JSON.stringify(result.failure));
  return result;
}
async function negativeTheme2c(c,width,group){
  if(width>=768)await appearance(c,width,group==='A'?'light':'dark');
  const label='appearance-stream:negative-'+group;await ensureGroupA(c,width,label);
  const result=await evaluate(c,group=>new Promise(resolve=>requestAnimationFrame(()=>{
    const before=__theme2c.snapshot(),clicked=document.querySelector('.sentence[data-index="6"]').closest('.reader-paragraph');
    const paragraph=group==='A'?clicked.previousElementSibling:clicked.nextElementSibling;
    if(!paragraph?.classList.contains('reader-paragraph'))throw Error('Negative paragraph missing '+group);
    const targetKeys=before.glyphs.filter(g=>paragraph.contains(document.querySelector(`.sentence[data-index="${g.index}"]`))).map(g=>g.key);
    if(group==='B'&&!targetKeys.length)throw Error('Negative B paragraph has no visible glyph');
    const old=paragraph.style.marginTop;
    if(innerWidth<768)document.querySelector(`.reader-typography-sheet [data-reader-appearance="${group==='A'?'dark':'light'}"]`).click();else document.querySelector('.reader-appearance-cycle').click();
    paragraph.style.marginTop=(parseFloat(getComputedStyle(paragraph).marginTop)+10)+'px';const after=__theme2c.snapshot(),comparison=__theme2c.compare(before,after);
    paragraph.style.marginTop=old;
    const failure=comparison.rows.find(r=>r.group===group&&!r.passed);
    resolve({label:'appearance-stream:negative-'+group,group,failure,dh:comparison.dh,beforePanels:before.panels,afterPanels:after.panels});
  })),group);
  const detected=result.failure?group+' 组位移':null;
  console.log(JSON.stringify({width,negative2c:{...result,detected}}));
  assert(detected===group+' 组位移','2c negative control must name '+group,result);
}

async function streaming(c,width){
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);await ownedShelfCheck(c,width);
  await evaluate(c,()=>{const doc=JSON.parse(localStorage.getItem('gloss:doc:g19-owned'));doc.docId='g19-stream';doc.paragraphs=['上方原文。'.repeat(6),'被点原句。','下方正文。'.repeat(5),'后续正文。'.repeat(3)];doc.meta.charCount=doc.paragraphs.join('').length;localStorage.setItem('gloss:doc:g19-stream',JSON.stringify(doc));localStorage.setItem('gloss:structure:g19-stream',localStorage.getItem('gloss:structure:g19-owned'));localStorage.setItem('gloss:settings:appearance','light');});
  const {identifier}=await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`const originalFetch=window.fetch;window.fetch=async function(input,options){if(new URL(String(input),location.href).pathname==='/api/gloss'){window.__streamCount=0;return new Response(new ReadableStream({start(controller){window.__streamClose=()=>controller.close();function send(){if(window.__streamStopped)return;controller.enqueue(new TextEncoder().encode('白'));window.__streamCount++;if(window.__streamCount<140)setTimeout(send,250);else controller.close()}send()}}),{status:200})}return originalFetch.call(this,input,options)};`});
  await c.call('Page.navigate',{url:ORIGIN+'/read/g19-stream'});await ready(c);await open(c,6);await revealControls(c,width);await align(c,8);await c.evaluate(`(${installTheme2c.toString()})()`);
  const actions=[['appearance:system',()=>appearance(c,width,'system')],['appearance:dark',()=>appearance(c,width,'dark')],['appearance:light',()=>appearance(c,width,'light')],...LIGHT_THEMES.map(t=>['paper:'+t,()=>choose(c,width,t)]),['appearance:system-again',()=>appearance(c,width,'system')],...['dark','light'].map(system=>['system:'+system,async()=>{await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:system}]});await settle(c);}])];
  for(const [label,operation]of actions){
    const before=await c.evaluate("({chunks:__streamCount,panels:[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex),busy:!!document.querySelector('.gloss-panel[data-state=busy]')})");assert(before.busy,'Streaming precondition '+label,before);
    const result=await measuredTheme2c(c,width,label,operation);
    const after=await c.evaluate("({chunks:__streamCount,busy:!!document.querySelector('.gloss-panel[data-state=busy]'),open:innerWidth<768?!!document.querySelector('.reader-typography-sheet'):document.querySelector('.settings-typography-toggle').getAttribute('aria-expanded')==='true'})");
    assert(!result.failure&&result.events.length===0&&JSON.stringify(result.panels)===JSON.stringify(before.panels)&&after.open&&after.busy&&after.chunks>before.chunks,'Streaming theme invariant',{label,before,after,result});extraChecks++;
  }
  if(width===1280){await negativeTheme2c(c,width,'A');await negativeTheme2c(c,width,'B');}
  await c.evaluate('window.__streamStopped=true;window.__streamClose()');await c.call('Page.removeScriptToEvaluateOnNewDocument',{identifier});console.log(JSON.stringify({width,streamingSwitches:actions.length,passed:true}));
}
async function extended(c,width,port){
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'},{name:'prefers-reduced-motion',value:'no-preference'}]});
  for(const theme of THEMES)await surfaceChecks(c,width,theme);
  await coldAppearance(c,width);await crossPage(c,width,port);await streaming(c,width);
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);await prepare(c,width);await appearance(c,width,'dark');
  await c.evaluate("const style=document.createElement('style');style.textContent='[data-theme=dark]{--hover:#1F4E75!important}';document.head.append(style)");await settle(c);
  let detected=null;try{await hover(c,width,'dark','dark');}catch(e){detected=e.message;}
  originalChecks--;assert(detected?.includes('Hover target token'),'Dark --hover negative control must name hover',detected);console.log(JSON.stringify({width,darkHoverNegative:detected}));
}


async function screenshotSet(c,width){
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:width===375?812:900,deviceScaleFactor:1,mobile:false});
  await c.evaluate("localStorage.clear();localStorage.setItem('gloss:settings:appearance','dark')");
  const dir=join(ROOT,'tmp-g19c-shots');await mkdir(dir,{recursive:true});
  const shot=async page=>{await settle(c);assert(await c.evaluate("document.documentElement.dataset.theme==='dark'"),'Screenshot theme');const {data}=await c.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const path=join(dir,`${page}-${width}x${width===375?812:900}-dark.png`);await writeFile(path,Buffer.from(data,'base64'));console.log(JSON.stringify({screenshot:path}));};
  await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(c,"!!document.querySelector('.landing-page')");await shot('landing');
  await c.evaluate("document.querySelector('.landing-secondary').click()");await wait(c,"!!document.querySelector('.import-panel')");await shot('import');
  await c.evaluate("document.querySelector('.import-close').click()");
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);await prepare(c,width);
  await c.call('Page.navigate',{url:ORIGIN+'/'});await wait(c,"!!document.querySelector('.shelf-page')");await shot('shelf');
  await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
  await evaluate(c,()=>{
    const real=window.fetch;
    window.fetch=async function(input,options){
      if(new URL(String(input),location.href).pathname==='/api/explain'){
        const records=[{type:'sentence',text:'这是本地截图替身的整句理解。'},{type:'done'}];
        return new Response(records.map(record=>JSON.stringify(record)).join('\n')+'\n',{status:200});
      }
      return real.call(this,input,options);
    };
  });
  await open(c,5);await wait(c,"!!document.querySelector('.gloss-panel[data-sentence-index=\"5\"] .action-row-explain[aria-disabled=\"false\"]')");
  await c.evaluate("document.querySelector('.gloss-panel[data-sentence-index=\"5\"] .action-row-explain').click()");await wait(c,"!!document.querySelector('.explain-result-text')");await shot('reader-explained');
  await c.evaluate("window.scrollTo({top:0,behavior:'instant'});document.querySelector('.feedback-button').click()");await wait(c,"!!document.querySelector('.feedback-card')");await shot('feedback');
}
async function geometry(c){
  const base=process.env.G19_THEME_BASE_ORIGIN??'http://localhost:3473';
  await c.call('Emulation.setDeviceMetricsOverride',{width:1024,height:900,deviceScaleFactor:1,mobile:false});
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  for(const theme of LIGHT_THEMES){
    const snapshots=[];
    for(const origin of [ORIGIN,base]){
      await c.call('Page.navigate',{url:origin+'/read/sample'});await ready(c);
      await evaluate(c,theme=>{localStorage.clear();localStorage.setItem('gloss:settings:theme',theme);localStorage.setItem('gloss:settings:appearance','light');},theme);
      await c.call('Page.reload');await ready(c);await c.evaluate('document.fonts.ready');await settle(c);
      const rows=await evaluate(c,()=>{const main=document.querySelector('.col-center')??document.querySelector('.col-main');if(!main)throw Error('Missing center column');return [...document.querySelectorAll(`${main.classList.contains('col-center')?'.col-center':'.col-main'}, ${main.classList.contains('col-center')?'.col-center':'.col-main'} *, .col-left, .col-left *`)].filter(el=>getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0).map(el=>{const r=el.getBoundingClientRect();return{tag:el.tagName,className:el.className,x:r.x,y:r.y,width:r.width,height:r.height};});});
      snapshots.push({origin,count:rows.length,hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),rows});
    }
    assert(snapshots[0].hash===snapshots[1].hash,'Light geometry differs from main',{theme,snapshots});console.log(JSON.stringify({theme,geometry:snapshots.map(({rows,...s})=>s),actualCenterSelector:'.col-main',passed:true}));
  }
}

async function run(width){
  async function singlePage(port,where){const pages=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page');if(pages.length!==1)throw Error('Only 1 page: '+where+' '+JSON.stringify(pages.map(t=>t.url)));}
  const profile=await mkdtemp(join(tmpdir(),'gloss-g19-theme-')),port=await freePort();
  const edge=spawn(EDGE,['--headless=new','--disable-sync','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
  let c;const api=[],warnings=[];
  try{
    let target;for(let i=0;i<200;i++){try{target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');if(target)break;}catch{}await pause(100);}assert(target,'Edge startup');
    await singlePage(port,'start');
    c=new Cdp(target.webSocketDebuggerUrl);c.socket.on('message',data=>{const m=JSON.parse(data);
      if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))api.push(m.params.request.url);
      if(m.method==='Runtime.consoleAPICalled'||m.method==='Runtime.exceptionThrown'||m.method==='Log.entryAdded')if(/hydrat|didn't match|server rendered|Minified React error #(418|419|421|422|423|424|425)/i.test(JSON.stringify(m.params)))warnings.push(m.params);});
    await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Log.enable');
    // Page.reload can return while the old reader still satisfies ready(). Wait for the new document before any rAF promise.
    const rawCall=c.call.bind(c);
    c.call=async(method,params={})=>{
      if(method!=='Page.navigate'&&method!=='Page.reload'){
        try{return await rawCall(method,params);}catch(e){throw Error(method+' '+String(params.expression??'').slice(0,100)+' : '+e.message);}
      }
      let handler,timer;
      const loaded=new Promise((resolve,reject)=>{handler=data=>{if(JSON.parse(data).method==='Page.domContentEventFired')resolve();};c.socket.on('message',handler);timer=setTimeout(()=>reject(Error('Navigation DOMContentLoaded timeout')),20000);});
      try{const result=await rawCall(method,params);await loaded;await rawCall('Page.bringToFront');return result;}finally{clearTimeout(timer);c.socket.off('message',handler);}
    };
    await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
    await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${setup.toString()})();window.__themeFirstPaint=[];window.__themePaintEvents=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__themePaintEvents.push({name:e.name,time:e.startTime,theme:document.documentElement.dataset.theme})}).observe({type:'paint',buffered:true});function sample(t){const el=document.querySelector('.col-main');if(el){const b=getComputedStyle(el).backgroundColor;if(b!=='rgba(0, 0, 0, 0)')window.__themeFirstPaint.push({time:t,theme:document.documentElement.dataset.theme,background:b})}if(window.__themeFirstPaint.length<120)requestAnimationFrame(sample)}requestAnimationFrame(sample);`});
    await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
    if(process.env.G19_THEME_ARTIFACTS==='1'){await screenshotSet(c,width);if(width===1280)await geometry(c);}
    else if(process.env.G19_THEME_COLD_ONLY==='1'){
      for(const value of ['moon-white','', 'unknown', '{',null])await cold(c,width,value);
    }else if(process.env.G19_THEME_LANDING_ONLY==='1'){
      for(const [from,to]of DIRECTIONS){await prepare(c,width);await choose(c,width,from);await choose(c,width,to);await pages(c,width,from,to);}
    }else if(process.env.G19_THEME_NEGATIVE==='1'){
      await prepare(c,width);await choose(c,width,'moon-white');
      const removed=await c.evaluate("(()=>{let n=0;for(const sheet of document.styleSheets){let rules;try{rules=sheet.cssRules}catch{continue}for(const rule of rules)if(rule.selectorText?.includes('moon-white')&&rule.style.getPropertyValue('--term')){rule.style.removeProperty('--term');n++}}return n})()");assert(removed>0,'Negative control did not remove definition');await settle(c);
      let detected=null;try{await colors(c,'moon-white','parchment','reader',width);}catch(e){detected=e.message;}
      assert(detected?.includes('术语'),'Negative control did not name term',detected);console.log(JSON.stringify({width,negativeControl:{removedDefinitions:removed,detected}}));
    }else{
      for(const value of ['moon-white','', 'unknown', '{',null])await cold(c,width,value);
      for(const [from,to]of DIRECTIONS){
        await prepare(c,width);await choose(c,width,from);
        const before=await c.evaluate("[...document.querySelectorAll('.gloss-panel')].map(p=>p.dataset.sentenceIndex)");
        await c.evaluate("window.__themeSwitchColors=[];window.__themeColorSampling=true;function sampleColors(){if(!window.__themeColorSampling)return;window.__themeSwitchColors.push(getComputedStyle(document.documentElement).getPropertyValue('--paper-main').trim());requestAnimationFrame(sampleColors)}requestAnimationFrame(sampleColors)");
        await singlePage(port,'theme:'+from+'>'+to);
        const sample=await measured(c,width,'theme:'+from+'>'+to,()=>choose(c,width,to));
        const transitionColors=await c.evaluate("window.__themeColorSampling=false;[...new Set(window.__themeSwitchColors)]");
        assert(transitionColors.length>2,'No intermediate transition colors',transitionColors);console.log(JSON.stringify({width,direction:from+'>'+to,transitionColors}));
        assert(sample.events.length===0,'Theme generated reading events',sample.events);
        assert(JSON.stringify(sample.panels)===JSON.stringify(before),'Theme collapsed gloss',{before,after:sample.panels});
        await colors(c,to,from,'reader',width);await hover(c,width,to,from);
        const duration=await c.evaluate('getComputedStyle(document.documentElement).transitionDuration');assert(duration==='0.18s','Missing switch transition',duration);
        if(width<768)assert(await c.evaluate("document.querySelector('.reader-typography-sheet').getBoundingClientRect().height<=450"),'Mobile theme sheet exceeds half');
        await c.evaluate("document.querySelector(`${innerWidth<768?'.reader-typography-sheet':'.reader-typography-popover'} .reader-typography-reset`).click()");await settle(c);
        assert(await c.evaluate('document.documentElement.dataset.theme')===to,'Typography reset changed theme');
        console.log(JSON.stringify({width,checkpoint:'page-colors',direction:from+'>'+to}));await pages(c,width,from,to);
      }
      console.log(JSON.stringify({width,checkpoint:'refresh-and-other-book'}));await prepare(c,width);await choose(c,width,'eye-green');await c.call('Page.reload');await ready(c);assert(await c.evaluate('document.documentElement.dataset.theme')==='eye-green','Refresh lost theme');
      await c.call('Page.navigate',{url:ORIGIN+'/read/g19-owned'});await ready(c);assert(await c.evaluate('document.documentElement.dataset.theme')==='eye-green','Other book lost theme');
      await revealControls(c,width);await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await choose(c,width,'moon-white');
      const reduced=await c.evaluate("({root:getComputedStyle(document.documentElement).transitionDuration,sentence:getComputedStyle(document.querySelector('.sentence')).transitionDuration})");assert(reduced.root==='0s'&&reduced.sentence==='0s','Reduced motion transition',reduced);
      console.log(JSON.stringify({width,refresh:true,otherBook:true,reducedMotionTransition:reduced}));
    }
    if(!process.env.G19_THEME_ARTIFACTS&&!process.env.G19_THEME_COLD_ONLY&&!process.env.G19_THEME_LANDING_ONLY&&!process.env.G19_THEME_NEGATIVE)await extended(c,width,port);
    assert(warnings.length===0,'Hydration warnings',warnings);assert(api.length===0,'Browser /api/ requests',api);await singlePage(port,'end');console.log(JSON.stringify({width,apiRequests:api.length,hydrationWarnings:warnings.length,passed:true}));
  }catch(e){console.log(JSON.stringify({width,stopped:true,error:e.message,apiRequests:api.length,warnings}));throw e;}
  finally{c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),pause(5000)]);assert(resolve(profile).startsWith(resolve(tmpdir(),'gloss-g19-theme-')),'Unsafe profile');await rm(profile,{recursive:true,force:true});}
}
if(process.env.G19_THEME_NEGATIVE==='1')await run(1280);else for(const w of WIDTHS)await run(w);
if(!process.env.G19_THEME_ARTIFACTS&&!process.env.G19_THEME_COLD_ONLY&&!process.env.G19_THEME_LANDING_ONLY&&!process.env.G19_THEME_NEGATIVE)assert(originalChecks===774,'Original 774 light checks',{originalChecks});
console.log(JSON.stringify({originalChecks,extraChecks}));
console.log('G-19 theme checks passed');
