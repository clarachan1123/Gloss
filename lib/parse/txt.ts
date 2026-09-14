import { ParseError, assembleDocument, type ParseFormat, type ParsedDocument } from "./validate";

/** 在浏览器内读取并解码 .txt，不上传任何内容 */
export async function parseTxt(file: File): Promise<ParsedDocument> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new ParseError("A3");
  }
  return plainTextToDocument(decodeText(bytes), "txt", file.name);
}

/**
 * 编码判定：
 * 1. 有 BOM 时按 BOM（UTF-8 / UTF-16LE / UTF-16BE），并去掉 BOM；
 * 2. 无 BOM 时先按 UTF-8 严格解码，失败再按 GB18030（兼容 GBK / GB2312）严格解码；
 * 3. 都失败 → A3（无法读取）。严格模式保证不会把错误编码解成乱码后静默继续。
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeStrict("utf-8", bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeStrict("utf-16le", bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeStrict("utf-16be", bytes.subarray(2));
  }
  try {
    return decodeStrict("utf-8", bytes);
  } catch {
    return decodeStrict("gb18030", bytes);
  }
}

function decodeStrict(encoding: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ParseError("A3");
  }
}

/** 纯文本（txt 或粘贴）→ 段落：按换行拆分，丢弃只含空白的行，行内容原样保留 */
export function plainTextToDocument(
  raw: string,
  format: ParseFormat,
  fileName: string | null,
): ParsedDocument {
  const paragraphs = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return assembleDocument({ paragraphs, headings: [], footnotes: [] }, format, fileName);
}
