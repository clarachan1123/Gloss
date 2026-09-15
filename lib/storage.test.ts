// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleDocument, type ParseFormat } from "./parse/validate";
import {
  StorageError,
  computeDocId,
  loadDocument,
  loadReadingPosition,
  saveDocument,
  saveReadingPosition,
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
