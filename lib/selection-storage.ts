import { StorageError } from "./storage";
import { comparePoints, selectionText, type SourcePoint } from "./selection";
export const SELECTION_SAVED_PREFIX = "gloss:selection-saved:";

const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
const rotateRight = (value: number, shift: number) => (value >>> shift) | (value << (32 - shift));

/** 安全上下文没有 Web Crypto 时仍能校验本地保存的原文哈希。 */
export async function hashSelectionSource(value: string, subtle: Pick<SubtleCrypto, "digest"> | null = globalThis.crypto?.subtle ?? null): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // 部分浏览器暴露了 subtle，但在当前页面来源拒绝 digest；继续用本地实现。
    }
  }
  const bitLength = bytes.length * 8;
  const bitLengthHigh = Math.floor(bitLength / 0x100000000);
  const bitLengthLow = bitLength >>> 0;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  for (let i = 0; i < 4; i++) {
    padded[paddedLength - 1 - i] = (bitLengthLow >>> (i * 8)) & 0xff;
    padded[paddedLength - 5 - i] = (bitLengthHigh >>> (i * 8)) & 0xff;
  }
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((padded[offset + i * 4] << 24) | (padded[offset + i * 4 + 1] << 16) | (padded[offset + i * 4 + 2] << 8) | padded[offset + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotateRight(w[i - 15], 7) ^ rotateRight(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotateRight(w[i - 2], 17) ^ rotateRight(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + sum1 + choose + SHA256_K[i] + w[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
  }
  return h.map(word => word.toString(16).padStart(8, "0")).join("");
}

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
    if(await hashSelectionSource(selectionText(paragraphs,entry.start,entry.end))===entry.sourceHash&&!out.some(r=>selectionIdentity(r)===selectionIdentity(entry)))out.push(entry);
  }
  return out.sort((a,b)=>comparePoints(a.start,b.start)||a.savedAt-b.savedAt);
}
/** 同区间同种类复用已有记录；其他区间独立追加，写成功后调用方才更新界面。 */
export async function saveSavedSelection(docId:string,paragraphs:readonly string[],entry:SavedSelection):Promise<SavedSelection> {
  if(!valid(entry)||await hashSelectionSource(selectionText(paragraphs,entry.start,entry.end))!==entry.sourceHash)throw new StorageError("E2");
  const values=entries(docId),prior=values.find(r=>selectionIdentity(r)===selectionIdentity(entry)&&r.sourceHash===entry.sourceHash);
  if(prior)return prior;
  write(docId,[...values.filter(r=>selectionIdentity(r)!==selectionIdentity(entry)),entry]);return entry;
}
export function removeSavedSelection(docId:string,entry:SavedSelection):void {
  write(docId,entries(docId).filter(r=>selectionIdentity(r)!==selectionIdentity(entry)));
}
