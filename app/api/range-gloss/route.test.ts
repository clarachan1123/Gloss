import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { recordServerAnalytics } from "../../../lib/analytics-server";
import { buildRangeGlossMessages, buildTermMessages } from "../../../lib/selection-context";
vi.mock("../../../lib/analytics-server", async importOriginal => ({ ...await importOriginal<typeof import("../../../lib/analytics-server")>(), recordServerAnalytics: vi.fn() }));
const KIND = "range" as "term" | "range";
const term={word:"潮汐",sentence:"潮汐推动海水。",context:{previous:"前段。",current:"潮汐推动海水。",next:"后段。"},structure:"摘要"};
const range={text:"潮汐推动海水。月亮引起潮汐。",sentenceCount:2,before:["前一。","前二。"],after:["后一。","后二。"],structure:"摘要"};
const input=()=> KIND==="term"?{...term}:{...range};
const request=(body:unknown=input(),signal?:AbortSignal)=>new Request("http://localhost/api/test",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal});
let fetchMock:ReturnType<typeof vi.fn>;
const response=(text:string)=>new Response("data: "+JSON.stringify({choices:[{delta:{content:text}}]})+"\n\ndata: [DONE]\n\n",{status:200});
const silent=(_url:unknown,init:RequestInit)=>new Promise<Response>((_,reject)=>init.signal!.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError"))));
beforeEach(()=>{
  vi.stubEnv("DEEPSEEK_API_KEY","local-test-invalid"); vi.stubEnv("ANALYTICS_ENABLED","0");
  fetchMock=vi.fn(); vi.stubGlobal("fetch",fetchMock);
  vi.spyOn(console,"info").mockImplementation(()=>{}); vi.spyOn(console,"warn").mockImplementation(()=>{});
  vi.mocked(recordServerAnalytics).mockClear();
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe(KIND+" 路由模拟上游",()=>{
  it("请求消息逐字、模型参数、显式禁用thinking，日志无正文",async()=>{
    fetchMock.mockResolvedValue(response("这是解释。"));
    const result=await POST(request()); expect(result.status).toBe(200); expect(await result.text()).toBe("这是解释。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toEqual({model:"deepseek-flash",messages:KIND==="term"?buildTermMessages(term):buildRangeGlossMessages(range),temperature:0.2,max_tokens:KIND==="term"?300:800,stream:true,stream_options:{include_usage:true},thinking:{type:"disabled"}});
    expect(recordServerAnalytics).toHaveBeenCalledWith(expect.objectContaining({event:"ai_call",callKind:KIND,attempt:1,outcome:"done"}));
    for(const args of [...vi.mocked(console.info).mock.calls,...vi.mocked(console.warn).mock.calls])
      for(const raw of [term.sentence,"这是解释。","摘要","local-test-invalid"]) expect(JSON.stringify(args)).not.toContain(raw);
    expect(vi.mocked(recordServerAnalytics).mock.calls.every(([event])=>event.event==="ai_call"&&!JSON.stringify(event).includes(term.sentence))).toBe(true);
  });
  it("输出截断使用120或300字上限，范围最多600字",async()=>{
    fetchMock.mockImplementation(()=>Promise.resolve(response("字".repeat(800))));
    const res=await POST(request()); expect((await res.text()).length).toBe(KIND==="term"?120:300);
    if(KIND==="range"){
      const res2=await POST(request({...range,sentenceCount:7}));expect((await res2.text()).length).toBe(600);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(1600);
    }
  });
  it("拒答不输出正文",async()=>{
    fetchMock.mockResolvedValue(response((KIND==="term"?"【无法作答】":"【无法处理】")+"原因"));
    const res=await POST(request());expect(res.status).toBe(422);expect(await res.json()).toEqual({error:"refused"});
  });
  it.each([[401,502,"api_error"],[429,429,"rate_limited"],[500,502,"api_error"]])("上游%i状态不重试",async(upstream,status,error)=>{
    fetchMock.mockResolvedValue(new Response("不应回显",{status:upstream}));
    const res=await POST(request());expect(res.status).toBe(status);expect(await res.json()).toEqual({error});expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("首字15秒；范围仅沿用单句的一次重试",async()=>{
    vi.useFakeTimers();fetchMock.mockImplementation(silent);
    const pending=POST(request());
    await vi.advanceTimersByTimeAsync(KIND==="term"?15001:31001);
    const res=await pending;expect(res.status).toBe(504);expect(await res.json()).toEqual({error:"timeout"});
    expect(fetchMock).toHaveBeenCalledTimes(KIND==="term"?1:2);
  });
  it("首字后空闲15秒中断，不重试",async()=>{
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url,init:RequestInit)=>Promise.resolve(new Response(new ReadableStream({
      start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:"先到的字句。"}}]})+"\n\n"));init.signal!.addEventListener("abort",()=>c.error(new DOMException("aborted","AbortError")));}
    }))));
    const res=await POST(request());const text=res.text().then(()=>false,()=>true);
    await vi.advanceTimersByTimeAsync(15001);expect(await text).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("客户端首字前与流中中止均传到上游",async()=>{
    fetchMock.mockImplementation(silent);
    const controller=new AbortController();const pending=POST(request(input(),controller.signal));
    await Promise.resolve();await Promise.resolve();controller.abort();expect((await pending).status).toBe(499);
    fetchMock.mockImplementation((_url,init:RequestInit)=>Promise.resolve(new Response(new ReadableStream({
      start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:"先到的文字。"}}]})+"\n\n"));init.signal!.addEventListener("abort",()=>c.error(new DOMException("aborted","AbortError")));}
    }))));
    const second=new AbortController();const res=await POST(request(input(),second.signal));const text=res.text().catch(()=>null);
    second.abort();await text;expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).signal!.aborted).toBe(true);
  });
  it("1000/1001、12/13及标点等协议边界在路由层拒绝",async()=>{
    fetchMock.mockImplementation(()=>Promise.resolve(response("可用结果。")));
    const valid=KIND==="term"?{...term,word:"字".repeat(12),sentence:"字".repeat(1000),context:{current:"字".repeat(2000)},structure:"字".repeat(1000)}:{...range,text:"字".repeat(1000),before:["字".repeat(1000),"二"],after:["字".repeat(1000),"四"],structure:"字".repeat(1000)};
    const accepted=await POST(request(valid));expect(accepted.status).toBe(200);await accepted.text();
    const invalid=KIND==="term"?[
      {...valid,word:"字".repeat(13)},{...valid,word:"字，"},{...valid,sentence:"字".repeat(1001)},
      {...valid,context:{current:"字".repeat(2001)}},{...valid,structure:"字".repeat(1001)},{...valid,word:""},{...valid,sentence:""},
    ]:[
      {...valid,text:"字".repeat(1001)},{...valid,text:""},{...valid,before:["一","二","三"]},{...valid,after:["字".repeat(1001)]},
      {...valid,structure:"字".repeat(1001)},{...valid,sentenceCount:0},
    ];
    for(const body of invalid) expect((await POST(request(body))).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const malformed=new Request("http://localhost/api/test",{method:"POST",body:"{"});expect((await POST(malformed)).status).toBe(400);
  });

  it("响应头后无正文也按首字超时处理",async()=>{
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url,init:RequestInit)=>Promise.resolve(new Response(new ReadableStream({
      start(c){init.signal!.addEventListener("abort",()=>c.error(new DOMException("aborted","AbortError")));}
    }))));
    const pending=POST(request());await vi.advanceTimersByTimeAsync(KIND==="term"?15001:31001);
    expect((await pending).status).toBe(504);expect(fetchMock).toHaveBeenCalledTimes(KIND==="term"?1:2);
  });
  it("正常结束但无正文时返回empty",async()=>{
    fetchMock.mockResolvedValue(response(""));
    const res=await POST(request());expect(res.status).toBe(502);expect(await res.json()).toEqual({error:"empty"});
  });
});
