/** Invalid-key production service. All color expectations come from the target theme block. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const ORIGIN=process.env.G19_THEME_ORIGIN??'http://localhost:3472';
process.env.G19_IMPORT_ONLY='1';process.env.G19_ORIGIN=ORIGIN;
const {Cdp,setup,ready,freePort,settle,revealControls,align,open,save,evaluate,ownedShelfCheck,measured}=await import('./verify-g19.mjs');
const ROOT=resolve(import.meta.dirname,'..'), KEY='gloss:settings:theme';
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const THEMES=['parchment','moon-white','eye-green'];
const DIRECTIONS=[['parchment','moon-white'],['moon-white','eye-green'],['eye-green','parchment'],['parchment','eye-green'],['eye-green','moon-white'],['moon-white','parchment']];
const WIDTHS=(process.env.G19_THEME_WIDTHS??'375,506,768,1024,1280').split(',').map(Number);
const CSS=await readFile(join(ROOT,'styles/tokens.css'),'utf8');
const TOKENS=Object.fromEntries(THEMES.map(t=>{const p=CSS.indexOf(`[data-theme="${t}"]`),b=CSS.slice(p,CSS.indexOf('}',p));return[t,Object.fromEntries([...b.matchAll(/(--[\w-]+):\s*(#[\da-fA-F]{6})/g)].map(m=>[m[1],m[2]]))];}));
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
      check('分隔线','.col-right','borderLeftColor','--rule');check('设置面板','.settings-skeleton li','color','--gloss');
      check('主题控件','.reader-theme-options','color','--ink');check('反馈按钮底色','.feedback-button','backgroundColor','--ink');
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
  assert(result.every(r=>r.passed),'Target token mismatch',result.filter(r=>!r.passed));return result;
}
async function hover(c,width,theme,from){
  const r=await c.evaluate('window.__g19.reference()');await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+1,y:r.y+1});await settle(c);
  const actual=await c.evaluate("getComputedStyle(document.querySelector('.sentence-hover')).color");
  const hex=TOKENS[theme]['--hover'],expected=`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
  assert(actual===expected,'Hover target token',{actual,expected});console.log(JSON.stringify({width,direction:from+'>'+theme,element:'悬停文字',actual,expected,passed:true}));
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
  console.log(JSON.stringify({width,direction:from+'>'+theme,element:'书架层板五项',...result}));assert(result.passed,'Ledge target tokens',result);
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
  const expected=THEMES.includes(value)?value:'parchment';
  const record=await c.evaluate('({frames:window.__themeFirstPaint,theme:document.documentElement.dataset.theme,transition:getComputedStyle(document.documentElement).transitionDuration,paints:window.__themePaintEvents})');
  const hex=TOKENS[expected]['--paper-main'],rgb=`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
  assert(record.theme===expected&&record.frames.length>0&&record.frames.every(f=>f.theme===expected&&f.background===rgb),'Cold start flash',record);
  assert(record.transition==='0s','Initial transition enabled',record);console.log(JSON.stringify({width,coldStoredValue:value,expected,firstFrame:record.frames[0],sampledFrames:record.frames.length,paints:record.paints,transition:record.transition,passed:true}));
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
    await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${setup.toString()})();window.__themeFirstPaint=[];window.__themePaintEvents=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__themePaintEvents.push({name:e.name,time:e.startTime,theme:document.documentElement.dataset.theme})}).observe({type:'paint',buffered:true});function sample(t){const el=document.querySelector('.col-main');if(el){const b=getComputedStyle(el).backgroundColor;if(b!=='rgba(0, 0, 0, 0)')window.__themeFirstPaint.push({time:t,theme:document.documentElement.dataset.theme,background:b})}if(window.__themeFirstPaint.length<120)requestAnimationFrame(sample)}requestAnimationFrame(sample);`});
    await c.call('Page.navigate',{url:ORIGIN+'/read/sample'});await ready(c);
    if(process.env.G19_THEME_COLD_ONLY==='1'){
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
        await c.evaluate("document.querySelector(`${innerWidth<768?'.reader-typography-sheet':'.col-right'} .reader-typography-reset`).click()");await settle(c);
        assert(await c.evaluate('document.documentElement.dataset.theme')===to,'Typography reset changed theme');
        console.log(JSON.stringify({width,checkpoint:'page-colors',direction:from+'>'+to}));await pages(c,width,from,to);
      }
      console.log(JSON.stringify({width,checkpoint:'refresh-and-other-book'}));await prepare(c,width);await choose(c,width,'eye-green');await c.call('Page.reload');await ready(c);assert(await c.evaluate('document.documentElement.dataset.theme')==='eye-green','Refresh lost theme');
      await c.call('Page.navigate',{url:ORIGIN+'/read/g19-owned'});await ready(c);assert(await c.evaluate('document.documentElement.dataset.theme')==='eye-green','Other book lost theme');
      await revealControls(c,width);await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await choose(c,width,'moon-white');
      const reduced=await c.evaluate("({root:getComputedStyle(document.documentElement).transitionDuration,sentence:getComputedStyle(document.querySelector('.sentence')).transitionDuration})");assert(reduced.root==='0s'&&reduced.sentence==='0s','Reduced motion transition',reduced);
      console.log(JSON.stringify({width,refresh:true,otherBook:true,reducedMotionTransition:reduced}));
    }
    assert(warnings.length===0,'Hydration warnings',warnings);assert(api.length===0,'Browser /api/ requests',api);await singlePage(port,'end');console.log(JSON.stringify({width,apiRequests:api.length,hydrationWarnings:warnings.length,passed:true}));
  }catch(e){console.log(JSON.stringify({width,stopped:true,error:e.message,apiRequests:api.length,warnings}));throw e;}
  finally{c?.close();edge.kill();if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),pause(5000)]);assert(resolve(profile).startsWith(resolve(tmpdir(),'gloss-g19-theme-')),'Unsafe profile');await rm(profile,{recursive:true,force:true});}
}
if(process.env.G19_THEME_NEGATIVE==='1')await run(1280);else for(const w of WIDTHS)await run(w);
console.log('G-19 theme checks passed');
