import { describe, expect, it } from "vitest";
import { buildRangeGlossMessages, buildTermMessages, buildRangeGlossInput, buildTermInput, cropTermContext, parseRangeGlossRequest, parseTermRequest, rangeParameters, resolveWholeSentenceReuse } from "./selection-context";
import { RANGE_SYSTEM_PROMPT } from "./prompts/range";
import { TERM_SYSTEM_PROMPT } from "./prompts/term";
import { countChars } from "./parse/validate";
import { normalizeSelection } from "./selection";
import { segmentParagraphs } from "./segment";

const term = { word: "潮汐", sentence: "　潮汐推动海水。", context: { previous: "前段。", current: "潮汐推动海水。", next: "后段。" }, structure: "摘要" };
const range = { text: "潮汐推动海水。月亮引起潮汐。", sentenceCount: 2, before: ["一。", "二。"], after: ["三。", "四。"], structure: "摘要" };

describe("划选上下文与协议", () => {
  it("语境消息逐字与评测一致，额外批注不进入消息", () => {
    const parsed = parseTermRequest({ ...term, 批注: "不应发送" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(buildTermMessages(parsed.value)).toEqual([
      { role: "system", content: TERM_SYSTEM_PROMPT }, { role: "user", content: "【全书结构摘要】\n摘要" },
      { role: "user", content: "【上一段】\n前段。\n\n【当前段】\n潮汐推动海水。\n\n【下一段】\n后段。" },
      { role: "user", content: "【目标句】\n　潮汐推动海水。" }, { role: "user", content: "【选中的词】\n潮汐" },
    ]);
  });
  it("范围消息逐字保留选区与邻句顺序", () => {
    expect(buildRangeGlossMessages(range)).toEqual([
      { role: "system", content: RANGE_SYSTEM_PROMPT }, { role: "user", content: "【全书结构】\n摘要" },
      { role: "user", content: "【前文】\n一。\n二。" }, { role: "user", content: "【要讲白的段落】\n潮汐推动海水。月亮引起潮汐。" },
      { role: "user", content: "【后文】\n三。\n四。" }, { role: "user", content: "【字数上限】\n300" },
    ]);
    expect(buildTermMessages({ ...term, structure: null, context: { previous: null, current: "潮汐。", next: null } })[2].content).toBe("【上一段】\n暂无\n\n【当前段】\n潮汐。\n\n【下一段】\n暂无");
    expect(buildRangeGlossMessages({ ...range, structure: null })[1].content).toBe("【全书结构】\n暂无");
  });
  it.each([[1,150,400],[2,300,800],[3,450,1200],[4,600,1600],[9,600,1600]])("源句数 %i 决定输出预算", (n,L,tokens) => expect(rangeParameters(n)).toEqual({ maxChars:L,maxTokens:tokens }));
  it("1000字、12字边界及所有上下文上限", () => {
    for (const [n,ok] of [[1000,true],[1001,false]] as const) {
      expect(parseRangeGlossRequest({ ...range,text:"字".repeat(n) }).ok).toBe(ok);
      expect(parseTermRequest({ ...term,sentence:"词"+"字".repeat(n-1),word:"词" }).ok).toBe(ok);
      expect(parseRangeGlossRequest({ ...range,before:["字".repeat(n)] }).ok).toBe(ok);
      expect(parseRangeGlossRequest({ ...range,structure:"字".repeat(n) }).ok).toBe(ok);
    }
    for (const [n,ok] of [[12,true],[13,false]] as const) expect(parseTermRequest({ ...term,word:"字".repeat(n),sentence:"字".repeat(n) }).ok).toBe(ok);
    for (const [n,ok] of [[2000,true],[2001,false]] as const) expect(parseTermRequest({ ...term,context:{current:"字".repeat(n)} }).ok).toBe(ok);
    expect(parseRangeGlossRequest({ ...range,before:["一","二","三"] }).ok).toBe(false);
    expect(parseRangeGlossRequest({ ...range,after:["字".repeat(1001)] }).ok).toBe(false);
    expect(parseTermRequest({ ...term,structure:"字".repeat(1001) }).ok).toBe(false);
    for (const word of ["潮，汐","潮。","潮、","潮（汐）"]) expect(parseTermRequest({ ...term,word,sentence:word }).ok).toBe(false);
    for (const body of [null,{},[],{...range,text:""},{...range,sentenceCount:0},{...range,sentenceCount:1.1}]) expect(parseRangeGlossRequest(body).ok).toBe(false);
  });
  it("段落裁剪保持源句并满足2000字预算", () => {
    const paragraphs = ["前".repeat(1500), "左".repeat(900)+"潮汐推动海水。"+"右".repeat(900), "后".repeat(1500)];
    const context = cropTermContext(paragraphs, { paraIndex:1,start:900,text:"潮汐推动海水。" });
    expect(context.current).toContain("潮汐推动海水。");
    expect(Object.values(context).reduce((n,t)=>n+countChars(t??""),0)).toBeLessThanOrEqual(2000);
  });
  it("构造器从源句取得完整目标句、最多两句邻句及示例摘要", () => {
    const paragraphs=["前一。前二。潮汐推动海水。月亮引起潮汐。后一。后二。"];
    const sentences=segmentParagraphs(paragraphs).sentences;
    const selection=normalizeSelection(paragraphs,sentences,{paraIndex:0,offset:6},{paraIndex:0,offset:7})!;
    expect(buildTermInput(selection,paragraphs,sentences,"示例摘要").word).toBe("潮汐");
    const span=normalizeSelection(paragraphs,sentences,{paraIndex:0,offset:6},{paraIndex:0,offset:18})!;
    const input=buildRangeGlossInput(span,paragraphs,sentences,"示例摘要");
    expect(input.sentenceCount).toBe(2); expect(input.before).toEqual(["前一。","前二。"]);
    expect(input.after).toEqual(["后一。","后二。"]); expect(input.structure).toBe("示例摘要");
  });
});
describe("整句复用严格优先级", () => {
  const all={saved:"留下",session:{text:"本会话",complete:true},automatic:"自动",sample:"示例"};
  it.each(["saved","session","automatic","sample"] as const)("命中 %s 不需请求", source => {
    const sources={...all};
    for(const key of ["saved","session","automatic","sample"] as const) { if(key===source) break; delete (sources as Partial<typeof all>)[key]; }
    expect(resolveWholeSentenceReuse({kind:"sentence"},sources)).toEqual({status:"reuse",source,text:source==="session"?"本会话":all[source]});
  });
  it("未完成会话被跳过；全部未命中交给单句链路",()=>{
    expect(resolveWholeSentenceReuse({kind:"sentence"},{session:{text:"半截",complete:false},sample:"示例"})).toEqual({status:"reuse",source:"sample",text:"示例"});
    expect(resolveWholeSentenceReuse({kind:"sentence"},{})).toEqual({status:"single-sentence-required"});
    expect(resolveWholeSentenceReuse({kind:"range"},all)).toEqual({status:"not-whole"});
  });
});
