// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSavedSelections, saveSavedSelection, removeSavedSelection, selectionIdentity, SELECTION_SAVED_PREFIX, type SavedSelection } from "./selection-storage";
import { removeShelfDocument } from "./storage";
import { sha256 } from "./cache";
const paragraphs=["潮汐推动海水。月亮引起潮汐。","后段。"];
beforeEach(()=>{localStorage.clear();});
async function entry(start=0,end=2,kind:"term"|"range"="term"):Promise<SavedSelection>{
 return {resultKind:kind,start:{paraIndex:0,offset:start},end:{paraIndex:0,offset:end},sourceHash:await sha256(paragraphs[0].slice(start,end)),text:"本地结果。",savedAt:100,promptVersion:kind+"-v0",model:"deepseek-flash"};
}
describe("独立划选保存",()=>{
 it("旧单句、解释、原文与阅读位置逐字不变，刷新读取保留区间与模型信息",async()=>{
   const old={"gloss:saved:book":'{"version":1,"entries":[{"旧":"数据"}]}',"gloss:explain:book":"旧解释","gloss:doc:book":"旧原文","gloss:pos:book":"8"};
   for(const[k,v]of Object.entries(old))localStorage.setItem(k,v);
   const value=await entry();expect(await saveSavedSelection("book",paragraphs,value)).toEqual(value);
   expect(await loadSavedSelections("book",paragraphs)).toEqual([value]);
   for(const[k,v]of Object.entries(old))expect(localStorage.getItem(k)).toBe(v);
   removeSavedSelection("book",value);expect(await loadSavedSelections("book",paragraphs)).toEqual([]);
   for(const[k,v]of Object.entries(old))expect(localStorage.getItem(k)).toBe(v);
 });
 it("同区间同种类复用，重叠区间与不同种类独立，按原文排序",async()=>{
   const a=await entry(),b=await entry(0,7,"range"),c=await entry(1,5,"range"),d=await entry(0,2,"range");
   for(const r of [c,b,a,d])await saveSavedSelection("book",paragraphs,r);
   expect((await loadSavedSelections("book",paragraphs)).map(selectionIdentity)).toHaveLength(4);
   expect(await saveSavedSelection("book",paragraphs,{...a,text:"不能覆盖",savedAt:200})).toEqual(a);
   removeSavedSelection("book",a);expect(await loadSavedSelections("book",paragraphs)).toHaveLength(3);
 });
 it("原文不匹配与损坏记录不显示，读取不重写原始记录",async()=>{
   const value=await entry();await saveSavedSelection("book",paragraphs,value);
   const raw=localStorage.getItem(SELECTION_SAVED_PREFIX+"book");
   expect(await loadSavedSelections("book",["不同原文。"])).toEqual([]);
   expect(localStorage.getItem(SELECTION_SAVED_PREFIX+"book")).toBe(raw);
   localStorage.setItem(SELECTION_SAVED_PREFIX+"book",JSON.stringify({version:1,entries:[{...value,end:{paraIndex:99,offset:1}},value,{text:"坏"}]}));
   expect(await loadSavedSelections("book",paragraphs)).toEqual([value]);
 });
 it("存储失败不会出现成功结果；删书同时清掉独立记录",async()=>{
   const value=await entry();vi.stubGlobal("localStorage",{getItem:()=>null,setItem:()=>{throw new DOMException("full","QuotaExceededError");}});
   await expect(saveSavedSelection("book",paragraphs,value)).rejects.toMatchObject({code:"E1"});vi.unstubAllGlobals();
   await saveSavedSelection("book",paragraphs,value);expect(removeShelfDocument("book")).toBe(true);
   expect(localStorage.getItem(SELECTION_SAVED_PREFIX+"book")).toBeNull();
 });
});
