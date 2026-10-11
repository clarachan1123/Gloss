import { MAX_DOCUMENT_CHARS, type StructureRequest } from "./context";
import { countChars } from "./parse/validate";

const PARTS = 10;
const HEADING_BUDGET = 5_000;

/** Slice by the server's non-whitespace Unicode code-point count, retaining whitespace. */
function countedSlice(text: string, from: number, to: number): string {
  let count = 0;
  let result = "";
  for (const char of text) {
    const counted = !/\s/.test(char);
    if (count >= to) break;
    if (count >= from) result += char;
    if (counted) count++;
  }
  return result;
}

function sampleHeadings(headings: string[]): string[] {
  if (headings.reduce((sum, text) => sum + countChars(text), 0) <= HEADING_BUDGET) return headings;
  // Reduce an evenly spaced set until the complete headings fit; preserve their order.
  for (let size = Math.min(headings.length, HEADING_BUDGET); size > 0; size--) {
    const selected = Array.from({ length: size }, (_, i) =>
      headings[size === 1 ? 0 : Math.floor(i * (headings.length - 1) / (size - 1))]);
    if (selected.reduce((sum, text) => sum + countChars(text), 0) <= HEADING_BUDGET) return selected;
  }
  return [];
}

/** Short inputs retain exactly the existing JSON fields and strings. Long inputs cover ten equal character ranges. */
export function buildStructureInput(input: StructureRequest): StructureRequest {
  const lengths = input.paragraphs.map(countChars);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= MAX_DOCUMENT_CHARS) return input;
  const headings = sampleHeadings(input.headings);
  const headingChars = headings.reduce((sum, heading) => sum + countChars(heading), 0);
  const budget = Math.floor((MAX_DOCUMENT_CHARS - headingChars - countChars(input.title ?? "")) / PARTS);
  const paragraphs: string[] = [];
  let index = 0;
  let start = 0;
  for (let part = 0; part < PARTS; part++) {
    const from = Math.floor(total * part / PARTS);
    const to = Math.floor(total * (part + 1) / PARTS);
    while (index < lengths.length && start + lengths[index] <= from) start += lengths[index++];
    let remaining = budget;
    let cursor = index;
    let offset = start;
    let first = true;
    while (cursor < lengths.length && offset < to && remaining > 0) {
      // Align normal range heads to the containing paragraph, keeping it complete.
      // Only a paragraph larger than the range budget uses the exact character head.
      const oversized = lengths[cursor] > budget;
      const localFrom = oversized ? Math.max(0, from - offset) : 0;
      const localTo = oversized ? Math.min(lengths[cursor], to - offset) : lengths[cursor];
      const length = localTo - localFrom;
      if (length > 0) {
        // Only an oversized first paragraph is cut to the budget. Later paragraphs remain whole.
        if (length > remaining && !first) break;
        const taken = Math.min(length, remaining);
        const text = localFrom === 0 && localTo === lengths[cursor] && taken === length
          ? input.paragraphs[cursor]
          : countedSlice(input.paragraphs[cursor], localFrom, localFrom + taken);
        paragraphs.push(text);
        remaining -= taken;
        first = false;
      }
      offset += lengths[cursor++];
    }
  }
  return { title: input.title, headings, paragraphs };
}
