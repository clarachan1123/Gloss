import { describe, expect, it } from "vitest";
import { SelectionOutput } from "./selection-stream";
import { GlossOutput } from "./output";
function collect(output: {push(text:string):string[];end():string[]}, text:string) {
  const out:string[]=[]; for(const ch of text) out.push(...output.push(ch)); out.push(...output.end()); return out.join("");
}
describe("划选输出管线",()=>{
  it("默认上限和显式150输出逐字一致",()=>{
    for(const raw of ["# 标题\n**正文**。","【无法处理】原因","甲".repeat(180),"⟦潮汐⟧的变化。","😀 ".repeat(170)])
      expect(collect(new GlossOutput(),raw)).toBe(collect(new GlossOutput(150),raw));
  });
  it("语境120字、范围动态上限，空白与代理对口径不变",()=>{
    for(const [kind,limit,marker] of [["term",120,"【无法作答】"],["range",300,"【无法处理】"],["range",600,"【无法处理】"]] as const){
      const output=new SelectionOutput(kind,"",limit,marker);
      const text=collect(output,"# 标题\n"+"😀".repeat(700));
      expect([...text].length).toBe(limit); expect(output.truncated).toBe(true);
    }
  });
  it("两种拒答标记跨字符到达仍完全拦截",()=>{
    for(const [kind,marker] of [["term","【无法作答】"],["range","【无法处理】"]] as const){
      const output=new SelectionOutput(kind,"",120,marker);
      expect(collect(output,marker+"不应放出")).toBe(""); expect(output.refused).toBe(true);
    }
  });
  it("范围术语逐字校验、去重、六字与三个不同词上限",()=>{
    const source="潮汐月亮海水地球太阳七个字的长术语";
    const output=new SelectionOutput("range",source,600,"【无法处理】");
    expect(collect(output,"⟦潮汐⟧、⟦潮汐⟧、⟦不存在⟧、⟦七个字的长术语⟧、⟦月亮⟧、⟦海水⟧、⟦地球⟧。"))
      .toBe("⟦潮汐⟧、潮汐、不存在、七个字的长术语、⟦月亮⟧、⟦海水⟧、地球。");
  });
  it("词语解释清除全部术语标记，未闭合标记不会暴露",()=>{
    expect(collect(new SelectionOutput("term","潮汐",120,"【无法作答】"),"⟦潮汐⟧推动⟦海水")).toBe("潮汐推动海水");
  });
});
