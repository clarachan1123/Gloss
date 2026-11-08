import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.G19_IMPORT_ONLY='1';
const {Cdp,evaluate}=await import('./verify-g19.mjs');
export function whiteBlockFacts() {
  return [...document.querySelectorAll(".gloss-panel-text")].filter(el=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility==="visible";
  }).map((el,ordinal)=>{
    const rect=el.getBoundingClientRect(),style=getComputedStyle(el),panel=el.closest(".gloss-panel"),block=el.closest(".gloss-block");
    const row=block?.querySelector(".action-row"),rail=row?.getBoundingClientRect(),reserve=block?parseFloat(getComputedStyle(block).paddingRight):0;
    const chars=[],walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){const node=walker.currentNode;let offset=0;for(const char of node.data){const range=document.createRange();range.setStart(node,offset);offset+=char.length;range.setEnd(node,offset);const r=range.getBoundingClientRect();chars.push({char,x:r.x-rect.x,y:r.y-rect.y,w:r.width,h:r.height});}}
    const buttons=[...(row?.querySelectorAll("button")??[])].map(b=>{const r=b.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};});
    const overlap=buttons.some((a,i)=>buttons.some((b,j)=>i!==j&&Math.min(a.right,b.right)>Math.max(a.x,b.x)&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)));
    let bubble=null;
    if(panel?.classList.contains("gloss-panel-bubble")){
      const parent=panel.parentElement,ps=getComputedStyle(parent),pr=parent.getBoundingClientRect();
      const available=pr.width-["paddingLeft","paddingRight","borderLeftWidth","borderRightWidth"].reduce((sum,key)=>sum+parseFloat(ps[key]),0);
      // 在同级隐藏副本测内容自然外框；覆盖副本的宽度，避免把候选外框误差当成所需宽度。
      const probe=panel.cloneNode(true);probe.setAttribute("aria-hidden","true");probe.removeAttribute("id");
      for(const [key,value] of Object.entries({position:"fixed",left:"0px",top:"0px",right:"auto",bottom:"auto",visibility:"hidden","pointer-events":"none",width:"max-content","min-width":"0px","max-width":"none",transform:"none",transition:"none",animation:"none"}))probe.style.setProperty(key,value,"important");
      const r=panel.getBoundingClientRect();
      let natural,overflow;
      try{
        parent.append(probe);
        natural=probe.getBoundingClientRect().width;
        // 正文外控件由位置断言独立验收，不计入气泡内容的滚动宽度。
        probe.querySelectorAll(".action-row").forEach(row=>row.remove());
        probe.style.setProperty("width",r.width+"px","important");
        overflow=probe.scrollWidth>probe.clientWidth;
      }finally{probe.remove();}
      bubble={outer:r.width,available,natural,hasExplain:!!panel.querySelector(".explain-result"),overflow};
    }
    return {key:(panel?.dataset.sentenceIndex??panel?.dataset.selectionId??"demo")+":"+ordinal,text:el.textContent,width:rect.width,height:rect.height,fonts:{fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,color:style.color},chars,railWidth:rail?.width??0,gap:reserve-(rail?.width??0),reserve,blockWidth:block?.getBoundingClientRect().width??null,bubble,blockPadding:block?[getComputedStyle(block).paddingTop,getComputedStyle(block).paddingBottom]:null,overflow:el.scrollWidth>el.clientWidth,overlap:overlap||(innerWidth>=1000&&!!rail&&rail.left<rect.right&&rail.bottom>rect.top&&rail.top<rect.bottom),buttons};
  });
}
export function whiteLineBreaks(chars){
  return chars.flatMap((char,index)=>index===chars.length-1||chars[index+1].y!==char.y?[index+1]:[]);
}
export function assertWhiteBlocks(base,actual,width) {
  const check=(v,label,detail)=>{if(!v)throw Error("G76白话"+label+": "+JSON.stringify(detail));};
  check(base.length===actual.length,"取样数量",{base:base.length,actual:actual.length,width});
  for(let i=0;i<base.length;i++){
    const b=base[i],a=actual[i];check(a.blockPadding?.every(value=>value==="0px"),"白话块上下不增留白",a.blockPadding);check(b.key===a.key&&b.text===a.text,"同句同文",{base:b.key,actual:a.key});
    for(const property of ["fontFamily","fontSize","lineHeight","color"])check(a.fonts[property]===b.fonts[property],"字体属性",{width,key:a.key,property,base:b.fonts[property],actual:a.fonts[property]});
    const shortBubble=b.bubble&&b.bubble.outer<b.bubble.available;
    if(shortBubble){
      check(!!a.bubble,"短气泡形态保持",a.key);
      check(JSON.stringify(whiteLineBreaks(a.chars))===JSON.stringify(whiteLineBreaks(b.chars)),"短气泡白话逐行断点",{width,base:whiteLineBreaks(b.chars),actual:whiteLineBreaks(a.chars)});
      check(a.bubble.available===b.bubble.available,"短气泡可用宽度保持",{base:b.bubble.available,actual:a.bubble.available});
      check(a.bubble.outer<=a.bubble.available,"气泡不超过可用宽度",a.bubble);
      const expected=Math.min(a.bubble.available,Math.max(b.bubble.outer,a.bubble.natural));
      check(Number.isFinite(expected)&&Math.abs(a.bubble.outer-expected)<=.5,"短气泡外框按内容实测",{width,base:b.bubble.outer,actual:a.bubble.outer,natural:a.bubble.natural,expected});
      check(a.width===a.blockWidth-a.reserve,"短气泡白话宽度与控件留位一致",a);
      check(!a.bubble.overflow,"短气泡外框无溢出",a.bubble);
    }else {
      check(a.width===b.width,"白话宽度严格相等",{width,base:b.width,actual:a.width});
      check(JSON.stringify(a.chars)===JSON.stringify(b.chars),"白话换行严格相等",{width,key:a.key});
    }
    check(!a.overflow&&!a.overlap,"无溢出无重叠",{width,key:a.key,overflow:a.overflow,overlap:a.overlap});
  }
}
export function whiteBlockNegatives(base,actual,width) {
  assertWhiteBlocks(base,actual,width);if(!actual.length)return 0;let count=0;
  const faults=[a=>a.blockPadding[0]="1px",a=>a.width+=1,a=>a.fonts.fontFamily="错误字体",a=>a.fonts.fontSize="1px",a=>a.fonts.lineHeight="1px",a=>a.fonts.color="rgb(1, 2, 3)",a=>a.overflow=true,a=>a.overlap=true];
  if(base[0].bubble&&base[0].bubble.outer<base[0].bubble.available){
    faults.push(a=>a.chars[0].y+=1,a=>a.bubble.outer=a.bubble.available+1,a=>a.bubble.outer+=1);
  }else faults.push(a=>a.chars[0].y+=1);
  for(const mutate of faults){const changed=structuredClone(actual);mutate(changed[0]);let detected=false;try{assertWhiteBlocks(base,changed,width);}catch{detected=true;}if(!detected)throw Error("白话验收负对照漏检");count++;}
  return count;
}
export function g76UIFacts(){
 const css=el=>getComputedStyle(el),rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
 const token=name=>{const value=css(document.documentElement).getPropertyValue(name).trim();if(/^rgb\(\d+, \d+, \d+\)$/.test(value))return value;if(!/^#[0-9a-f]{6}$/i.test(value))throw Error("取色 token 格式不符 "+name);return "rgb("+[1,3,5].map(start=>parseInt(value.slice(start,start+2),16)).join(", ")+")";};
 const controls=[...document.querySelectorAll(".gloss-block>.action-row,.explain-result>.action-row")].map(row=>{
  const buttons=[...row.querySelectorAll("button")];
  const body=row.closest(".reader-body"),main=body?.closest(".col-main"),style=css(row);
  const bodyRight=body?.getBoundingClientRect().right;
  const usableRight=main?main.getBoundingClientRect().right-8:bodyRight;
  const surface=row.parentElement.querySelector(":scope > .explain-surface");
  const block=surface??row.parentElement;
  return {bodyRight,usableRight,gap:usableRight-bodyRight,mode:row.dataset.actionPlacement,
    display:style.display,columns:style.gridTemplateColumns,columnGap:style.columnGap,margin:style.marginTop,
    blockTop:block.getBoundingClientRect().top,blockRight:block.getBoundingClientRect().right,
    inline:block.closest(".gloss-panel")?.classList.contains("gloss-panel-inline"),
    bodyWidth:body?.getBoundingClientRect().width,blockWidth:block.getBoundingClientRect().width,
    inset:css(block).paddingLeft,blockFont:css(block).fontSize,blockBorder:css(block).borderLeftWidth,
    surface:!!surface,position:css(row).position,recall:!!row.querySelector(".action-row-recall"),buttons:buttons.map(b=>({label:b.getAttribute("aria-label"),saved:b.getAttribute("aria-pressed")==="true",color:css(b).color,border:css(b).borderTopWidth,radius:css(b).borderTopLeftRadius,font:css(b).fontSize,min:css(b).minWidth,padding:css(b).paddingLeft,margin:css(b).marginRight,icon:rect(b.querySelector("svg")),path:b.querySelector("path")?.getAttribute("d"),stroke:b.querySelector("svg")?.getAttribute("stroke-width"),cap:b.querySelector("svg")?.getAttribute("stroke-linecap"),join:b.querySelector("svg")?.getAttribute("stroke-linejoin"),...rect(b)})),gloss:token("--gloss"),hover:token("--hover"),box:rect(row)};
 });
 const explanations=[...document.querySelectorAll(".explain-surface")].map(el=>{const s=css(el),root=el.closest(".gloss-panel");return {size:parseFloat(s.fontSize),white:parseFloat(css(root).fontSize),font:s.fontFamily,whiteFont:css(root).fontFamily,line:parseFloat(s.lineHeight),color:s.color,body:token("--text-body"),background:s.backgroundColor,side:token("--paper-side"),padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],border:s.borderTopWidth,radius:s.borderTopLeftRadius,bubble:root.classList.contains("gloss-panel-bubble")};});
 const names=[".reader-shelf-back",".reader-mobile-heading",".reader-selection-mobile",".reader-saved-mobile",".reader-typography-aa"];
 const header=innerWidth<768&&document.querySelector(".reader-mobile-heading")?{boxes:names.map(selector=>{const el=document.querySelector(selector);return el?{selector,...rect(el)}:null;}),fonts:[".reader-mobile-title",".reader-mobile-progress",".reader-shelf-back",".reader-selection-mobile",".reader-typography-aa"].map(selector=>{const el=document.querySelector(selector),s=css(el);return {selector,font:s.fontFamily,size:s.fontSize,line:s.lineHeight,color:s.color};})}:null;
 const modeFonts=[...document.querySelectorAll(".mode-label")].map(el=>{const s=css(el);return {font:s.fontFamily,size:s.fontSize,line:s.lineHeight,color:s.color};});
 const savedKinds=[...document.querySelectorAll(".saved-kind")].map(el=>({kind:el.dataset.kind,text:el.textContent,size:css(el).fontSize}));
 return {controls,explanations,header,modeFonts,savedKinds};
}
export function assertG76UI(base,actual,width){
 const check=(v,label,d)=>{if(!v)throw Error("G76控件"+label+": "+JSON.stringify(d));};
 for(const row of actual.controls){
  const side=row.gap>=164;
  const near=(a,b)=>Math.abs(a-b)<=.5;
  check(row.mode===(side?"side":"below")&&row.position===(side?"absolute":"relative"),"按实测空白选择位置",{width,row});
  if(row.inline&&row.bodyWidth!==undefined){
   check(near(row.blockWidth,row.bodyWidth),"行下块外框与正文等宽",row);
   if(!row.surface)check(row.blockBorder==="2px"&&near(parseFloat(row.inset),parseFloat(row.blockFont)),"白话2px竖线与1em内缩",row);
  }
  if(side){
   check(row.display==="grid"&&row.columns==="84px 28px 28px"&&row.columnGap==="4px"&&near(row.box.w,148)&&near(row.box.h,28),"右侧三格尺寸",row);
   check(row.box.x>=row.bodyRight&&near(row.box.x-row.bodyRight,16)&&row.box.right<=row.usableRight+.5,"控件在正文外且保留中栏右缘8px",row);
   check(near(row.box.y-row.blockTop,row.surface?12:0),"控件顶部对齐",row);
  }else{
   check(row.display==="flex"&&row.columnGap==="2px"&&row.margin==="2px"&&near(row.box.h,36),"下方操作行尺寸",row);
  }
  check(row.buttons.length===(row.recall?3:2),"三格或两控件",{width,row});
  for(const button of row.buttons){
   check(["收藏","取消收藏","收起白话","收起脉络解读","白话","脉络解读"].includes(button.label),"名称",button);
   check(button.color===(button.saved?row.hover:row.gloss),"主题颜色",button);
   const recall=button.label==="白话"||button.label==="脉络解读";
   const expectedPath=button.label==="白话"?"M5 6h14v9H10l-4 3v-3H5z":button.label==="脉络解读"?"M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z":button.label.startsWith("收起")?"M6 15l6-6 6 6":"M6 3h12v18l-6-4-6 4z";
   check(button.path===expectedPath&&button.stroke==="1.6"&&button.cap==="round"&&button.join==="round","图标原路径与描边",button);
   const icon=recall?14:side?16:18;
   check(near(button.icon.w,icon)&&near(button.icon.h,icon),"图标尺寸",button);
   check(near(button.h,side?28:recall?30:36)&&(!recall?near(button.w,side?28:36):!side||near(button.w,84)),"按钮尺寸",button);
   check(button.radius===(side?"4px":recall?"15px":"6px")&&button.border===(!side&&recall?"1px":"0px")&&button.padding===(!side&&recall?"10px":"0px")&&button.margin===(!side&&recall?"4px":"0px"),"按钮外观尺寸",button);
   check(side?(!recall||button.font==="12px"):button.font==="13px","按钮字号",button);
  }
  check(row.buttons.every((a,i)=>row.buttons.every((b,j)=>i===j||Math.min(a.right,b.right)<=Math.max(a.x,b.x)||Math.min(a.bottom,b.bottom)<=Math.max(a.y,b.y))),"按钮无重叠",row);
 }
 for(const e of actual.explanations){
  check(e.size===e.white+1&&e.font===e.whiteFont,"解读字号字体",e);
  check(Math.abs(e.line-e.size*1.95)<1e-6,"解读行高",e);
  check(e.color===e.body&&e.background===e.side,"解读主题色",e);
  check(JSON.stringify(e.padding)===JSON.stringify(["12px","18px","12px","18px"])&&e.border==="0px"&&(!e.bubble||e.radius==="4px"),"解读内边距与边框",e);
 }
 check(JSON.stringify(actual.modeFonts)===JSON.stringify(base.modeFonts),"收藏模式标签字体颜色保持",actual.modeFonts);
 for(const item of actual.savedKinds)check(["gloss","explain"].includes(item.kind)&&item.text===(item.kind==="gloss"?"白话":"脉络解读")&&item.size==="11px","收藏类型签",item);
 if(actual.header){
  check(!!base.header,"顶栏对照存在",actual.header);
  const boxes=actual.header.boxes;check(boxes.every(Boolean),"顶栏五项存在",actual.header);
  check(boxes[0].w===44&&boxes[3].w===44&&boxes[4].w===44,"顶栏命中尺寸",actual.header);
  check(boxes.every((a,i)=>i===0||a.x>=boxes[i-1].right),"顶栏无重叠",actual.header);
  check(JSON.stringify(actual.header.fonts)===JSON.stringify(base.header.fonts),"顶栏字体颜色保持",actual.header.fonts);
 }
}
export function g76UINegatives(base,actual,width){
 assertG76UI(base,actual,width);let count=0;
 const faults=[];
 if(actual.controls.length){faults.push(a=>a.controls[0].buttons[0].color="rgb(1, 2, 3)");faults.push(a=>a.controls[0].position="错误");faults.push(a=>a.controls[0].buttons[0].h+=1,a=>a.controls[0].buttons[0].path="M0 0",a=>a.controls[0].mode="side"===a.controls[0].mode?"below":"side");for(const row of actual.controls.filter(r=>r.mode==="side").slice(0,1)){const i=actual.controls.indexOf(row);faults.push(a=>a.controls[i].box.x=a.controls[i].bodyRight-1,a=>a.controls[i].box.right=a.controls[i].usableRight+1,a=>a.controls[i].columns="83px 28px 28px",a=>a.controls[i].gap=163);}}
 if(actual.explanations.length){faults.push(a=>a.explanations[0].size+=1);faults.push(a=>a.explanations[0].line+=1);faults.push(a=>a.explanations[0].padding[0]="15px");faults.push(a=>a.explanations[0].color="rgb(1, 2, 3)");}
 if(actual.header)faults.push(a=>a.header.boxes[3].w=43);
 if(actual.modeFonts.length)faults.push(a=>a.modeFonts[0].size="1px");
 if(actual.savedKinds.length)faults.push(a=>a.savedKinds[0].kind="错误");
 for(const mutate of faults){const changed=structuredClone(actual);mutate(changed);let detected=false;try{assertG76UI(base,changed,width);}catch{detected=true;}if(!detected)throw Error("控件适配负对照漏检");count++;}
 return count;
}
if(process.env.G76_IMPORT_ONLY!=='1'){
const profile=await mkdtemp(join(tmpdir(),'gloss-g76-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=9512','--remote-allow-origins=*','about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let c,checks=0,negative=0;
const assert=(v,label)=>{if(!v)throw Error(label);checks++;};
async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('等待失败 '+label);}
const ev=(fn,...args)=>evaluate(c,fn,...args);
// 等待新文档提交，不能把导航前旧页面的 readyState 当成本轮准备完成。
async function navigate(url){const previous=(await c.call('Page.getFrameTree')).frameTree.frame.loaderId;const result=await c.call('Page.navigate',{url});if(result.errorText)throw Error(result.errorText);await wait(async()=>{const frame=(await c.call('Page.getFrameTree')).frameTree.frame;if(result.loaderId?frame.loaderId!==result.loaderId:frame.loaderId===previous)return false;return c.evaluate("document.readyState==='complete'").catch(()=>false);},'新导航完成');}
async function reload(){const previous=(await c.call('Page.getFrameTree')).frameTree.frame.loaderId;await c.call('Page.reload');await wait(async()=>{const frame=(await c.call('Page.getFrameTree')).frameTree.frame;if(frame.loaderId===previous)return false;return c.evaluate("document.readyState==='complete'").catch(()=>false);},'新重载完成');}

const originPoint=()=>{const body=document.querySelector('.reader-body'),node=document.querySelector('.sentence[data-index="0"]').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,1);const r=range.getBoundingClientRect(),b=body.getBoundingClientRect();return{x:r.x,y:r.y,bodyX:b.x,bodyWidth:b.width,font:getComputedStyle(body).fontSize};};
const samePoint=(a,b)=>['x','y','bodyX','bodyWidth'].every(key=>Math.abs(a[key]-b[key])<=.5)&&a.font===b.font;
async function baselineFrame(theme,shape){
 await navigate('http://127.0.0.1:3513/read/g76');await wait(()=>c.evaluate("document.readyState==='complete'"),'对照页面');
 await ev((theme,shape)=>{localStorage.clear();localStorage.setItem('gloss:doc:g76',JSON.stringify({version:1,docId:'g76',paragraphs:['春风吹过山谷。河水流向海洋。'],headings:[],footnotes:[],meta:{format:'txt',fileName:'验证.txt',charCount:16},savedAt:1}));localStorage.setItem('gloss:settings:gloss-shape',shape);localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');},theme,shape);
 await reload();await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'对照阅读器');await c.evaluate('document.fonts.ready');const before=await ev(originPoint);
 await ev(()=>document.querySelector('.sentence[data-index="0"]').click());await wait(()=>c.evaluate("document.querySelector('.gloss-panel')?.dataset.state==='done'"),'对照白话');const whiteOnly=await ev(whiteBlockFacts);await ev(()=>document.querySelector('.action-row-explain').click());await wait(()=>c.evaluate("!!document.querySelector('.explain-result-text')"),'对照解读');
 return{before,after:await ev(originPoint),whiteOnly,white:await ev(whiteBlockFacts),ui:await ev(g76UIFacts)};
}

function savedDesignFacts(mobile) {
 const root=document.querySelector(mobile?".reader-saved-sheet":"[aria-labelledby=saved-title]");
 const style=(el,...properties)=>{const css=getComputedStyle(el);return properties.map(property=>css[property]);};
 const tokens=(...names)=>{const probe=document.createElement("span");root.append(probe);const colors=names.map(name=>{probe.style.color="var("+name+")";return getComputedStyle(probe).color;});probe.remove();return colors;};
 const [ink,gloss,rule,paper,hover,side]=tokens("--ink","--gloss","--rule","--paper-main","--hover","--paper-side");
 const kinds=[...root.querySelectorAll(".saved-kind")].map(tag=>{
  const kind=tag.dataset.kind;
  return {kind,actual:style(tag,"fontSize","lineHeight","padding","borderRadius","whiteSpace","backgroundColor","color"),colors:tokens("--saved-tag-"+kind+"-bg","--saved-tag-"+kind+"-fg")};
 });
 const heading=root.querySelector(mobile?"header":".reader-saved-heading"), title=heading.querySelector("h2");
 const list=[...root.querySelectorAll(".saved-link")];
 if(!mobile)return {kinds,heading:style(heading,"paddingBottom","marginBottom","borderBottomWidth","borderBottomColor"),title:style(title,"fontSize","letterSpacing","fontWeight","color"),items:list.map(el=>({box:style(el,"display","alignItems","columnGap","padding","borderLeftWidth","fontSize","lineHeight"),text:style(el.querySelector(".saved-item-text"),"whiteSpace","textOverflow","color"),active:el.dataset.jumpHighlight==="true"})),spacing:[...root.querySelectorAll("li+li")].map(el=>style(el,"marginTop")[0]),ink,gloss,rule,hover};
 const grip=root.querySelector(".reader-saved-grip"), filters=root.querySelector(".saved-filters"), backdrop=document.querySelector(".reader-saved-backdrop"), header=document.querySelector(".shell > .col-left");
 const [shadow,dim]=[12,28].map(percent=>{const probe=document.createElement("span");probe.style.color="color-mix(in srgb, var(--ink) "+percent+"%, transparent)";root.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;});
 return {kinds,ink,gloss,rule,paper,side,activeBackground:style(list[0],"backgroundColor")[0],countText:heading.querySelector("span").textContent,shadow,dim,sheet:style(root,"position","bottom","maxHeight","padding","borderRadius","backgroundColor","boxShadow","animationDuration"),maxHeight:innerHeight*.78,backdrop:style(backdrop,"backgroundColor"),top:[backdrop.getBoundingClientRect().top,header.getBoundingClientRect().bottom],grip:style(grip,"width","height","borderRadius","backgroundColor"),gripSpace:style(grip.parentElement,"paddingBottom"),heading:style(heading,"padding","alignItems"),title:style(title,"fontSize","fontWeight","color"),count:style(heading.querySelector("span"),"fontSize","color"),filters:style(filters,"padding","borderBottomWidth","borderBottomColor","columnGap"),chips:[...filters.children].map(el=>({active:el.getAttribute("aria-pressed")==="true",values:style(el,"height","padding","borderTopWidth","borderRadius","fontSize","backgroundColor","borderTopColor","color")})),items:list.map(el=>({box:style(el,"display","gridTemplateColumns","rowGap","columnGap","alignItems","padding","borderBottomWidth","borderBottomColor"),text:style(el.querySelector(".saved-item-source"),"fontSize","color","whiteSpace","textOverflow"),preview:el.querySelector(".saved-item-preview")&&style(el.querySelector(".saved-item-preview"),"gridColumnStart","fontSize","lineHeight","color","webkitLineClamp"),previewText:el.querySelector(".saved-item-preview")?.textContent}))};
}
function verifySavedDesign(facts,mobile) {
 const {kinds,items,ink,gloss,rule,paper,hover}=facts;
 const eq=(actual,expected,label)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error(label+" "+JSON.stringify({actual,expected}));};
 if(kinds.length!==2||!["gloss","explain"].every(kind=>kinds.some(tag=>tag.kind===kind)))throw Error("两类收藏均可见");
 for(const tag of kinds)eq(tag.actual,["11px",mobile?"17.6px":"11px",mobile?"1px 6px":"3px 5px","3px","nowrap",...tag.colors],"收藏小签");
 if(!mobile){
  eq(facts.heading,["8px","12px","1px",rule],"左栏标题行");
  eq(facts.title,["11px","1.1px","400",gloss],"左栏标题");
  eq(facts.spacing,["10px"],"左栏条目间距");
  for(const item of items){
   eq(item.box,["flex","baseline","8px","0px","0px","13px","22.1px"],"左栏条目");
   eq(item.text,["nowrap","ellipsis",item.active?hover:ink],"左栏文字和跳转颜色");
  }
 }else{
  const [position,bottom,maxHeight,padding,radius,background,shadow,animation]=facts.sheet;
  if(Math.abs(parseFloat(maxHeight)-facts.maxHeight)>.5||Math.abs(facts.top[0]-facts.top[1])>.5)throw Error("抽屉高度与压暗层起点 "+JSON.stringify(facts));
  eq([position,bottom,padding,radius,background,shadow,animation],["fixed","0px","8px 0px 24px","16px 16px 0px 0px",paper,facts.shadow+" 0px -6px 24px 0px","0s"],"收藏抽屉");
  eq(facts.backdrop,[facts.dim],"抽屉压暗");
  eq(facts.grip,["36px","4px","2px",rule],"拖动条");
  eq(facts.gripSpace,["10px"],"拖动条下间距");
  eq(facts.heading,["0px 20px 10px","baseline"],"手机标题行");
  eq(facts.title,["17px","700",ink],"手机标题");
  eq(facts.count,["11px",gloss],"全书计数");eq(facts.countText,"2 条 · 全书","全书计数文案");
  eq(facts.filters,["0px 20px 12px","1px",rule,"8px"],"筛选行");
  for(const chip of facts.chips)eq(chip.values,["32px","0px 12px","1px","16px","13px",chip.active?ink:"rgba(0, 0, 0, 0)",chip.active?ink:rule,chip.active?paper:gloss],"筛选胶囊");
  for(const item of items){
   eq(item.box.map((value,index)=>index===1?value.split(" ")[0]:value),["grid","60px","4px","8px","baseline","14px 20px","1px",rule],"抽屉条目");
   eq(item.text,["15px",ink,"nowrap","ellipsis"],"抽屉原句");
   eq(item.preview,["2","12.5px","20px",gloss,"2"],"抽屉两行预览");
   if(!item.previewText)throw Error("抽屉预览缺少正文");
  }
 }
}
async function verifySavedLayout(mobile){
 const facts=await ev(savedDesignFacts,mobile);verifySavedDesign(facts,mobile);
 console.log(JSON.stringify({savedDesign:mobile?"mobile":"sidebar",facts}));
 const faults=mobile?[f=>f.chips.find(chip=>chip.active).values[5]="rgb(1, 2, 3)",f=>f.items[0].preview=null]:[f=>f.items[0].box[4]="2px",f=>f.kinds[0].actual[0]="10px",f=>{f.items[0].active=true;f.items[0].text[2]="rgb(1, 2, 3)";}];
 for(const fault of faults){const broken=structuredClone(facts);fault(broken);let detected=false;try{verifySavedDesign(broken,mobile);}catch{detected=true;}assert(detected,"收藏设计稿负对照");negative++;}
}
async function forceSavedState(selector,state,check){
 await c.call("DOM.enable");await c.call("CSS.enable");
 const {root}=await c.call("DOM.getDocument"),{nodeId}=await c.call("DOM.querySelector",{nodeId:root.nodeId,selector});
 await c.call("CSS.forcePseudoState",{nodeId,forcedPseudoClasses:[state]});
 try{await check();}finally{await c.call("CSS.forcePseudoState",{nodeId,forcedPseudoClasses:[]});}
}
async function verifySavedSheetInteraction(){
 await forceSavedState(".reader-saved-sheet .saved-link","active",async()=>{
  const facts=await ev(savedDesignFacts,true);assert(facts.activeBackground===facts.side,"抽屉条目按下底色");
 });
 await c.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
 try{
  const motion=await ev(()=>{
   const sheet=document.querySelector(".reader-saved-sheet"),style=getComputedStyle(sheet);
   const animation=sheet.getAnimations().find(animation=>animation.animationName==="saved-sheet-in");
   return {duration:style.animationDuration,ease:style.animationTimingFunction,frames:animation?.effect.getKeyframes().map(({opacity,transform})=>[opacity,transform])};
  });
  assert(motion.duration==="0.22s"&&motion.ease==="cubic-bezier(0.2, 0.7, 0.2, 1)"&&JSON.stringify(motion.frames)===JSON.stringify([["0.5","translateY(24px)"],["1","none"]]),"抽屉入场动画 "+JSON.stringify(motion));
  console.log(JSON.stringify({savedMotion:motion}));
 }finally{await c.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});}
 const point=await ev(()=>{const r=document.querySelector(".reader-saved-grip").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
 await c.call("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
 try{
  await c.call("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point]});
  await c.call("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:point.x,y:point.y+100}]});
  await c.call("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  await wait(()=>c.evaluate("!document.querySelector('.reader-saved-sheet')"),"下滑关闭收藏抽屉");
  assert(true,"下滑关闭收藏抽屉");
 }finally{await c.call("Emulation.setTouchEmulationEnabled",{enabled:false});}
 await ev(()=>document.querySelector(".reader-saved-mobile").click());
 await wait(()=>c.evaluate("!!document.querySelector('.reader-saved-sheet')"),"恢复收藏抽屉场景");
}
async function savedScreenshot(name){
 const dir=join(process.cwd(),"tmp-g76-shots");await mkdir(dir,{recursive:true});
 await c.call("Page.bringToFront");
 await c.evaluate("document.fonts.ready.then(()=>true)");
 const shot=await c.call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false,optimizeForSpeed:true});
 await writeFile(join(dir,name+".png"),Buffer.from(shot.data,"base64"));
}
async function negativeCheck(label,predicate,mutate,restore){assert(await ev(predicate),label+'正对照');await ev(mutate);try{assert(!await ev(predicate),label+'负对照检出');negative++;}finally{await ev(restore);}}

async function shortBubbleRuntimeNegative(base,width,kind){
 const positive=await ev(whiteBlockFacts);assertWhiteBlocks(base,positive,width);
 assert(!!positive[0]?.bubble&&base[0].bubble.outer<base[0].bubble.available,"短气泡负对照正样本");
 if(kind==="无故增宽")assert(!positive[0].bubble.hasExplain&&positive[0].bubble.natural<=base[0].bubble.outer,"无解读且控件无需增宽正样本");
 const style=await ev(()=>document.querySelector(".gloss-panel-bubble").getAttribute("style"));
 try{
  await ev((kind,base,positive)=>{const panel=document.querySelector(".gloss-panel-bubble");let width;if(kind==="断点")width=positive.reserve+(positive.bubble.outer-positive.blockWidth)+Math.max(1,base.chars[0].w*2);else if(kind==="超出可用宽度")width=positive.bubble.available+1;else width=positive.bubble.outer+1;panel.style.setProperty("width",width+"px","important");panel.style.setProperty("max-width","none","important");},kind,base[0],positive[0]);
  const changed=await ev(whiteBlockFacts);let message="";try{assertWhiteBlocks(base,changed,width);}catch(error){message=error.message;}
  const expected=kind==="断点"?"短气泡白话逐行断点":kind==="超出可用宽度"?"气泡不超过可用宽度":"短气泡外框按内容实测";
  assert(message.includes(expected),"实际短气泡负对照检出 "+kind+"："+message);negative++;console.log(JSON.stringify({shortBubbleNegative:kind,width,detected:true}));
 }finally{await ev(style=>{const panel=document.querySelector(".gloss-panel-bubble");if(style===null)panel.removeAttribute("style");else panel.setAttribute("style",style);},style);assertWhiteBlocks(base,await ev(whiteBlockFacts),width);assert(true,"短气泡负对照恢复正样本");}
}

async function verifyRecallOpacity(selector,width){
 const expected=await ev(selector=>document.querySelector(selector).closest('.action-row').dataset.actionPlacement==='side'?'0.45':'1',selector);
 assert(await ev(selector=>getComputedStyle(document.querySelector(selector)).opacity,selector)===expected,'生成过的叫回平时不透明度');
 const point=await ev(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);
 const hoverLayout=()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,boxes:[...document.querySelectorAll(".reader-body,.reader-body .sentence,.gloss-block,.gloss-panel-text,.explain-surface,.action-row,.action-row button,.action-row svg,.action-row-recall-label")].map(el=>{const r=el.getBoundingClientRect();return[r.x,r.y,r.width,r.height];})});
 const before=await ev(hoverLayout);
 await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
 if(expected==="0.45"){
  const tooltip=await ev(selector=>{const el=document.querySelector(selector),tip=getComputedStyle(el,"::after");return{content:tip.content,position:tip.position,bottom:tip.bottom,right:tip.right,font:tip.fontSize,line:tip.lineHeight,padding:tip.padding,radius:tip.borderRadius,background:tip.backgroundColor,color:tip.color};},selector);
  const valid=(a,b,t)=>JSON.stringify(a)===JSON.stringify(b)&&t.position==="absolute"&&t.bottom==="34px"&&t.right==="0px"&&t.font==="12px"&&Math.abs(parseFloat(t.line)-16.8)<.01&&t.padding==="4px 8px"&&t.radius==="4px"&&/看白话|看脉络解读/.test(t.content);
  const after=await ev(hoverLayout);
  assert(valid(before,after,tooltip),"悬停提示样式与布局零变化 "+JSON.stringify(tooltip));
  await ev(()=>{const style=document.createElement("style");style.id="g76-tooltip-fault";style.textContent='.action-row[data-action-placement="side"] button:hover::after{position:static!important}';document.head.append(style);});
  try{assert(JSON.stringify(await ev(hoverLayout))!==JSON.stringify(before),"悬停提示进入流的布局变化负对照");negative++;}
  finally{await ev(()=>document.querySelector("#g76-tooltip-fault").remove());}
  assert(JSON.stringify(await ev(hoverLayout))===JSON.stringify(before),"悬停提示恢复后布局相同");
 }

 assert(await ev(selector=>getComputedStyle(document.querySelector(selector)).opacity==='1',selector),'悬停叫回常亮');
 await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
 await ev(selector=>document.querySelector(selector).closest('.action-row').querySelector('.action-row-save').focus({preventScroll:true}),selector);
 await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
 await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
 assert(await ev(selector=>{const el=document.querySelector(selector);return document.activeElement===el&&el.matches(':focus-visible')&&getComputedStyle(el).opacity==='1'&&getComputedStyle(el).outlineWidth==='2px'&&getComputedStyle(el).outlineOffset==='1px';},selector),'键盘聚焦叫回常亮');
 await ev(()=>document.activeElement.blur());
 assert(await ev(selector=>getComputedStyle(document.querySelector(selector)).opacity,selector)===expected,'移出与失焦后恢复不透明度');
}
try {
 let tab;await wait(async()=>{try{tab=(await(await fetch('http://127.0.0.1:9512/json')).json()).find(t=>t.type==='page');return !!tab;}catch{return false;}},'Edge');c=new Cdp(tab.webSocketDebuggerUrl);await c.call('Page.enable');await c.call('Runtime.enable');
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__g76Events=[];addEventListener('gloss:analytics',e=>__g76Events.push(e.detail));const nativeFetch=fetch;window.fetch=async function(url,options){if(String(url).includes('/api/gloss'))return new Response('这是用于验证的白话。',{headers:{'Content-Type':'text/event-stream'}});if(String(url).includes('/api/explain'))return new Response(JSON.stringify({type:'sentence',text:localStorage.getItem('g76-long')?'这是用于验证的脉络解读。'.repeat(90):'这是用于验证的脉络解读。'})+'\\n'+JSON.stringify({type:'done'})+'\\n',{headers:{'Content-Type':'text/event-stream'}});if(String(url).includes('/api/structure')||String(url).includes('/api/analytics'))return new Response(null,{status:204});return nativeFetch.apply(this,arguments);};`});
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});
 await navigate('http://127.0.0.1:3512/');await wait(()=>c.evaluate("document.readyState==='complete'"),'首页');
 await ev(()=>{localStorage.clear();localStorage.setItem('gloss:settings:reading-mode','review');localStorage.setItem('gloss:doc:g76',JSON.stringify({version:1,docId:'g76',paragraphs:['春风吹过山谷。河水流向海洋。'],headings:[],footnotes:[],meta:{format:'txt',fileName:'验证.txt',charCount:16},savedAt:1}));});
 await navigate('http://127.0.0.1:3512/read/g76');await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'阅读器');
 const header=()=>{
  const selectors=['.reader-shelf-back','.reader-mobile-heading','.reader-selection-mobile','.reader-saved-mobile','.reader-typography-aa'];
  const elements=selectors.map(s=>document.querySelector(s));
  const boxes=elements.map((el,index)=>{const r=el.getBoundingClientRect();return {selector:selectors[index],x:r.x,right:r.right,width:r.width,height:r.height};});
  const label=elements[2].querySelector('span');
  const labelBox=label.getBoundingClientRect();
  return {boxes,ok:boxes.every((b,i)=>b.width>0&&b.x>=0&&b.right<=document.documentElement.clientWidth&&(i===0||boxes[i-1].right<=b.x))&&boxes[2].height===44&&label.textContent==='划选'&&getComputedStyle(label).fontSize==='14px'&&labelBox.width>0&&labelBox.x>=boxes[2].x&&labelBox.right<=boxes[2].right};
 };
 await c.call('Emulation.setDeviceMetricsOverride',{width:320,height:900,deviceScaleFactor:1,mobile:false});
 const narrow=await ev(header);console.log(JSON.stringify({header320:narrow}));
 assert(narrow.ok,'320px 顶栏宽度 '+JSON.stringify(narrow));
 await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});
 await negativeCheck('划选文字可见且14px',()=>{const el=document.querySelector('.reader-selection-mobile span');return el.textContent==='划选'&&getComputedStyle(el).fontSize==='14px'&&el.getBoundingClientRect().width>0;},()=>document.querySelector('.reader-selection-mobile span').style.display='none',()=>document.querySelector('.reader-selection-mobile span').style.removeProperty('display'));
 await savedScreenshot('375-selection-header');
 await ev(()=>document.querySelector('.sentence[data-index="0"]').click());
 await wait(()=>c.evaluate("!!document.querySelector('.gloss-block .action-row-explain')"),'入口');
 await ev(()=>document.querySelector('.gloss-block .action-row-explain').click());
 await wait(()=>c.evaluate("!!document.querySelector('.explain-result-text')"),'解读');
 assert(await c.evaluate("document.querySelectorAll('.action-row-recall').length===0"),'两块显示第一格为空');
 await ev(()=>document.querySelector('.explain-result .action-row-save').click());await sleep(500);
 assert(await c.evaluate("__g76Events.filter(e=>e.event==='explain_save').length===1"),'解读收藏一次');
 await ev(()=>document.querySelector('.gloss-block .action-row-fold').click());await sleep(350);
 await ev(()=>document.querySelector('.explain-result .action-row-fold').click());await sleep(350);
 assert(await c.evaluate("!document.querySelector('.gloss-panel')"),'两块全收');
 assert(await c.evaluate("document.querySelector('.sentence[data-index=\"0\"]')?.classList.contains('sentence-saved-collapsed')"),'收起后收藏原句标记保留');
 await ev(()=>document.querySelector('.sentence[data-index="0"]').click());await sleep(350);
 assert(await c.evaluate("!!document.querySelector('.explain-result')&&!document.querySelector('.gloss-block')"),'仅解读收藏重新打开');
 await reload();await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'刷新');
 assert(await c.evaluate("!!document.querySelector('.explain-result')&&!document.querySelector('.gloss-block')"),'刷新恢复解读收藏');
 await ev(()=>document.querySelector('.explain-result .action-row-save').click());await sleep(350);
 assert(await c.evaluate("!!document.querySelector('.explain-result-text')&&!document.querySelector('.gloss-block')"),'取消唯一解读收藏仍保留正在看的块');
 await ev(()=>document.querySelector('.explain-result .action-row-save').click());await sleep(350);
 await reload();await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'重存后刷新');
 await ev(()=>document.querySelector('.explain-result .action-row-recall').click());
 await wait(()=>c.evaluate("!!document.querySelector('.gloss-block .action-row-save:not(:disabled)')"),'叫回白话可收藏');
 await ev(()=>document.querySelector('.gloss-block .action-row-save').click());await sleep(500);
 await negativeCheck('书签可访问名称与收藏状态',()=>document.querySelector('.gloss-block .action-row-save')?.getAttribute('aria-label')==='取消收藏'&&document.querySelector('.gloss-block .action-row-save')?.getAttribute('aria-pressed')==='true',()=>document.querySelector('.gloss-block .action-row-save').setAttribute('aria-label','收藏'),()=>document.querySelector('.gloss-block .action-row-save').setAttribute('aria-label','取消收藏'));
 await negativeCheck('两块显示第一格为空',()=>document.querySelectorAll('.action-row-recall').length===0,()=>{const button=document.createElement('button');button.id='g76-negative';button.className='action-row-recall';document.querySelector('.action-row-recall-slot').append(button);},()=>document.querySelector('#g76-negative').remove());
 await ev(()=>document.querySelector('.reader-saved-mobile').click());await sleep(350);
 assert(await c.evaluate("document.querySelectorAll('#reader-saved-sheet .saved-link').length===2"),'两类条目分别计数');
 await negativeCheck('左栏收藏使用原句摘要',()=>{
  const source=document.querySelector('.sentence[data-index="0"]').textContent;
  const items=[...document.querySelectorAll('[aria-labelledby="saved-title"] .saved-item-text')];
  return items.length===2&&items.every(el=>el.textContent===source);
 },()=>{const el=document.querySelector('.saved-item-text');el.dataset.original=el.textContent;el.textContent='这是用于验证的白话。';},()=>{const el=document.querySelector('.saved-item-text');el.textContent=el.dataset.original;delete el.dataset.original;});
 await negativeCheck('左栏与抽屉都按白话、脉络解读排序',()=>{
  const order=root=>[...document.querySelectorAll(root+' .saved-kind')].map(el=>el.dataset.kind).join(',');
  return order('[aria-labelledby="saved-title"]')==='gloss,explain'&&order('#reader-saved-sheet')==='gloss,explain';
 },()=>{const list=document.querySelector('#reader-saved-sheet .saved-list');list.prepend(list.lastElementChild);},()=>{const list=document.querySelector('#reader-saved-sheet .saved-list');list.append(list.firstElementChild);});
 await verifySavedLayout(true);await savedScreenshot('375-saved-drawer');await verifySavedSheetInteraction();
 await negativeCheck('收藏类型签',()=>document.querySelectorAll('#reader-saved-sheet .saved-kind[data-kind="gloss"]').length===1&&document.querySelectorAll('#reader-saved-sheet .saved-kind[data-kind="explain"]').length===1,()=>document.querySelector('#reader-saved-sheet .saved-kind[data-kind="explain"]').setAttribute('data-kind','wrong'),()=>document.querySelector('#reader-saved-sheet .saved-kind[data-kind="wrong"]').setAttribute('data-kind','explain'));
 await negativeCheck('抽屉互斥',()=>document.querySelectorAll('#reader-saved-sheet,.reader-typography-sheet,.feedback-card').length===1,()=>{const div=document.createElement('div');div.className='reader-typography-sheet';div.id='g76-negative';document.body.append(div);},()=>document.querySelector('#g76-negative').remove());
 await ev(()=>document.querySelector('#reader-saved-sheet .saved-kind[data-kind="gloss"]').closest('button').click());await sleep(350);
 assert(await c.evaluate("!!document.querySelector('.gloss-block')&&!document.querySelector('.explain-result')&&!document.querySelector('#reader-saved-sheet')"),'白话条目只开白话且关闭抽屉');
 await negativeCheck('手机叫回常亮',()=>getComputedStyle(document.querySelector('.action-row-recall')).opacity==='1',()=>document.querySelector('.action-row-recall').style.opacity='.45',()=>document.querySelector('.action-row-recall').style.removeProperty('opacity'));
 await ev(()=>document.querySelector('.reader-saved-mobile').click());await sleep(350);await ev(()=>document.querySelector('#reader-saved-sheet .saved-kind[data-kind="explain"]').closest('button').click());await sleep(350);
 assert(await c.evaluate("!!document.querySelector('.explain-result')&&!document.querySelector('.gloss-block')&&!document.querySelector('#reader-saved-sheet')"),'解读条目只开解读且关闭抽屉');
 await ev(()=>document.querySelector('.explain-result .action-row-save').click());await sleep(350);
 await negativeCheck('取消不发explain_save',()=>__g76Events.filter(e=>e.event==='explain_save').length===0,()=>__g76Events.push({event:'explain_save',sentenceIndex:0}),()=>__g76Events.pop());
 await ev(()=>document.querySelector('.reader-saved-mobile').click());await sleep(350);await ev(()=>document.querySelector('.reader-typography-aa').click());await sleep(350);
 assert(await c.evaluate("!!document.querySelector('.reader-typography-sheet')&&!document.querySelector('#reader-saved-sheet')"),'设置关闭收藏抽屉');
 await ev(()=>document.querySelector('.reader-settings-feedback').click());await sleep(350);
 assert(await c.evaluate("!!document.querySelector('.feedback-card')&&!document.querySelector('.reader-typography-sheet')&&!document.querySelector('#reader-saved-sheet')"),'反馈关闭设置抽屉');
 await reload();await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'抽屉后刷新');
 for (const width of [1280,1440,375,506,767,768,999,1000,1024,1920]) for(const theme of ['parchment','moon-white','eye-green','dark']) for(const shape of ['inline','bubble']) {
  await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  const reference=await baselineFrame(theme,shape);
  await navigate('http://127.0.0.1:3512/read/g76');await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'候选阅读器返回');
  await ev((theme,shape)=>{localStorage.removeItem('gloss:saved:g76');localStorage.removeItem('gloss:explain-saved:g76');localStorage.removeItem('gloss:explain:g76');localStorage.setItem('gloss:settings:gloss-shape',shape);localStorage.setItem('gloss:settings:theme',theme==='dark'?'parchment':theme);localStorage.setItem('gloss:settings:appearance',theme==='dark'?'dark':'light');},theme,shape);
  await reload();await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'矩阵阅读器');
  assert(samePoint(await ev(originPoint),reference.before),'同场景原句与正文宽度对照：展开前');
  if(width<768){const boxes=await ev(()=>['.reader-shelf-back','.reader-mobile-heading','.reader-selection-mobile','.reader-saved-mobile','.reader-typography-aa'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));assert(boxes.every((a,i)=>boxes.every((b,j)=>i===j||Math.min(a.right,b.right)<=Math.max(a.left,b.left)||Math.min(a.bottom,b.bottom)<=Math.max(a.top,b.top))),'手机五项命中区域无重叠 '+JSON.stringify(boxes));}
  await ev(()=>document.querySelector('.sentence[data-index="0"]').click());await wait(()=>c.evaluate("!!document.querySelector('.gloss-block .action-row-explain')"),'矩阵入口');
  assert(await c.evaluate("getComputedStyle(document.querySelector('.action-row-recall')).opacity==='1'"),'未生成入口常亮');
  await wait(()=>c.evaluate("document.querySelector('.gloss-block')?.dataset.state==='done'"),"生成解读前白话取样就绪");
  assertWhiteBlocks(reference.whiteOnly,await ev(whiteBlockFacts),width);assert(true,"生成解读前白话宽度与断点");
  assertG76UI(reference.ui,await ev(g76UIFacts),width);
  if(width===375&&theme==="parchment"&&shape==="bubble")await shortBubbleRuntimeNegative(reference.whiteOnly,width,"无故增宽");
  await ev(()=>document.querySelector('.gloss-block .action-row-explain').click());await wait(()=>c.evaluate("!!document.querySelector('.explain-result-text')"),'矩阵解读');
  assert(await c.evaluate("document.querySelectorAll('.action-row-recall').length===0"),'矩阵两块显示第一格空');
  await wait(()=>c.evaluate("document.querySelector('.gloss-block')?.dataset.state==='done'"),"白话宽度取样就绪");
  const whiteFacts=await ev(whiteBlockFacts);
  assertWhiteBlocks(reference.white,whiteFacts,width);
  negative+=whiteBlockNegatives(reference.white,whiteFacts,width);
  if(width===375&&theme==="parchment"&&shape==="bubble"){await shortBubbleRuntimeNegative(reference.white,width,"断点");await shortBubbleRuntimeNegative(reference.white,width,"超出可用宽度");}
  assert(true,'白话宽度与字体、换行验收');
  const ui=await ev(g76UIFacts);
  assertG76UI(reference.ui,ui,width);
  negative+=g76UINegatives(reference.ui,ui,width);
  if(shape==="inline"&&[1000,1024,1280,1440,1920].includes(width)&&theme==="parchment"){
   if(width===1280)assert(ui.controls.every(row=>row.mode==="side"),"1280px 使用右侧模式");
   console.log(JSON.stringify({designWidth:width,gap:ui.controls[0].gap,mode:ui.controls[0].mode,controls:ui.controls,explanations:ui.explanations}));
  }
  if(width===1440&&shape==="inline"&&["parchment","dark"].includes(theme)){
   const dir=join(process.cwd(),"tmp-g76-shots");await mkdir(dir,{recursive:true});
   const shot=await c.call("Page.captureScreenshot",{format:"png"});
   await writeFile(join(dir,"1440-"+theme+".png"),Buffer.from(shot.data,"base64"));
  }
  if(width===1440&&shape==="inline"&&theme==="parchment"){
   const anchors=()=>[...document.querySelectorAll(".reader-body .sentence[data-index='0'],.gloss-panel-text")].map(el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
   assert(await ev(()=>[...document.querySelectorAll(".gloss-block,.explain-surface")].every(el=>getComputedStyle(el).animationName==="none")),"减少动态效果禁用入场动画");
   await c.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
   const animation=await ev(()=>{
    const rules=[...document.styleSheets].flatMap(sheet=>{try{return [...sheet.cssRules];}catch{return [];}});
    const keyframes=rules.find(rule=>rule instanceof CSSKeyframesRule&&rule.name==="gloss-block-in");
    return {styles:[...document.querySelectorAll(".gloss-block,.explain-surface")].map(el=>{const s=getComputedStyle(el);return[s.animationName,s.animationDuration,s.animationTimingFunction];}),frames:keyframes&&[...keyframes.cssRules].map(rule=>[rule.style.opacity,rule.style.transform])};
   });
   await c.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
   assert(animation.styles.length===2&&animation.styles.every(([name,duration,timing])=>name==="gloss-block-in"&&duration==="0.22s"&&timing==="cubic-bezier(0.2, 0.7, 0.2, 1)")&&JSON.stringify(animation.frames)===JSON.stringify([["0","translateY(-3px)"],["1","none"]]),"入场动画数值 "+JSON.stringify(animation));
   console.log(JSON.stringify({designAnimation:animation}));
   const before=await ev(anchors);
   const oldStyle=await ev(()=>{const main=document.querySelector(".col-main"),style=main.getAttribute("style"),css=getComputedStyle(main);main.style.width=(main.getBoundingClientRect().width-110)+"px";main.style.paddingLeft=(parseFloat(css.paddingLeft)+110)+"px";return style;});
   try{
    await c.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const switched=await ev(g76UIFacts);
    assert(switched.controls.length===2&&switched.controls.every(row=>row.gap<164&&row.mode==="below"),"空间收窄后两块进入下方模式 "+JSON.stringify(switched.controls.map(({mode,gap})=>({mode,gap}))));
    assert(JSON.stringify(await ev(anchors))===JSON.stringify(before),"控件切换时被点原句与白话不动");
   }finally{await ev(style=>{const main=document.querySelector(".col-main");if(style===null)main.removeAttribute("style");else main.setAttribute("style",style);},oldStyle);}
   await wait(()=>c.evaluate("document.querySelector('.gloss-block .action-row').dataset.actionPlacement==='side'"),"恢复右侧模式");
   assert(JSON.stringify(await ev(anchors))===JSON.stringify(before),"恢复控件模式时被点原句与白话不动");
  }
  assert(samePoint(await ev(originPoint),reference.after),'同场景原句与正文宽度对照：生成解读后');
  assert(await c.evaluate("document.documentElement.scrollWidth<=innerWidth"),'矩阵无页面溢出');
  const sizes=await ev(()=>({gloss:parseFloat(getComputedStyle(document.querySelector('.gloss-panel-text')).fontSize),explain:parseFloat(getComputedStyle(document.querySelector('.explain-result-text')).fontSize)}));
  assert(Math.abs(sizes.explain-sizes.gloss-1)<.01,'解读字号加一');
  await ev(()=>{window.__g76OriginalTop=()=>{const node=document.querySelector('.sentence[data-index="0"]').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,1);return range.getBoundingClientRect().top;};window.__g76BeforeFold=__g76OriginalTop();});
  await ev(()=>document.querySelector('.gloss-block .action-row-fold').click());await sleep(350);
  const originalDelta=await ev(()=>Math.abs(__g76OriginalTop()-__g76BeforeFold));assert(originalDelta<=.5,'视口顶部收白话原句参照字位移 '+originalDelta);
  await verifyRecallOpacity('.explain-result .action-row-recall',width);
  await ev(()=>document.querySelector('.explain-result .action-row-recall').click());await sleep(350);
  await ev(()=>document.querySelector('.explain-result .action-row-fold').click());await sleep(350);
  await verifyRecallOpacity('.gloss-block .action-row-recall',width);
  if([1280,1440].includes(width)&&shape==="inline"&&theme==="parchment"){
   await ev(()=>document.querySelector('.gloss-block .action-row-recall').click());
   await wait(()=>c.evaluate("!!document.querySelector('.explain-result-text')"),"截图两块展开");
   for(const block of [".gloss-block",".explain-result"]){
    await ev(selector=>document.querySelector(selector+" .action-row-save").click(),block);
    await wait(()=>ev(selector=>document.querySelector(selector+" .action-row-save")?.getAttribute("aria-pressed")==="true",block),"截图收藏状态");
   }
   await verifySavedLayout(false);await savedScreenshot(width+"-parchment-saved");
   for(const pseudo of ["hover","focus-visible"]){
    await forceSavedState('[aria-labelledby="saved-title"] .saved-link',pseudo,async()=>{
     const facts=await ev(savedDesignFacts,false);assert(facts.items[0].text[2]===facts.hover,"左栏条目 "+pseudo+" 文字色");
    });
   }
   await ev(()=>document.querySelector('[aria-labelledby="saved-title"] .saved-link').click());
   await wait(()=>c.evaluate("!!document.querySelector('.saved-link[data-jump-highlight=true]')"),"左栏跳转高亮");
   verifySavedDesign(await ev(savedDesignFacts,false),false);
   await ev(()=>document.querySelector(".gloss-block .action-row-fold").click());
   await wait(()=>c.evaluate("!document.querySelector('.saved-link[data-jump-highlight=true]')"),"收起对应块清除跳转高亮");
   assert(true,"收起对应块清除跳转高亮");
  }
  console.log(JSON.stringify({width,theme,shape,checks}));
 }
 // 原文和保留块分别取真实字框；负对照禁用补偿而不修改判据。
 await ev(()=>{const record=JSON.parse(localStorage.getItem('gloss:doc:g76'));record.paragraphs=Array.from({length:12},()=>record.paragraphs[0]);localStorage.setItem('gloss:doc:g76',JSON.stringify(record));localStorage.setItem('g76-long','1');localStorage.removeItem('gloss:saved:g76');});
 for(const disable of [false,true]) {
  await ev(()=>{localStorage.removeItem('gloss:explain:g76');localStorage.removeItem('gloss:explain-saved:g76');});
  await c.call('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});
  await reload();await wait(()=>c.evaluate("document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"0\"]')"),'补偿阅读器');
  await ev(()=>document.querySelector('.sentence[data-index="0"]').click());await wait(()=>c.evaluate("!!document.querySelector('.gloss-block .action-row-explain')"),'补偿入口');
  await ev(()=>document.querySelector('.gloss-block .action-row-explain').click());await wait(()=>c.evaluate("document.querySelector('.explain-result-text')?.textContent.length>500"),'长解读');
  await ev(()=>{window.scrollTo(0,200);window.__g76Char=offset=>{const node=document.querySelector('.explain-result-text').firstChild,range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);return range.getBoundingClientRect().top;};});await sleep(350);
  await ev(()=>{let offset=0;while(__g76Char(offset)<60)offset++;window.__g76Reference={offset,top:__g76Char(offset)};});
  if(disable)await ev(()=>{window.__g76ScrollBy=window.scrollBy;window.scrollBy=()=>{};const style=document.createElement('style');style.id='g76-no-compensation';style.textContent='.reader-body{translate:0 0!important}';document.head.append(style);});
  await ev(()=>document.querySelector('.gloss-block .action-row-fold').click());await sleep(350);
  const delta=await ev(()=>Math.abs(__g76Char(__g76Reference.offset)-__g76Reference.top));
  console.log(JSON.stringify({scenario:'长解读保留字',disable,delta}));
  assert(disable?delta>.5:delta<=.5,disable?'关闭补偿必须检出':'长解读保留字位移');if(disable)negative++;
  if(disable)await ev(()=>{window.scrollBy=__g76ScrollBy;document.querySelector('#g76-no-compensation').remove();});
 }
 await ev(()=>{window.__g76PixelX=document.querySelector('.sentence').getBoundingClientRect().x;});
 await negativeCheck('原文1px位移',()=>Math.abs(document.querySelector('.sentence').getBoundingClientRect().x-__g76PixelX)<.5,()=>document.querySelector('.reader-body').style.transform='translateX(1px)',()=>document.querySelector('.reader-body').style.removeProperty('transform'));
 console.log(JSON.stringify({checks,negative,profile}));
}catch(error){if(c)console.log(await c.evaluate("({mock:fetch.toString(),body:document.body.innerText,events:window.__g76Events})"));throw error;}finally{if(c){try{await c.call('Browser.close');}catch{}c.close();}}

}
