import type { ParsedHeading } from "./validate";

const CHINESE_NUMBER = "零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟";
const NUMBER = `[0-9${CHINESE_NUMBER}]+`;
const FAMILIES = [
  new RegExp(`^[◇◆■□●○]?第${NUMBER}[编篇部卷]`),
  new RegExp(`^第${NUMBER}章`),
  new RegExp(`^第${NUMBER}节`),
  new RegExp(`^第${NUMBER}\\s+`),
  new RegExp(`^[${CHINESE_NUMBER}]+[、．.]`),
  new RegExp(`^(?:（[${CHINESE_NUMBER}]+）|\\([${CHINESE_NUMBER}]+\\))`),
  /^(?:\d+[、．]|\d+\.(?!\d))/,
  /^\d+\.\d+/,
  /^[A-Z](?:\s+|、)/,
];
const KEYWORD = new RegExp(
  `^(?:绪论|绪言|序言|序|导言|引言|导论|结论|结语|附录|后记|跋|自序|前言)(?:\\s+.{1,20}|[${CHINESE_NUMBER}]{1,2})?$`,
  "u",
);
const BAD_END = /[。！？；：，、…!?;:,]$/u;
const SHORT_PUNCTUATION = /[，。、；：！？,.;:!?（）()「」“”"…—]/u;
const length = (text: string) => Array.from(text).length;

/** 导入时在空白归一化之前识别；只标记段落，绝不改写正文。 */
export function detectHeadings(paragraphs: readonly string[]): ParsedHeading[] {
  const trimmed = paragraphs.map((text) => text.trim());
  const candidates = trimmed.map((text) => {
    if (!text || length(text) > 30 || text.includes("。") || BAD_END.test(text)) return null;
    if (KEYWORD.test(text)) return { family: -1 };
    const family = FAMILIES.findIndex((pattern) => pattern.test(text));
    return family < 0 ? null : { family };
  });
  const counts = new Map<number, number>();
  for (const candidate of candidates) {
    if (candidate && candidate.family >= 0) {
      counts.set(candidate.family, (counts.get(candidate.family) ?? 0) + 1);
    }
  }
  const retained = candidates.flatMap((candidate, paraIndex) => {
    if (!candidate) return [];
    const { family } = candidate;
    if (family >= 0 && ((counts.get(family) ?? 0) < 2 ||
      candidates[paraIndex - 1]?.family === family || candidates[paraIndex + 1]?.family === family)) return [];
    return [{ paraIndex, family }];
  });
  const families = [...new Set(retained.filter((item) => item.family >= 0).map((item) => item.family))]
    .sort((a, b) => a - b);
  const headings: ParsedHeading[] = retained.map(({ paraIndex, family }) => ({
    paraIndex, level: family < 0 ? 1 : families.indexOf(family) + 1, text: paragraphs[paraIndex],
  }));
  if (headings.length >= 2) {
    const marked = new Set(headings.map((heading) => heading.paraIndex));
    const level = Math.max(...headings.map((heading) => heading.level)) + 1;
    trimmed.forEach((text, paraIndex) => {
      if (marked.has(paraIndex) || candidates[paraIndex] || !text || length(text) > 20 || SHORT_PUNCTUATION.test(text) ||
        length(trimmed[paraIndex + 1] ?? "") < 40) return;
      headings.push({ paraIndex, level, text: paragraphs[paraIndex] });
    });
  }
  return headings.sort((a, b) => a.paraIndex - b.paraIndex);
}
