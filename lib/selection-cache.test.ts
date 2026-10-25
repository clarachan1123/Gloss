import { afterEach, describe, expect, it, vi } from "vitest";
import { SELECTION_CACHE_DB, SELECTION_CACHE_STORE, SELECTION_CACHE_SCHEMA_VERSION, hashSelectionContext, makeSelectionCacheKey, selectionCacheRuntime, readSelectionCache, saveSelectionCache, clearAllSelectionCache, clearSelectionCacheForDocument, type SelectionCacheRecord } from "./selection-cache";
import type { SelectionInput } from "./selection-context";
const selection:SelectionInput={kind:"term",input:{word:"潮汐",sentence:"潮汐推动海水。",context:{previous:null,current:"潮汐推动海水。",next:null},structure:null}};
afterEach(()=>vi.unstubAllGlobals());
/** 模拟独立数据库的异步请求与事务完成，记录实际库名和索引删除范围。 */
function database(){
  const rows=new Map<string,SelectionCacheRecord>();const open=vi.fn();const deleted:string[]=[];
  const close=vi.fn();const schemas:string[]=[];
  const db={
    createObjectStore:vi.fn((name:string)=>{schemas.push(name);return {createIndex:vi.fn()};}),close,
    transaction:vi.fn(()=>{const tx:Record<string,unknown>={};
      const schedule=(action:()=>unknown)=>{const req:Record<string,unknown>={};setTimeout(()=>{
        try{req.result=action();(req.onsuccess as (()=>void)|undefined)?.();setTimeout(()=>(tx.oncomplete as (()=>void)|undefined)?.(),0);}
        catch(error){req.error=error;(req.onerror as (()=>void)|undefined)?.();(tx.onabort as (()=>void)|undefined)?.();}
      },0);return req;};
      tx.objectStore=()=>({
        get:(key:string)=>schedule(()=>rows.get(key)),
        add:(entry:SelectionCacheRecord)=>schedule(()=>{if(rows.has(entry.key))throw new DOMException("duplicate","ConstraintError");rows.set(entry.key,entry);return entry.key;}),
        index:()=>({openCursor:(docId:string)=>{
          const req:Record<string,unknown>={};const keys=[...rows].filter(([,r])=>r.docId===docId).map(([key])=>key);let i=0;
          const advance=()=>setTimeout(()=>{const key=keys[i++];req.result=key?{delete:()=>rows.delete(key),continue:advance}:null;(req.onsuccess as (()=>void)|undefined)?.();if(!key)setTimeout(()=>(tx.oncomplete as (()=>void)|undefined)?.(),0);},0);
          advance();return req;
        }})
      });return tx;
    })
  };
  open.mockImplementation(()=>{const req:Record<string,unknown>={};setTimeout(()=>{req.result=db;if(!schemas.length)(req.onupgradeneeded as (()=>void)|undefined)?.();(req.onsuccess as (()=>void)|undefined)?.();},0);return req;});
  vi.stubGlobal("indexedDB",{open,deleteDatabase:vi.fn((name:string)=>{const req:Record<string,unknown>={};setTimeout(()=>{deleted.push(name);rows.clear();(req.onsuccess as (()=>void)|undefined)?.();},0);return req;})});
  vi.stubGlobal("IDBKeyRange",{only:(id:string)=>id});return {rows,open,close,schemas,deleted};
}
describe("划选缓存隔离与键",()=>{
  it("所有要求的键字段都参与失效，摘要正文仅有无参与",async()=>{
    const runtime=selectionCacheRuntime(selection),parts={docId:"书一",kind:"term" as const,contextHash:await hashSelectionContext(selection),hasStructure:false,runtime};
    const key=makeSelectionCacheKey(parts);
    for(const change of [{docId:"书二"},{kind:"range" as const},{contextHash:"变动"},{hasStructure:true}])expect(makeSelectionCacheKey({...parts,...change})).not.toBe(key);
    for(const [field,value] of Object.entries(runtime))expect(makeSelectionCacheKey({...parts,runtime:{...runtime,[field]:typeof value==="number"?value+1:value+"新"}})).not.toBe(key);
    expect(await hashSelectionContext({...selection,input:{...selection.input,word:"海水"}})).not.toBe(parts.contextHash);
    expect(await hashSelectionContext({...selection,input:{...selection.input,context:{...selection.input.context,previous:"前段"}}})).not.toBe(parts.contextHash);
    expect(await hashSelectionContext({...selection,input:{...selection.input,structure:"摘要"}})).toBe(parts.contextHash);
  });
  it("完整成功结果可读；追加不覆盖，其他书独立，清书不删其他书",async()=>{
    const db=database();
    expect(await readSelectionCache("一",selection)).toBeNull();
    expect(await saveSelectionCache("一",selection,{status:"done",text:"结果甲。"})).toBe(true);
    expect(await saveSelectionCache("一",selection,{status:"done",text:"覆盖。"})).toBe(false);
    expect(await readSelectionCache("一",selection)).toBe("结果甲。");
    expect(await saveSelectionCache("二",selection,{status:"done",text:"结果乙。"})).toBe(true);
    expect(await clearSelectionCacheForDocument("一")).toBe(true);
    expect(await readSelectionCache("一",selection)).toBeNull();expect(await readSelectionCache("二",selection)).toBe("结果乙。");
    expect(db.open.mock.calls.every(([name,version])=>name===SELECTION_CACHE_DB&&version===SELECTION_CACHE_SCHEMA_VERSION)).toBe(true);
    expect(db.schemas).toEqual([SELECTION_CACHE_STORE]);expect(db.close).toHaveBeenCalled();
    expect(await clearAllSelectionCache()).toBe(true);expect(db.deleted).toEqual([SELECTION_CACHE_DB]);
  });
  it("失败、中止、拒答、超长与空结果不进入数据库",async()=>{
    const db=database();
    for(const result of [{status:"aborted" as const},{status:"failed" as const,failure:"interrupted" as const,text:"半截"},{status:"done" as const,text:"【无法作答】"},{status:"done" as const,text:"字".repeat(121)},{status:"done" as const,text:" "}])
      expect(await saveSelectionCache("一",selection,result)).toBe(false);
    expect(db.open).not.toHaveBeenCalled();
  });
  it("浏览器禁用与损坏记录降级为未命中",async()=>{
    vi.stubGlobal("indexedDB",{open:()=>{throw new DOMException("denied","SecurityError");},deleteDatabase:()=>{throw new Error("denied");}});
    expect(await readSelectionCache("一",selection)).toBeNull();expect(await saveSelectionCache("一",selection,{status:"done",text:"结果"})).toBe(false);
    expect(await clearAllSelectionCache()).toBe(false);expect(await clearSelectionCacheForDocument("一")).toBe(false);
    const db=database();await saveSelectionCache("一",selection,{status:"done",text:"结果"});const row=[...db.rows.values()][0];row.schemaVersion=99;
    expect(await readSelectionCache("一",selection)).toBeNull();
  });
});
