import { afterEach, describe, expect, it, vi } from "vitest";
import { streamTerm, streamRangeGloss } from "./selection-client";
import type { TermRequest, RangeGlossRequest } from "./selection-context";
const term:TermRequest={word:"潮汐",sentence:"潮汐推动海水。",context:{previous:null,current:"潮汐推动海水。",next:null},structure:null};
const range:RangeGlossRequest={text:"海水涨起。又退下。",sentenceCount:2,before:[],after:[],structure:null};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe.each([{kind:"term",endpoint:"/api/term",run:(opts:Parameters<typeof streamTerm>[1])=>streamTerm(term,opts),input:term},{kind:"range",endpoint:"/api/range-gloss",run:(opts:Parameters<typeof streamTerm>[1])=>streamRangeGloss(range,opts),input:range}])("$kind客户端",({run,endpoint,input})=>{
  const options=()=>({signal:new AbortController().signal,onText:vi.fn()});
  it("端点、正文、逐字节UTF8与完整结果",async()=>{
    const bytes=new TextEncoder().encode("这是结果。");
    const fetchMock=vi.fn().mockResolvedValue(new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}})));
    vi.stubGlobal("fetch",fetchMock);const opts=options();expect(await run(opts)).toEqual({status:"done",text:"这是结果。"});
    expect(fetchMock).toHaveBeenCalledWith(endpoint,expect.objectContaining({method:"POST",body:JSON.stringify(input),signal:opts.signal}));
    expect(opts.onText).toHaveBeenLastCalledWith("这是结果。");
  });
  it.each([[504,"timeout","timeout"],[502,"api_error","unavailable"],[429,"rate_limited","rate_limited"],[422,"refused","refused"],[403,"unknown","throttled"]])("状态%i错误不重试",async(status,error,failure)=>{
    const mock=vi.fn().mockResolvedValue(Response.json({error},{status:status as number}));vi.stubGlobal("fetch",mock);
    expect(await run(options())).toMatchObject({status:"failed",failure,text:""});expect(mock).toHaveBeenCalledTimes(1);
  });
  it("首字前网络失败与首字后断流",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new TypeError("network")));expect(await run(options())).toMatchObject({status:"failed",failure:"unavailable"});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("先到"));},pull(c){c.error(new Error("断流"));}}))));
    expect(await run(options())).toMatchObject({status:"failed",failure:"interrupted",text:"先到"});
  });
  it("离线不请求，中止不报失败",async()=>{
    const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);vi.stubGlobal("navigator",{onLine:false});
    expect(await run(options())).toMatchObject({status:"failed",failure:"offline"});expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal("navigator",{onLine:true});const controller=new AbortController();
    fetchMock.mockImplementation(()=>{controller.abort();throw new DOMException("aborted","AbortError");});
    expect(await run({signal:controller.signal,onText:vi.fn()})).toEqual({status:"aborted"});
  });
});
