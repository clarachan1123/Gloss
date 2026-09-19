// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleDocument, type ParseFormat } from "./parse/validate";
import { segmentParagraphs } from "./segment";
import {
  StorageError,
  computeDocId,
  loadDocument,
  loadReadingPosition,
  loadSavedGlosses,
  loadStructure,
  removeSavedGloss,
  saveDocument,
  saveReadingPosition,
  saveSavedGloss,
  saveStructure,
} from "./storage";

const make = (paragraphs: string[], fileName: string | null = "a.docx", format: ParseFormat = "docx") =>
  assembleDocument({ paragraphs, headings: [], footnotes: [] }, format, fileName);

const docKeys = () => Object.keys(localStorage).filter((k) => k.startsWith("gloss:doc:"));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ---------------- docId：书架主键 ---------------- */

describe("docId 是书架主键，必须稳定", () => {
  it("固定内容 → 固定 id（写死的基准值：算法、编码或拼接方式一变就会失败）", async () => {
    expect(await computeDocId(["卡尔·马克思", "序言", "　　我考察资产阶级经济制度是按照以下的次序。"])).toBe(
      "e61d8bfb",
    );
    expect(await computeDocId(["甲。", "乙。"])).toBe("66a608b3");
  });

  it("等于 SHA-256(paragraphs.join('\\n')) 的前 8 位 hex，与 Node crypto 一致", async () => {
    const paragraphs = ["一段。", "　　二段，含全角空格与 English。"];
    const expected = createHash("sha256").update(paragraphs.join("\n"), "utf8").digest("hex").slice(0, 8);
    expect(await computeDocId(paragraphs)).toBe(expected);
    expect(await computeDocId(paragraphs)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("重复计算结果不变", async () => {
    const paragraphs = ["甲。", "乙。"];
    expect(await computeDocId(paragraphs)).toBe(await computeDocId([...paragraphs]));
  });

  it("只由内容决定：文件名、格式不同，id 相同", async () => {
    const fromDocx = await saveDocument(make(["甲。", "乙。"], "序言.docx", "docx"));
    const fromPaste = await saveDocument(make(["甲。", "乙。"], null, "paste"));
    expect(fromDocx).toBe(fromPaste);
  });

  it("内容或段落顺序不同，id 不同", async () => {
    const ids = await Promise.all([
      computeDocId(["甲。", "乙。"]),
      computeDocId(["乙。", "甲。"]),
      computeDocId(["甲。", "乙！"]),
    ]);
    expect(new Set(ids).size).toBe(3);
  });
});

/* ---------------- 文档存取 ---------------- */

describe("文档存取", () => {
  it("存进去再读出来一致；不存 text 和 sentences", async () => {
    const doc = assembleDocument(
      {
        paragraphs: ["序言", "　　正文第一句。第二句。"],
        headings: [{ paraIndex: 0, level: 3, text: "序言" }],
        footnotes: [{ marker: "1", text: "一条脚注" }],
      },
      "docx",
      "序言.docx",
    );
    const docId = await saveDocument(doc);

    expect(loadDocument(docId)).toMatchObject({
      docId,
      paragraphs: doc.paragraphs,
      headings: doc.headings,
      footnotes: doc.footnotes,
      meta: doc.meta,
    });
    const raw = JSON.parse(localStorage.getItem(`gloss:doc:${docId}`) ?? "{}");
    expect(raw).not.toHaveProperty("text");
    expect(raw).not.toHaveProperty("sentences");
  });

  it("同一文档重复上传只有一个条目", async () => {
    await saveDocument(make(["甲。", "乙。"]));
    await saveDocument(make(["甲。", "乙。"], "改了名字.docx"));
    expect(docKeys()).toHaveLength(1);
  });

  it("找不到返回 null", () => {
    expect(loadDocument("00000000")).toBeNull();
  });

  it("数据损坏按不存在处理，并留警告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("gloss:doc:deadbeef", "{broken");
    expect(loadDocument("deadbeef")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("存储已满 → StorageError E1", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    await expect(saveDocument(make(["甲。"]))).rejects.toMatchObject({ name: "StorageError", code: "E1" });
  });

  it("写入被拒绝（非配额原因）→ StorageError E2", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    await expect(saveDocument(make(["甲。"]))).rejects.toMatchObject({ code: "E2" });
  });

  it("存储不可用 → 保存与读取都报 StorageError E2", async () => {
    vi.stubGlobal("localStorage", undefined);
    await expect(saveDocument(make(["甲。"]))).rejects.toMatchObject({ code: "E2" });
    expect(() => loadDocument("00000000")).toThrow(StorageError);
  });
});

/* ---------------- 阅读位置 ---------------- */

describe("阅读位置存句序号", () => {
  it("存 17 读 17；未保存为 null", () => {
    expect(loadReadingPosition("aaaa0000")).toBeNull();
    saveReadingPosition("aaaa0000", 17);
    expect(loadReadingPosition("aaaa0000")).toBe(17);
  });

  it("按 docId 隔离", () => {
    saveReadingPosition("aaaa0000", 3);
    saveReadingPosition("bbbb0000", 9);
    expect(loadReadingPosition("aaaa0000")).toBe(3);
    expect(loadReadingPosition("bbbb0000")).toBe(9);
  });

  it("重复上传同一文档不会重置阅读位置", async () => {
    const docId = await saveDocument(make(["甲。", "乙。"]));
    saveReadingPosition(docId, 1);
    await saveDocument(make(["甲。", "乙。"]));
    expect(loadReadingPosition(docId)).toBe(1);
  });

  it.each(["-3", "1.5", "abc", ""])("非法值 %j 按未保存处理", (value) => {
    localStorage.setItem("gloss:pos:aaaa0000", value);
    expect(loadReadingPosition("aaaa0000")).toBeNull();
  });

  it("保存失败不抛错，只留警告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(() => saveReadingPosition("aaaa0000", 1)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

/* ---------------- 全书结构摘要（G-07） ---------------- */

describe("全书结构摘要按 docId 缓存，每份文档只算一次", () => {
  it("存进去什么，读出来什么", () => {
    saveStructure("aaaa0000", "structure-v1", "一本书的结构摘要。");
    expect(loadStructure("aaaa0000", "structure-v1")).toBe("一本书的结构摘要。");
  });

  it("按 docId 区分，互不覆盖", () => {
    saveStructure("aaaa0000", "structure-v1", "甲书。");
    saveStructure("bbbb0000", "structure-v1", "乙书。");
    expect(loadStructure("aaaa0000", "structure-v1")).toBe("甲书。");
    expect(loadStructure("bbbb0000", "structure-v1")).toBe("乙书。");
    expect(loadStructure("cccc0000", "structure-v1")).toBeNull();
  });

  it("提示词版本变了，旧摘要作废", () => {
    saveStructure("aaaa0000", "structure-v1", "旧摘要。");
    expect(loadStructure("aaaa0000", "structure-v2")).toBeNull();
  });

  it.each(["不是 JSON", "null", JSON.stringify({ version: 1, prompt: "structure-v1" }), JSON.stringify({ version: 99, prompt: "structure-v1", structure: "摘要。" })])(
    "数据损坏或结构不对（%s）按没有处理",
    (raw) => {
      localStorage.setItem("gloss:structure:aaaa0000", raw);
      expect(loadStructure("aaaa0000", "structure-v1")).toBeNull();
    },
  );

  it("存储不可用时读不到也不抛错", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadStructure("aaaa0000", "structure-v1")).toBeNull();
  });

  it("保存失败不抛错，只留警告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(() => saveStructure("aaaa0000", "structure-v1", "摘要。")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

/* ---------------- 跳过信息随文档存取（G-25） ---------------- */

describe("meta.skipped 随文档存取，老记录照常打开", () => {
  it("docx 的表格 / 公式写进 meta，读出来一模一样", async () => {
    const doc = assembleDocument({ paragraphs: ["甲。"], headings: [], footnotes: [] }, "docx", "a.docx", undefined, {
      tableCount: 1,
      tableChars: 62,
      hasFormula: true,
    });
    const docId = await saveDocument(doc);
    expect(loadDocument(docId)?.meta.skipped).toEqual({ tableCount: 1, tableChars: 62, hasFormula: true });
  });

  it("PDF 的扫描页页码写进 meta", async () => {
    const doc = assembleDocument({ paragraphs: ["甲。"], headings: [], footnotes: [] }, "pdf", "a.pdf", 2, {
      scannedPages: [2],
    });
    const docId = await saveDocument(doc);
    expect(loadDocument(docId)?.meta).toMatchObject({ pageCount: 2, skipped: { scannedPages: [2] } });
  });

  it("没跳过任何东西时不写这一项", async () => {
    const docId = await saveDocument(make(["甲。"]));
    expect(loadDocument(docId)?.meta.skipped).toBeUndefined();
  });

  it("G-25 之前保存的记录（没有 meta.skipped）照常打开，不报错、不当作不存在", () => {
    const record = {
      version: 1,
      docId: "old00000",
      paragraphs: ["甲。", "乙。"],
      headings: [],
      footnotes: [],
      meta: { format: "docx", fileName: "旧书.docx", charCount: 4 },
      savedAt: 1,
    };
    localStorage.setItem("gloss:doc:old00000", JSON.stringify(record));
    const loaded = loadDocument("old00000");
    expect(loaded?.paragraphs).toEqual(["甲。", "乙。"]);
    expect(loaded?.meta.skipped).toBeUndefined();
  });
});

describe("G-10a 保存白话身份", () => {
  const docId = "saved000";
  const savedKey = `gloss:saved:${docId}`;

  it("只在 docId、段落、起点与原句 hash 都一致时显示，并保留术语定界符原样文本", async () => {
    const paragraphs = ["甲。乙。"];
    const sentence = segmentParagraphs(paragraphs).sentences[1];
    await saveSavedGloss(docId, sentence, "〔乙〕就是第二句。");
    const visible = await loadSavedGlosses(docId, segmentParagraphs(paragraphs).sentences);
    expect(visible.get(1)?.text).toBe("〔乙〕就是第二句。");
    expect(JSON.parse(localStorage.getItem(savedKey) ?? "{}").entries[0]).toMatchObject({
      paraIndex: 0,
      start: 2,
      kind: "saved",
    });
  });

  it("起点不存在或同起点 hash 不同都隐藏，原记录不删除", async () => {
    const original = segmentParagraphs(["甲。乙。"]).sentences[1];
    await saveSavedGloss(docId, original, "保存版");

    expect(await loadSavedGlosses(docId, segmentParagraphs(["甲。"]).sentences)).toEqual(new Map());
    expect(localStorage.getItem(savedKey)).not.toBeNull();
    expect(await loadSavedGlosses(docId, segmentParagraphs(["甲。丙。乙。"]).sentences)).toEqual(new Map());
    expect(localStorage.getItem(savedKey)).not.toBeNull();
  });

  it("重复句只匹配各自的段内起点，全局句序号变化不参与持久身份", async () => {
    const paragraphs = ["重复。重复。"];
    const original = segmentParagraphs(paragraphs).sentences;
    await saveSavedGloss(docId, original[1], "第二个重复句的保存版");

    const shiftedIndexes = original.map((sentence) => ({ ...sentence, index: sentence.index + 20 }));
    const visible = await loadSavedGlosses(docId, shiftedIndexes);
    expect(visible.size).toBe(1);
    expect(visible.get(21)?.text).toBe("第二个重复句的保存版");
    expect(visible.get(20)).toBeUndefined();
  });

  it("取消保存只删除当前句，写入失败不会伪装成已保存", async () => {
    const sentences = segmentParagraphs(["甲。乙。"]).sentences;
    await saveSavedGloss(docId, sentences[0], "甲版");
    await saveSavedGloss(docId, sentences[1], "乙版");
    await removeSavedGloss(docId, sentences[0]);
    const remaining = await loadSavedGlosses(docId, sentences);
    expect([...remaining.values()].map((entry) => entry.text)).toEqual(["乙版"]);

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
    });
    await expect(saveSavedGloss(docId, sentences[0], "不会保存")).rejects.toMatchObject({ code: "E1" });
  });
});
