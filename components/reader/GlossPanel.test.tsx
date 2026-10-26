// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GlossPanel, { IDLE_EXPLAIN_VIEW, type GlossView } from "./GlossPanel";
import { Paragraph, groupRegions, sourceSelectionRanges, anchorAtViewportTop, type Region } from "./Reader";
const noop=()=>{};
const view:GlossView={status:"done",text:"本地结果。",failure:null,instant:true};
const props={view,onRetry:noop,onBeforeReveal:()=>null,onAfterReveal:noop,saved:false,onSave:async()=>"saved" as const,sentenceIndex:0,onExplain:noop,onExplainRetry:noop,onExplainBlocked:noop};
describe("G-64a 结果面板",()=>{
 it("语境标题精确、范围无标题；只有留下且不保留解释占位",()=>{
   for(const title of ["「潮汐」在这里指什么",undefined]){
     const host=document.createElement("div");host.innerHTML=renderToString(createElement(GlossPanel,{...props,selectionId:"范围",selectionOnly:true,title}));
     expect(host.querySelectorAll(".action-row button")).toHaveLength(1);expect(host.querySelector(".action-row-explain")).toBeNull();
     expect(host.querySelector(".gloss-panel-title")?.textContent).toBe(title);
   }
 });
 it.each(["refused","unavailable"] as const)("失败 %s 不可留下",failure=>{
   const host=document.createElement("div");host.innerHTML=renderToString(createElement(GlossPanel,{...props,selectionOnly:true,view:{...view,status:"failed",failure,text:""}}));
   expect(host.querySelector<HTMLButtonElement>(".action-row-save")?.disabled).toBe(true);
 });
 it("默认单句仍保留听不懂",()=>{
   const host=document.createElement("div");host.innerHTML=renderToString(createElement(GlossPanel,props));
   expect(host.querySelector(".action-row-explain")?.textContent).toBe("听不懂");
 });
 it("同插入点两个已留下范围与一个临时结果，不覆盖且原文只渲染一次",()=>{
   const region=(id:string,start:number,time:number|null):Region=>{
     const selection={start:{paraIndex:0,offset:start},end:{paraIndex:0,offset:3},kind:"range" as const,text:"甲乙。".slice(start),autoPunctuation:"",chars:3-start,sentenceCount:1};
     const saved=time===null?null:{resultKind:"range" as const,start:selection.start,end:selection.end,sourceHash:"f".repeat(64),text:id,savedAt:time,promptVersion:"range-v0",model:"deepseek-flash"};
     return {index:0,splitAt:null,view:{...view,text:id},saved:!!saved,presentation:"inline",actionVisible:true,explainView:IDLE_EXPLAIN_VIEW,glossKey:id,
       selectionSlot:{result:{id,selection,index:0,resultKind:"range",view:{...view,text:id},saved,expanded:true,nonMouse:false,input:null,retry:0,promptVersion:"range-v0",model:"deepseek-flash"},
       panelRef:null,onRetry:noop,onSave:props.onSave,onBeforeReveal:()=>null,onAfterReveal:noop}};
   };
   const regions=[region("临时",0,null),region("后起点",1,10),region("前起点",0,20)];
   expect([...groupRegions(regions).get(0)!].map(r=>r.selectionSlot!.result.id)).toEqual(["前起点","后起点","临时"]);
   const host=document.createElement("div");host.innerHTML=renderToString(createElement(Paragraph,{paraIndex:0,heading:undefined,pieces:[{index:0,start:0,text:"甲乙。"}],regions,savedMarkers:[],panelRef:null,onRetry:noop,onBeforeReveal:()=>null,onAfterReveal:noop,onSave:props.onSave,onExplain:noop,onExplainRetry:noop,onExplainBlocked:noop,sentences:[],breatheSentenceIndex:null}));
   expect([...host.querySelectorAll("[data-selection-id]")].map(e=>e.getAttribute("data-selection-id"))).toEqual(["前起点","后起点","临时"]);
   expect([...host.querySelectorAll(".sentence")].map(e=>e.textContent).join("")).toBe("甲乙。");
 });
 it("原始坐标 Range 排除白话及透明尾巴，正文 DOM 完全不变",()=>{
   const host=document.createElement("article");host.innerHTML='<p data-para="0"><span class="sentence" data-offset="0">甲乙。</span><span class="reader-tail-placeholder">丙丁</span></p><div class="gloss-panel">白话</div><p data-para="0"><span class="sentence" data-offset="3">丙丁。</span></p>';
   const before=host.innerHTML;const ranges=sourceSelectionRanges(host,["　甲乙。丙丁。"],{start:{paraIndex:0,offset:2},end:{paraIndex:0,offset:6}});
   expect(ranges.map(r=>r.toString()).join("")).toBe("乙。丙丁");expect(host.innerHTML).toBe(before);
 });
});

it("收起范围时可跳过回接字，默认单句锚点仍是原来的第一个可见字",()=>{
  const body=document.createElement("article");body.innerHTML='<p data-para="0"><span class="sentence" data-offset="8">回接文字</span></p><p data-para="1"><span class="sentence" data-offset="0">稳定参照</span></p>';document.body.append(body);
  const range=document.createRange();let node:Node=body.firstChild!,offset=0;
  const rect=(top:number)=>({x:10,y:top,left:10,right:20,top,bottom:top+20,width:10,height:20,toJSON(){}});
  vi.spyOn(document,"createRange").mockReturnValue(range);
  vi.spyOn(range,"setStart").mockImplementation((n,o)=>{node=n;offset=o;});
  vi.spyOn(range,"getClientRects").mockImplementation(()=>[rect(node.parentElement?.closest("[data-para]")?.getAttribute("data-para")==="0"?20:60)] as unknown as DOMRectList);
  for(const span of body.querySelectorAll("span"))vi.spyOn(span,"getBoundingClientRect").mockReturnValue(rect(span.closest("[data-para]")?.getAttribute("data-para")==="0"?20:60));
  try{
    expect(anchorAtViewportTop(body)).toMatchObject({paraIndex:0,offset:8,viewportTop:20});
    expect(anchorAtViewportTop(body,(para,offset)=>para===0&&offset>=8)).toMatchObject({paraIndex:1,offset:0,viewportTop:60});
    expect(anchorAtViewportTop(body,()=>true)).toBeNull();
  }finally{body.remove();vi.restoreAllMocks();}
});
