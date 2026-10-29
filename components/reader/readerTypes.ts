import type { Ref } from "react";
import type { SelectionInput } from "@/lib/selection-context";
import type { SavedSelection } from "@/lib/selection-storage";
import type { SourceSelection } from "@/lib/selection";
import type { ParsedHeading } from "@/lib/parse/validate";
import type { Sentence as SentenceData } from "@/lib/segment";
import type { StorageErrorCode } from "@/lib/storage";
import type { ExplainView } from "./GlossPanel";
import type { GlossView } from "./GlossPanel";

/** 段内的一个句子片段：显示文本，以及它在段落显示文本中的起始偏移 */
export interface Piece {
  index: number;
  start: number;
  text: string;
  placeholder?: boolean;
}

export type GlossShape = "inline" | "bubble";
export type ReadingMode = "reading" | "review";


export interface SelectionResult {
  id: string; selection: SourceSelection; index: number; resultKind: "term" | "range";
  view: GlossView; saved: SavedSelection | null; expanded: boolean; nonMouse: boolean;
  input: SelectionInput | null; retry: number; promptVersion: string; model: string; actionsVisible?: boolean;
}
export interface SelectionSlot {
  result: SelectionResult; panelRef: Ref<HTMLDivElement>;
  onRetry: () => void; onSave: () => Promise<"saved" | "removed" | StorageErrorCode>;
  onBeforeReveal: () => CharAnchor | null; onAfterReveal: (anchor: CharAnchor | null) => void;
}

export interface SavedRegion {
  index: number;
  splitAt: number | null;
}

/** 各句在先前插入后的真实续排块中依次测量。 */
export interface Region {
  index: number;
  splitAt: number | null;
  view: GlossView;
  saved: boolean;
  presentation: GlossShape;
  actionVisible: boolean;
  explainView: ExplainView;
  glossKey?: string;
  selectionSlot?: SelectionSlot;
}

/** 视口锚点：段内某个字在 DOM 变化前的视口纵坐标。DOM 变化后把这个字滚回原位 */
export interface CharAnchor {
  paraIndex: number;
  offset: number;
  viewportTop: number;
}

/** 阅读位置锚：视口顶部所在的句子，及其首行在视口中的纵坐标 */
export interface PositionAnchor {
  index: number;
  offset: number;
  docTop: number;
  layout: string;
  measure: string;
}

export interface ParagraphProps {
  paraIndex: number;
  heading: ParsedHeading | undefined;
  pieces: Piece[];
  regions: readonly Region[];
  savedMarkers: readonly number[];
  panelRef: Ref<HTMLDivElement>;
  glossKey?: string;
  panelFor?: (index: number) => Ref<HTMLDivElement>;
  onRetry: (index: number) => void;
  onBeforeReveal: (index: number) => CharAnchor | null;
  onAfterReveal: (anchor: CharAnchor | null) => void;
  onSave: (index: number) => Promise<"saved" | "removed" | StorageErrorCode>;
  onExplain: (index: number) => void;
  onExplainRetry: (index: number) => void;
  onExplainBlocked: (index: number) => void;
  sentences: readonly SentenceData[];
  breatheSentenceIndex: number | null;
  activeIndexes?: readonly number[];
}
