import { comparePoints } from "@/lib/selection";
import type { Sentence as SentenceData } from "@/lib/segment";
import type { SavedGloss } from "@/lib/storage";
import { IDLE_EXPLAIN_VIEW } from "./GlossPanel";
import type { ExplainView } from "./GlossPanel";
import type { GlossShape, ReadingMode, SavedRegion, Region } from "./readerTypes";
export const EMPTY_EXPLAIN_VIEWS = new Map<number, ExplainView>();
export const NO_REGIONS: readonly Region[] = [];
export const NO_INDEXES: readonly number[] = [];

/**
 * 保存区按段结构共享：空段永远拿同一个 NO_REGIONS；保存／取消一条时，未变段继续复用
 * 上一次数组引用，Paragraph.memo 因而不会被全书无意义的空数组击穿。
 */
export function buildSavedRegionsByParagraph(
  previous: readonly (readonly Region[])[],
  paragraphCount: number,
  sentences: readonly SentenceData[],
  savedGlosses: ReadonlyMap<number, SavedGloss>,
  savedRegions: ReadonlyMap<number, SavedRegion> | null,
  glossShape: GlossShape,
  explainViews: ReadonlyMap<number, ExplainView> = EMPTY_EXPLAIN_VIEWS,
): readonly (readonly Region[])[] {
  if (savedRegions === null) return Array.from({ length: paragraphCount }, () => NO_REGIONS);
  const candidates: Region[][] = Array.from({ length: paragraphCount }, () => []);
  for (const [index, layout] of savedRegions) {
    const sentence = sentences[index];
    const saved = savedGlosses.get(index);
    if (!sentence || !saved) continue;
    const explainView = explainViews.get(index) ?? IDLE_EXPLAIN_VIEW;
    const old = previous[sentence.paraIndex]?.find((region) => region.index === index);
    candidates[sentence.paraIndex]?.push(
    old && old.splitAt === layout.splitAt && old.view.text === saved.text && old.presentation === glossShape && old.explainView === explainView
        ? old
        : {
            index,
            splitAt: layout.splitAt,
            view: { status: "done", text: saved.text, failure: null, instant: true },
            saved: true,
            presentation: glossShape,
            actionVisible: false,
            explainView,
          },
    );
  }
  return candidates.map((regions, paraIndex) => {
    if (regions.length === 0) return NO_REGIONS;
    regions.sort((a, b) => a.index - b.index);
    const old = previous[paraIndex];
    return old?.length === regions.length && old.every((region, index) => region === regions[index]) ? old : regions;
  });
}

export function buildSavedMarkersByParagraph(
  previous: readonly (readonly number[])[],
  paragraphCount: number,
  sentences: readonly SentenceData[],
  savedGlosses: ReadonlyMap<number, SavedGloss>,
  readingMode: ReadingMode,
  expandedSavedIndexes: ReadonlySet<number>,
): readonly (readonly number[])[] {
  const candidates: number[][] = Array.from({ length: paragraphCount }, () => []);
  if (readingMode === "reading") {
    for (const [index] of savedGlosses) {
      const sentence = sentences[index];
      if (sentence && !expandedSavedIndexes.has(index)) candidates[sentence.paraIndex]?.push(index);
    }
  }
  return candidates.map((indexes, paraIndex) => {
    if (indexes.length === 0) return NO_INDEXES;
    indexes.sort((a, b) => a - b);
    const old = previous[paraIndex];
    return old?.length === indexes.length && old.every((index, offset) => index === indexes[offset]) ? old : indexes;
  });
}

export function selectVisibleSavedRegions(
  regionsByParagraph: readonly (readonly Region[])[],
  readingMode: ReadingMode,
  expandedSavedIndexes: ReadonlySet<number>,
): readonly (readonly Region[])[] {
  if (readingMode === "review") return regionsByParagraph;
  return regionsByParagraph.map((regions) => {
    const visible = regions.filter((region) => expandedSavedIndexes.has(region.index));
    return visible.length === 0 ? NO_REGIONS : visible;
  });
}

// G-63：句序为唯一插入顺序；相同物理边界不再合组。
export function groupRegions(regions: readonly Region[]): ReadonlyMap<number, readonly Region[]> {
  const rank = (region: Region) => !region.selectionSlot ? 0 : region.saved ? 1 : 2;
  const ordered = [...regions].sort((a,b) => a.index-b.index || rank(a)-rank(b) ||
    (a.selectionSlot && b.selectionSlot ? comparePoints(a.selectionSlot.result.selection.start,b.selectionSlot.result.selection.start) ||
      (a.selectionSlot.result.saved?.savedAt ?? Infinity)-(b.selectionSlot.result.saved?.savedAt ?? Infinity) : 0));
  const groups = new Map<number,Region[]>();
  for (const region of ordered) groups.set(region.index,[...(groups.get(region.index)??[]),region]);
  return groups;
}
