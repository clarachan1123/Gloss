import {
  ParseError,
  assembleDocument,
  type ParsedDocument,
  type ParsedFootnote,
  type ParsedHeading,
} from "./validate";

/**
 * mammoth 生成的 id 前缀。脚注引用节点形如：
 *   <sup><a id="{ID_PREFIX}footnote-ref-{id}" href="#{ID_PREFIX}footnote-{id}">[n]</a></sup>
 * 脚注正文位于文末 <ol> 的 <li id="{ID_PREFIX}footnote-{id}">。尾注同理（endnote）。
 * 只按这对结构化属性识别脚注，不用正则去匹配正文里的 [1]、¹ 等文字。
 */
const ID_PREFIX = "gloss-docx-";
const NOTE_REF_ID = new RegExp(`^${ID_PREFIX}(footnote|endnote)-ref-(-?\\d+)$`);
const NOTE_ID = new RegExp(`^${ID_PREFIX}(footnote|endnote)-(-?\\d+)$`);

/** 在浏览器内解析 .docx（mammoth → HTML → DOM），不上传任何内容 */
export async function parseDocx(file: File): Promise<ParsedDocument> {
  let mammoth: typeof import("mammoth");
  try {
    ({ default: mammoth } = await import("mammoth"));
  } catch {
    // 组件没加载下来（通常是断网），不是文件的问题
    throw new ParseError("LOAD");
  }

  let html: string;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        idPrefix: ID_PREFIX,
        // 只要文字：图片不转 base64
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      },
    );
    html = result.value;
  } catch {
    throw new ParseError("A3");
  }
  return htmlToDocument(html, file.name);
}

function htmlToDocument(html: string, fileName: string): ParsedDocument {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;

  // 软回车 <br> 按分段处理：先换成 \n，下面按 \n 拆成段落
  body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));

  // 脚注 / 尾注：先按引用顺序收集，再从正文中剥离引用节点
  const footnotes: ParsedFootnote[] = [];
  body.querySelectorAll<HTMLAnchorElement>("sup > a[id]").forEach((anchor) => {
    const ref = NOTE_REF_ID.exec(anchor.id);
    if (!ref || anchor.getAttribute("href") !== `#${ID_PREFIX}${ref[1]}-${ref[2]}`) return;
    const inTable = anchor.closest("table") !== null;
    const note = doc.getElementById(`${ID_PREFIX}${ref[1]}-${ref[2]}`);
    if (!inTable) {
      footnotes.push({ marker: String(footnotes.length + 1), text: note ? noteText(note) : "" });
    }
    anchor.parentElement?.remove();
  });
  body.querySelectorAll("li[id]").forEach((li) => {
    if (!NOTE_ID.test(li.id)) return;
    const list = li.parentElement;
    li.remove();
    if (list && list.children.length === 0) list.remove();
  });

  // A10：剔除表格（公式 OMML 不被 mammoth 转换，已在上一步自然剔除）
  body.querySelectorAll("table").forEach((table) => table.remove());

  const paragraphs: string[] = [];
  const headings: ParsedHeading[] = [];
  body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li").forEach((el) => {
    if (el.tagName !== "LI" && el.closest("li")) return;
    const heading = /^H([1-6])$/.exec(el.tagName);
    // 每段软回车之间是一个自然段；连续软回车产生的空段丢弃。段首全角空格原样保留。
    for (const text of blockText(el).split("\n")) {
      if (text.trim() === "") continue;
      if (heading) {
        headings.push({ paraIndex: paragraphs.length, level: Number(heading[1]), text });
      }
      paragraphs.push(text);
    }
  });

  return assembleDocument({ paragraphs, headings, footnotes }, "docx", fileName);
}

/** 块级元素的文字（软回车已是 \n）；列表项不含其嵌套子列表 */
function blockText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("ul, ol").forEach((list) => list.remove());
  return clone.textContent ?? "";
}

/** 脚注正文：去掉 mammoth 追加的「↑」回跳链接 */
function noteText(li: Element): string {
  const clone = li.cloneNode(true) as Element;
  clone.querySelectorAll("a[href]").forEach((a) => {
    if (NOTE_REF_ID.test((a.getAttribute("href") ?? "").slice(1))) a.remove();
  });
  const blocks = Array.from(clone.querySelectorAll("p, h1, h2, h3, h4, h5, h6"));
  const text = blocks.length > 0 ? blocks.map((b) => b.textContent ?? "").join("\n") : clone.textContent ?? "";
  return text.trim();
}
