import { StorageError } from "./storage";
import { comparePoints, selectionText, type SourcePoint } from "./selection";
import { sha256 } from "./cache";
export const SELECTION_SAVED_PREFIX = "gloss:selection-saved:";
export interface SavedSelection {
  resultKind: "term" | "range"; start: SourcePoint; end: SourcePoint; sourceHash: string;
  text: string; savedAt: number; promptVersion: string; model: string;
}
export function selectionIdentity(value: Pick<SavedSelection,"resultKind"|"start"|"end">): string {
  return [value.resultKind,value.start.paraIndex,value.start.offset,value.end.paraIndex,value.end.offset].join(":");
}
const point=(v:unknown):v is SourcePoint=>!!v&&typeof v==="object"&&
  Number.isSafeInteger((v as SourcePoint).paraIndex)&&(v as SourcePoint).paraIndex>=0&&Number.isSafeInteger((v as SourcePoint).offset)&&(v as SourcePoint).offset>=0;
function valid(v:unknown):v is SavedSelection {
  if(!v||typeof v!=="object")return false;const r=v as SavedSelection;
  return (r.resultKind==="term"||r.resultKind==="range")&&point(r.start)&&point(r.end)&&comparePoints(r.start,r.end)<0&&
    typeof r.sourceHash==="string"&&/^[a-f0-9]{64}$/.test(r.sourceHash)&&typeof r.text==="string"&&!!r.text.trim()&&
    Number.isFinite(r.savedAt)&&r.savedAt>=0&&typeof r.promptVersion==="string"&&typeof r.model==="string";
}
function storage():Storage {try{if(!globalThis.localStorage)throw Error();return globalThis.localStorage;}catch(e){throw new StorageError("E2",e);}}
function entries(docId:string):SavedSelection[] {
  const raw=storage().getItem(SELECTION_SAVED_PREFIX+docId);if(!raw)return [];
  try{const r=JSON.parse(raw);return r?.version===1&&Array.isArray(r.entries)?r.entries.filter(valid):[];}catch{return [];}
}
function write(docId:string,values:SavedSelection[]) {
  try{storage().setItem(SELECTION_SAVED_PREFIX+docId,JSON.stringify({version:1,entries:values}));}
  catch(e){if(e instanceof StorageError)throw e;const name=(e as {name?:string})?.name;throw new StorageError(name==="QuotaExceededError"||name==="NS_ERROR_DOM_QUOTA_REACHED"?"E1":"E2",e);}
}
/** 只读独立记录并逐条核对原文；不重写旧单句数据，也不静默清理损坏记录。 */
export async function loadSavedSelections(docId:string,paragraphs:readonly string[]):Promise<SavedSelection[]> {
  const out:SavedSelection[]=[];
  for(const entry of entries(docId)){
    if(entry.end.paraIndex>=paragraphs.length||entry.start.offset>paragraphs[entry.start.paraIndex].length||entry.end.offset>paragraphs[entry.end.paraIndex].length)continue;
    if(await sha256(selectionText(paragraphs,entry.start,entry.end))===entry.sourceHash&&!out.some(r=>selectionIdentity(r)===selectionIdentity(entry)))out.push(entry);
  }
  return out.sort((a,b)=>comparePoints(a.start,b.start)||a.savedAt-b.savedAt);
}
/** 同区间同种类复用已有记录；其他区间独立追加，写成功后调用方才更新界面。 */
export async function saveSavedSelection(docId:string,paragraphs:readonly string[],entry:SavedSelection):Promise<SavedSelection> {
  if(!valid(entry)||await sha256(selectionText(paragraphs,entry.start,entry.end))!==entry.sourceHash)throw new StorageError("E2");
  const values=entries(docId),prior=values.find(r=>selectionIdentity(r)===selectionIdentity(entry)&&r.sourceHash===entry.sourceHash);
  if(prior)return prior;
  write(docId,[...values.filter(r=>selectionIdentity(r)!==selectionIdentity(entry)),entry]);return entry;
}
export function removeSavedSelection(docId:string,entry:SavedSelection):void {
  write(docId,entries(docId).filter(r=>selectionIdentity(r)!==selectionIdentity(entry)));
}
