/** G-69: production service :3482, invalid key, CDP-only fixed generation. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
process.env.G19_IMPORT_ONLY = '1';
const { Cdp, freePort } = await import('./verify-g19.mjs');
const ORIGIN = process.env.G69_ORIGIN ?? 'http://127.0.0.1:3482';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const COLORS = { parchment: ['#1F4E75', '#E7E9E6'], 'moon-white': ['#1F4E75', '#E4E8ED'], 'eye-green': ['#14446B', '#DCE4E0'], dark: ['#C4DAF0', '#252524'] };
const WIDTHS = [375, 506, 768, 1024, 1280];
const DISPLACEMENT_ONLY = process.env.G69_DISPLACEMENT_ONLY === '1';
const DIAGNOSTIC_WIDTH = Number(process.env.G69_DISPLACEMENT_WIDTH ?? 506);
const BASELINE_RECORD = process.env.G69_BASELINE_RECORD === '1';
const BASELINE_PASS = Number(process.env.G69_BASELINE_PASS ?? 1);
const BASELINE_WIDTHS = (process.env.G69_BASELINE_WIDTHS ?? WIDTHS.join(',')).split(',').map(Number);
const BASELINE_PATH = process.env.G69_BASELINE_FILE ?? resolve(import.meta.dirname, '../tmp-g69-baseline.json');
const baselineReport = (!DISPLACEMENT_ONLY || BASELINE_RECORD) ? await readFile(BASELINE_PATH,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;}) : null;
if(BASELINE_RECORD)assertBaselineFile();
function assertBaselineFile(){if(!baselineReport)throw Error('Baseline report required');}
if(baselineReport)baselineReport.criterion='工作副本与对照副本（main 85f36fd）同一场景逐字 dx、dy 完全相等；main 两遍不稳定时，必须等于其中某一遍实测值。';
let currentCase = null;
const capturedCases = [];
const baselineCases = new Map((baselineReport?.scenes??[]).map(row=>[row.caseId,row]));
const FIXED = '这段本地白话用于观察生成期间的句子高亮，每次返回相同的文字，不连接任何模型服务。';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
const evaluate = (c, fn, ...args) => c.evaluate(`(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`);
const rgb = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
let scenarios = 0;
const records = [];
async function wait(c, expression, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { await healthy(c); if (await c.evaluate('Boolean(' + expression + ')')) return; await sleep(100); }
  throw Error('Timeout: ' + label);
}
async function healthy(c) {
  const state = await c.evaluate('({hidden:document.hidden,everHidden:window.__g69?.hidden,error:window.__g69?.error})');
  assert(!state.hidden && !state.everHidden && !state.error, 'Visible error-free page', state);
  const { targetInfos } = await c.call('Target.getTargets');
  assert(targetInfos.filter(t => t.type === 'page').length === 1, 'Exactly one page');
}
async function frames(c, count = 2) {
  await c.evaluate(`new Promise(resolve=>{let left=${count};const tick=()=>{if(--left<=0)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick)})`);
  await healthy(c);
}
async function settle(c) { await sleep(400); await frames(c); }
function setup(theme, displacementOnly = false) {
  localStorage.setItem('gloss:analytics:optout', '1');
  localStorage.setItem('gloss:settings:theme', theme === 'dark' ? 'parchment' : theme);
  localStorage.setItem('gloss:settings:appearance', theme === 'dark' ? 'dark' : 'light');
  localStorage.setItem('gloss:settings:reading-mode', 'reading');
  localStorage.removeItem('gloss:sample:breathed');
  const s = window.__g69 = { hidden: document.hidden, events: [], frames: [], tracking: null, error: null, fail: false, aborts: 0, measurementChecks: 0 };
  s.displacementOnly = displacementOnly;
  s.scrollWrites = [];
  s.captureScroll = false;
  s.rawGlyph = key => {
    const [para, offset] = key.split(':').map(Number);
    for (const span of document.querySelectorAll('[data-para="'+para+'"] .sentence')) {
      const start=Number(span.dataset.offset),node=span.firstChild;
      if(!(node instanceof Text)||offset<start||offset>=start+node.length)continue;
      const range=document.createRange();range.setStart(node,offset-start);range.setEnd(node,offset-start+Array.from(node.data.slice(offset-start))[0].length);
      const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left});
      const panelsAbove=[...document.querySelectorAll('.reader-body .gloss-panel')].map(panel=>{const r=panel.getBoundingClientRect();return{id:panel.dataset.sentenceIndex,height:r.height,top:r.top,bottom:r.bottom,state:panel.dataset.state};}).filter(panel=>panel.bottom<=range.getBoundingClientRect().top);
      const generationState=[...document.querySelectorAll('.reader-body .gloss-panel')].map(panel=>[panel.dataset.sentenceIndex,panel.dataset.state]);
      return {panelsAbove,generationState,scrollY:window.scrollY,scrollTop:document.scrollingElement.scrollTop,clientRects:[...range.getClientRects()].map(rect),bounding:rect(range.getBoundingClientRect()),bodyTranslate:getComputedStyle(document.querySelector('.reader-body')).translate};
    }
    throw Error('Lost diagnostic glyph '+key);
  };
  if(displacementOnly) {
    const record=(method,target,args,run)=>{
      if(!s.captureScroll)return run();
      const item={method,target:target===window?'window':target===document.scrollingElement?'document.scrollingElement':target.tagName,args:args.map(v=>v&&typeof v==='object'?JSON.parse(JSON.stringify(v)):v),stack:new Error().stack.split('\n').slice(1,9),before:{scrollY:window.scrollY,scrollTop:document.scrollingElement.scrollTop}};
      try{return run();}finally{item.after={scrollY:window.scrollY,scrollTop:document.scrollingElement.scrollTop};s.scrollWrites.push(item);}
    };
    for(const [owner,names] of [[window,['scrollTo','scrollBy']],[Element.prototype,['scrollTo','scrollBy','scrollIntoView']]])for(const name of names){
      const original=owner[name];if(typeof original!=='function')continue;
      owner[name]=function(...args){return record((owner===window?'window.':'Element.')+name,this,args,()=>Reflect.apply(original,this,args));};
    }
    let owner=Element.prototype;while(owner&&!Object.getOwnPropertyDescriptor(owner,'scrollTop'))owner=Object.getPrototypeOf(owner);
    const descriptor=Object.getOwnPropertyDescriptor(owner,'scrollTop');
    Object.defineProperty(owner,'scrollTop',{...descriptor,set:function(value){return record('scrollTop setter',this,[value],()=>descriptor.set.call(this,value));}});
  }
  addEventListener('visibilitychange', () => { if (document.hidden) { s.hidden = true; s.error = 'document hidden'; } });
  for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
    if (type === 'click' && s.tracking) s.tracking.armed = true;
    s.events.push({ type, pointerType: event.pointerType ?? null, index: event.target.closest?.('.sentence')?.dataset.index ?? null, trusted: event.isTrusted });
  }, true);
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const response = await nativeFetch(input, options);
    if (!String(input).endsWith('/api/gloss') || !response.ok) return response;
    const text = await response.text();
    let position = 0, timer;
    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          if (options?.signal?.aborted) { s.aborts++; controller.close(); return; }
          if (position >= text.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(text.slice(position, position += 4)));
          timer = setTimeout(send, 120);
        };
        timer = setTimeout(send, 120);
      },
      cancel() { clearTimeout(timer); s.aborts++; },
    });
    return new Response(stream, { status: 200, headers: response.headers });
  };
  s.glyphs = () => {
    const result = [];
    for (const span of document.querySelectorAll('.reader-body .sentence')) {
      const node = span.firstChild, para = span.closest('[data-para]');
      if (!(node instanceof Text) || !para) continue;
      let offset = 0;
      for (const char of node.data) {
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + char.length);
        const r = range.getBoundingClientRect();
        result.push({ key: para.dataset.para + ':' + (Number(span.dataset.offset) + offset), index: Number(span.dataset.index), char, x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom });
        offset += char.length;
      }
    }
    return result;
  };
  s.visible = () => s.glyphs().filter(g => g.char.trim() && g.y >= (innerWidth < 768 ? document.querySelector('.col-left').getBoundingClientRect().bottom : 0) && g.bottom <= innerHeight);
  s.inspect = expected => {
    if (s.displacementOnly) return [];
    const indices = [...new Set([...document.querySelectorAll('.reader-body .sentence-active')].map(el => Number(el.dataset.index)))].sort((a,b)=>a-b);
    if (JSON.stringify(indices) !== JSON.stringify([...expected].sort((a,b)=>a-b))) throw Error('Activity membership: ' + JSON.stringify({ indices, expected }));
    for (const index of expected) {
      const pieces = [...document.querySelectorAll('.reader-body .sentence[data-index="' + index + '"]')];
      if (!pieces.length || pieces.some(p => !p.classList.contains('sentence-active'))) throw Error('Missing active fragment ' + index);
    }
    for (const p of document.querySelectorAll('.reader-tail-placeholder')) {
      if (p.matches('.sentence,[data-index],[data-offset],.sentence-active') || getComputedStyle(p).backgroundColor !== 'rgba(0, 0, 0, 0)') throw Error('Colored placeholder');
    }
    if (document.querySelector('.reader-body')?.dataset.measuring === 'true') s.measurementChecks++;
    return indices;
  };
  s.begin = (expected, waitForClick = false) => {
    if (s.tracking) throw Error('Overlapping frame tracker');
    const track = s.tracking = { expected, armed: !waitForClick, frames: [], geometryFrames: [], stop: false, raf: null, error: null, count: 0 };
    const tick = () => {
      if (track.stop) return;
      if (!track.armed) { if (++track.count >= 180) { track.stop = true; return; } track.raf = requestAnimationFrame(tick); return; }
      try { s.inspect(track.expected); } catch (error) { track.error ??= error.message; }
      track.frames.push(s.glyphs());
      if(s.diagnosticGlyphKey)track.geometryFrames.push(s.rawGlyph(s.diagnosticGlyphKey));
      if (++track.count >= 180) { track.stop = true; return; }
      track.raf = requestAnimationFrame(tick);
    };
    track.raf = requestAnimationFrame(tick);
  };
  s.end = () => { const t = s.tracking; t.stop = true; cancelAnimationFrame(t.raf); s.tracking = null; return { error: t.error, frames: t.frames, geometryFrames:t.geometryFrames, count: t.count }; };
}
async function navigate(c, path) {
  let handler, timer;
  const loaded = new Promise((resolve, reject) => {
    handler = data => { if (JSON.parse(data).method === 'Page.domContentEventFired') resolve(); };
    c.socket.on('message', handler); timer = setTimeout(() => reject(Error('Navigation DOMContentLoaded timeout')), 20000);
  });
  try { await c.call('Page.navigate', { url: ORIGIN + path }); await loaded; await c.call('Page.bringToFront'); }
  finally { clearTimeout(timer); c.socket.off('message', handler); }
  await healthy(c);
}
async function ready(c) {
  await wait(c, "document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"11\"]')", 'reader'); await settle(c);
}
async function inspect(c, expected, theme, stable = true) {
  if (DISPLACEMENT_ONLY || BASELINE_RECORD) return;
  await evaluate(c, expected => window.__g69.inspect(expected), expected);
  const colors = await evaluate(c, expected => expected.flatMap(index => [...document.querySelectorAll('.sentence[data-index="'+index+'"]')].map(el => {
    const css = getComputedStyle(el); return { index, color: css.color, background: css.backgroundColor, properties: css.transitionProperty };
  })), expected);
  for (const color of colors) {
    assert(color.background === rgb(COLORS[theme][1]), 'Active background', color);
    if (stable) assert(color.color === rgb(COLORS[theme][0]), 'Active foreground', color);
    assert(!color.properties.split(',').some(p => ['background-color','all'].includes(p.trim())), 'No background transition', color);
  }
}
async function align(c, index, partial = false) {
  await evaluate(c, (index, partial) => {
    const glyphs = __g69.glyphs().filter(g => g.index === index && g.char.trim());
    if (!glyphs.length) throw Error('Missing sentence ' + index);
    if (innerWidth < 768) dispatchEvent(new WheelEvent('wheel'));
    window.scrollTo({ top: scrollY + glyphs[0].y - (partial ? 0 : 150), behavior: 'instant' });
  }, index, partial); await settle(c);
}
async function input(c, point, source, index = null) {
  const start = await c.evaluate('__g69.events.length');
  if (source === 'touch') {
    await c.call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await c.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await c.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await c.call('Emulation.setTouchEmulationEnabled', { enabled: false });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.call('Input.dispatchMouseEvent', { type, ...point, pointerType: source, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  const events = await evaluate(c, start => __g69.events.slice(start), start);
  const click = events.find(event => event.type === 'click');
  assert(click?.pointerType === source && click.trusted && (index === null || click.index === String(index)), 'Native click source', { source, index, events });
  return events;
}
async function click(c, index, source, expected, theme, strict = true, which = 'first') {
  await align(c, index);
  const selected = await evaluate(c, (index, which) => {
    const glyphs = __g69.glyphs().filter(g => g.index === index && g.char.trim());
    const g = glyphs[which === 'last' ? glyphs.length - 1 : which === 'middle' ? Math.floor(glyphs.length/2) : 0];
    const top = innerWidth < 768 ? document.querySelector('.col-left').getBoundingClientRect().bottom : 0;
    if (glyphs.some(g => g.y < top || g.bottom > innerHeight)) throw Error('Main sentence must be fully visible: ' + JSON.stringify({index,top,scrollY,first:glyphs[0],last:glyphs.at(-1)}));
    return g;
  }, index, which);
  const diagnosticBefore = (DISPLACEMENT_ONLY || BASELINE_RECORD || baselineReport) ? await evaluate(c, key => { __g69.scrollWrites=[];__g69.diagnosticGlyphKey=key;const before=__g69.rawGlyph(key);__g69.captureScroll=true;return before; }, selected.key) : null;
  await evaluate(c, expected => __g69.begin(expected, true), expected);
  let trace;
  try {
    await input(c, { x: selected.x + Math.min(selected.width / 2, 4), y: selected.y + selected.height / 2 }, source, index);
    await frames(c, 1); await inspect(c, expected, theme, false); await settle(c);
  } finally { trace = await c.evaluate('__g69.end()'); }
  assert(!trace.error, 'No missing active frame', trace.error);
  if (strict && !DISPLACEMENT_ONLY && !BASELINE_RECORD && !baselineReport) for (const frame of trace.frames) {
    const current = frame.find(g => g.key === selected.key); assert(current && current.x === selected.x && current.y === selected.y, 'Clicked glyph strict zero', { selected, current });
  }
  await inspect(c, expected, theme); scenarios++;
  if (DISPLACEMENT_ONLY || BASELINE_RECORD || baselineReport) {
    const diagnosticAfter=await evaluate(c,key=>{__g69.captureScroll=false;return{after:__g69.rawGlyph(key),writes:__g69.scrollWrites};},selected.key);
    const after=diagnosticAfter.after;
    const observation={index,source,which,key:selected.key,before:diagnosticBefore,after,dx:after.bounding.x-diagnosticBefore.bounding.x,dy:after.bounding.y-diagnosticBefore.bounding.y,writes:diagnosticAfter.writes,geometryFrames:trace.geometryFrames,frameDeltas:trace.frames.map(frame=>{const current=frame.find(g=>g.key===selected.key);return{dx:current.x-selected.x,dy:current.y-selected.y};})};
    if(!DISPLACEMENT_ONLY || BASELINE_RECORD){
      const caseId=[currentCase.width,currentCase.theme,++currentCase.ordinal,index,source,which,selected.key].join('|');
      const row={caseId,...observation};capturedCases.push(row);
      if(!BASELINE_RECORD&&strict&&process.env.G69_LAYOUT_ONLY!=='1')assertCriterionA(row,baselineCases.get(caseId));
    }
    return observation;
  }
}
async function escape(c) {
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await settle(c); await evaluate(c, () => __g69.inspect([]));
}
async function mode(c, label) {
  await evaluate(c, label => { const button = [...document.querySelectorAll('.mode-option')].find(b => b.textContent.trim() === label); if (!button) throw Error('Missing mode '+label); button.click(); }, label); await settle(c);
}
async function saved(c, index, save) {
  await wait(c, `!!document.querySelector('.gloss-panel[data-sentence-index="${index}"] .action-row-save:not(:disabled)')`, 'save action');
  await evaluate(c, index => document.querySelector('.gloss-panel[data-sentence-index="'+index+'"] .action-row-save').click(), index);
  await wait(c, `document.querySelector('.gloss-panel[data-sentence-index="${index}"]')?.classList.contains('gloss-panel-saved')===${save}`, 'save transition'); await settle(c);
}
function compare(before, after) {
  if(DISPLACEMENT_ONLY)return;
  const map = new Map(after.map(g => [g.key, g]));
  for (const b of before) { const a = map.get(b.key); assert(a && ['x','y','width','height'].every(k => a[k] === b[k]), 'Visible glyph strict zero', { before: b, after: a }); }
}
async function paintOnly(c, theme) {
  await wait(c, "document.querySelector('.gloss-panel[data-sentence-index=\"0\"] .action-row-save:not(:disabled)')", 'paint fixture done');
  const before = await c.evaluate('__g69.visible()');
  for (const enabled of [false, true]) {
    await evaluate(c, enabled => document.querySelectorAll('.sentence[data-index="0"]').forEach(el => el.classList.toggle('sentence-active', enabled)), enabled);
    await frames(c); compare(before, await c.evaluate('__g69.visible()')); scenarios++;
  }
  const stable = await evaluate(c, () => [...document.querySelectorAll('.sentence[data-index="0"]')].map(el => {
    const s = getComputedStyle(el); return ['fontWeight','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','padding','margin','lineHeight','textDecoration'].map(k => s[k]);
  }));
  for (const target of Object.keys(COLORS)) {
    const framesBefore = await c.evaluate('__g69.visible()');
    await evaluate(c, () => __g69.begin([0]));
    let trace;
    try { await evaluate(c, target => {
      localStorage.setItem('gloss:settings:theme', target === 'dark' ? 'parchment' : target);
      localStorage.setItem('gloss:settings:appearance', target === 'dark' ? 'dark' : 'light');
      dispatchEvent(new Event('gloss:theme-change')); dispatchEvent(new Event('gloss:appearance-change'));
    }, target); await settle(c); } finally { trace = await c.evaluate('__g69.end()'); }
    assert(!trace.error, 'Theme retains activity'); for (const frame of trace.frames) compare(framesBefore, frame);
    await inspect(c, [0], target); scenarios++;
  }
  await evaluate(c, () => document.querySelectorAll('.sentence[data-index="0"]').forEach(el => el.classList.remove('sentence-active'))); await settle(c);
  const inactive = await evaluate(c, () => [...document.querySelectorAll('.sentence[data-index="0"]')].map(el => { const s = getComputedStyle(el); return ['fontWeight','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','padding','margin','lineHeight','textDecoration'].map(k => s[k]); }));
  if(!DISPLACEMENT_ONLY)assert(JSON.stringify(stable) === JSON.stringify(inactive), 'Only paint properties change');
  await evaluate(c, () => document.querySelectorAll('.sentence[data-index="0"]').forEach(el => el.classList.add('sentence-active')));
  await evaluate(c, theme => { localStorage.setItem('gloss:settings:theme', theme === 'dark' ? 'parchment' : theme); localStorage.setItem('gloss:settings:appearance', theme === 'dark' ? 'dark' : 'light'); dispatchEvent(new Event('gloss:theme-change')); }, theme); await settle(c);
}
async function hover(c, theme) {
  await click(c, 0, 'mouse', [], theme);
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 850 }); await settle(c);
  const before = await c.evaluate('__g69.visible()');
  const panelPoint = await evaluate(c, () => { const r = document.querySelector('.gloss-panel[data-sentence-index="0"]').getBoundingClientRect(); return { x: r.left + 16, y: r.top + 10 }; });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...panelPoint }); await settle(c);
  if(!BASELINE_RECORD) assert(await evaluate(c, expected => [...document.querySelectorAll('.sentence[data-index="0"]')].every(el => el.classList.contains('sentence-gloss-hover') && getComputedStyle(el).color === expected) && !document.querySelector('.sentence-active'), rgb(COLORS[theme][0])), 'G-57 panel hover');
  compare(before, await c.evaluate('__g69.visible()'));
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 850 }); await settle(c);
  assert(await c.evaluate("!document.querySelector('.sentence-gloss-hover')"), 'G-57 leave');
  await escape(c); scenarios++;
}
async function offscreen(c, theme, direction) {
  await evaluate(c, () => {
    const body = document.querySelector('.reader-body');
    for (const [index, first] of [[900, true], [901, false]]) {
      const block=document.createElement('p');block.dataset.g69Reference='';block.dataset.para=String(index);block.style.cssText='height:1800px;margin:0;position:relative';
      for(let n=0;n<18;n++) {
        const span=document.createElement('span');span.className='sentence';span.dataset.index=String(index);span.dataset.offset=String(n*7);span.textContent='可见参照原文。';span.style.cssText='position:absolute;left:0;top:'+(n*100)+'px';block.append(span);
      }
      if(first)body.prepend(block);else body.append(block);
    }
  });
  await settle(c);
  await click(c, 4, 'touch', [4], theme); await settle(c);
  if (direction === 'down') {
    await evaluate(c, () => { const p = document.querySelector('.gloss-panel[data-sentence-index="4"]'); window.scrollBy({ top: p.getBoundingClientRect().bottom - innerHeight + 1, behavior: 'instant' }); }); await settle(c);
    if(!BASELINE_RECORD) assert(await c.evaluate("!!document.querySelector('.sentence-active[data-index=\"4\"]')&&!!document.querySelector('.gloss-panel[data-sentence-index=\"4\"]')"), 'G-46 panel still visible retains activity');
  }
  const trace = await evaluate(c, async direction => {
    const body = document.querySelector('.reader-body');
    const blocks = [...body.querySelectorAll('[data-para="2"]')], panel = document.querySelector('.gloss-panel[data-sentence-index="4"]');
    const bounds = [...blocks, panel].map(e=>e.getBoundingClientRect());
    window.scrollBy({ top: direction === 'down' ? Math.max(...bounds.map(r=>r.bottom)) + 60 : Math.min(...bounds.map(r=>r.top)) - innerHeight - 60, behavior:'instant' });
    const samples = [{glyphs: __g69.visible(), panel: !!document.querySelector('.gloss-panel[data-sentence-index="4"]')}];
    for (let n=0;n<30;n++) { await new Promise(r=>requestAnimationFrame(r)); samples.push({ glyphs: __g69.visible(), panel: !!document.querySelector('.gloss-panel[data-sentence-index="4"]') }); }
    return samples;
  }, direction);
  const closed = trace.findIndex(t => !t.panel); assert(closed >= 0, 'Offscreen closed');
  assert(trace[0].glyphs.length > 0, 'Offscreen visible references', {direction,closed,samples:trace.map(t=>({panel:t.panel,glyphCount:t.glyphs.length}))});
  for (const sample of trace) compare(trace[0].glyphs, sample.glyphs);
  await evaluate(c,()=>document.querySelectorAll('[data-g69-reference]').forEach(el=>el.remove()));
  await evaluate(c, () => __g69.inspect([])); scenarios++;
}
async function negatives(c, theme) {
  if(BASELINE_RECORD){
    await click(c,0,'touch',[0],theme);
    await wait(c,"document.querySelector('.gloss-panel[data-sentence-index=\"0\"] .action-row-save:not(:disabled)')",'negative fixture');
    await escape(c);await click(c,0,'mouse',[],theme);await escape(c);return [];
  }
  await click(c, 0, 'touch', [0], theme); await wait(c, "document.querySelector('.gloss-panel[data-sentence-index=\"0\"] .action-row-save:not(:disabled)')", 'negative fixture');
  const values = [];
  async function detects(label, inject, check, restore) {
    await evaluate(c, inject); let detected = false;
    try { await check(); } catch { detected = true; }
    await evaluate(c, restore); await settle(c); assert(detected, 'Negative control detected: '+label); values.push({ label, detected }); scenarios++;
  }
  await detects('missing-background', () => { const s=document.createElement('style');s.id='g69-negative';s.textContent='.reader-body .sentence.sentence-active{background-color:transparent!important}';document.head.append(s); }, () => inspect(c,[0],theme), () => document.querySelector('#g69-negative').remove());
  await detects('missing-fragment', () => { const s=document.querySelector('.sentence[data-index="0"]'),n=s.firstChild,half=Math.floor(n.length/2),t=n.splitText(half),p=document.createElement('span');p.className='sentence';p.dataset.index='0';p.dataset.offset=String(Number(s.dataset.offset)+half);s.after(p);p.append(t);p.id='g69-negative'; }, () => inspect(c,[0],theme), () => { const p=document.querySelector('#g69-negative');p.previousElementSibling.append(p.firstChild);p.previousElementSibling.normalize();p.remove(); });
  const before=await c.evaluate('__g69.visible()');
  await detects('padding-drift', () => { document.querySelector('.sentence[data-index="0"]').style.paddingLeft='1px'; }, async () => compare(before,await c.evaluate('__g69.visible()')), () => document.querySelector('.sentence[data-index="0"]').style.removeProperty('padding-left'));
  await escape(c);
  await detects('closed-residue', () => document.querySelector('.sentence[data-index="0"]').classList.add('sentence-active'), () => evaluate(c,()=>__g69.inspect([])), () => document.querySelector('.sentence[data-index="0"]').classList.remove('sentence-active'));
  await click(c,0,'mouse',[],theme);
  await detects('mouse-activity', () => document.querySelector('.sentence[data-index="0"]').classList.add('sentence-active'), () => evaluate(c,()=>__g69.inspect([])), () => document.querySelector('.sentence[data-index="0"]').classList.remove('sentence-active'));
  await escape(c); return values;
}
function acceptedPasses(reference){
  return reference.passes ? [reference.passes['1'],reference.passes['2']].filter(Boolean) : [reference];
}
function assertCriterionA(actual, reference){
  assert(reference,'Missing same-scenario baseline',actual.caseId);
  const alternatives=acceptedPasses(reference);
  const matches=alternatives.filter(base=>actual.dx===base.dx&&actual.dy===base.dy);
  assert(matches.length>0,'Clicked glyph equals main baseline',{caseId:actual.caseId,actual:[actual.dx,actual.dy],main:alternatives.map(base=>[base.dx,base.dy])});
  const state=JSON.stringify(actual.before.generationState);
  const knownStates=alternatives.filter(base=>Array.isArray(base.before.generationState)).map(base=>JSON.stringify(base.before.generationState));
  assert(knownStates.includes(state),'Same generation state as main',actual.caseId);
  assert(matches.some(base=>{const allowed=new Set(base.frameDeltas.map(d=>JSON.stringify(d)));return actual.frameDeltas.every(d=>allowed.has(JSON.stringify(d)));}),'Clicked glyph per-frame equality with one main pass',{caseId:actual.caseId,actual:actual.frameDeltas,main:matches.map(base=>base.frameDeltas)});
}
function classification(row){
  const all=[row.before,...(row.geometryFrames??[]),row.after];
  const frames=all.slice(1).map((frame,i)=>{
    const previous=all[i],beforeHeight=(previous.panelsAbove??[]).reduce((sum,p)=>sum+p.height,0),afterHeight=(frame.panelsAbove??[]).reduce((sum,p)=>sum+p.height,0);
    return {glyphDy:frame.bounding.y-previous.bounding.y,abovePanelHeightDeltaSum:afterHeight-beforeHeight,bodyTranslateBefore:previous.bodyTranslate,bodyTranslateAfter:frame.bodyTranslate,scrollYBefore:previous.scrollY,scrollYAfter:frame.scrollY,panelsAbove:frame.panelsAbove??[]};
  });
  const heightDelta=frames.reduce((sum,f)=>sum+f.abovePanelHeightDeltaSum,0);
  const translateY=value=>{const parts=value==='none'?[]:value.trim().split(/\s+/);return parseFloat(parts[1]??'0')||0;};
  const translateDelta=translateY(row.after.bodyTranslate)-translateY(row.before.bodyTranslate);
  const category=row.dx===0&&row.dy!==0&&row.dy===heightDelta&&frames.every(f=>f.glyphDy===f.abovePanelHeightDeltaSum)?'= 上方面板同帧增高':row.dx===0&&row.dy!==0&&row.dy===translateDelta&&heightDelta===0?'亚像素 translate 取整':'其他';
  return {category,abovePanelHeightDeltaSum:heightDelta,bodyTranslate:[row.before.bodyTranslate,row.after.bodyTranslate],scrollY:[row.before.scrollY,row.after.scrollY],frames};
}
function updateBaseline(){
  const merged=new Map(baselineReport.scenes.map(row=>[row.caseId,row]));
  for(const row of capturedCases){
    const old=merged.get(row.caseId),passes={...(old?.passes??(old?{'1':old}:{}))};passes[String(BASELINE_PASS)]={...row,classification:classification(row)};
    const first=passes['1'],second=passes['2'];
    merged.set(row.caseId,{...(first??row),passes,unstable:!!(first&&second&&(first.dx!==second.dx||first.dy!==second.dy))});
  }
  baselineReport.scenes=[...merged.values()];
  const complete=baselineReport.scenes.filter(row=>row.passes?.['1']&&row.passes?.['2']);
  baselineReport.stability={compared:complete.length,consistent:complete.filter(row=>!row.unstable).length,unstable:complete.filter(row=>row.unstable).length,total:baselineReport.scenes.length};
}
async function paddingTopNegative(c){
  const original=capturedCases.at(-1),reference=baselineCases.get(original.caseId);assert(reference,'Padding negative has real baseline');
  const changed=await evaluate(c,key=>{
    const [para,offset]=key.split(':').map(Number);const span=[...document.querySelectorAll('[data-para="'+para+'"] .sentence')].find(el=>Number(el.dataset.offset)<=offset&&Number(el.dataset.offset)+el.textContent.length>offset);const block=span.closest('[data-reader-block]'),old=block.style.paddingTop;
    const before=__g69.rawGlyph(key);block.style.paddingTop=(parseFloat(getComputedStyle(block).paddingTop)+1)+'px';
    const after=__g69.rawGlyph(key);block.style.paddingTop=old;return{before,after};
  },original.key);
  const actual={...original,dx:changed.after.bounding.x-original.before.bounding.x,dy:changed.after.bounding.y-original.before.bounding.y};actual.frameDeltas=[{dx:actual.dx,dy:actual.dy}];
  let detected=false;try{assertCriterionA(actual,reference);}catch(error){detected=error.message.startsWith('Clicked glyph equals main baseline:');}
  assert(detected,'Negative control detected: paragraph padding-top baseline mismatch',{caseId:original.caseId,delta:[actual.dx,actual.dy]});scenarios++;
  return{label:'paragraph-padding-top-baseline',detected,delta:[actual.dx,actual.dy]};
}
async function checks(c, width, theme) {
  const initial = scenarios;
  await click(c, 0, 'touch', [0], theme); const paddingNegative=BASELINE_RECORD?null:await paddingTopNegative(c); await paintOnly(c, theme); await escape(c);
  await click(c, 0, 'mouse', [], theme); await click(c, 1, 'touch', [1], theme, true, 'middle');
  await click(c, 0, 'mouse', [1], theme); await click(c, 0, 'touch', [0,1], theme);
  await click(c, 1, 'touch', [0], theme); await click(c, 3, 'pen', [3], theme); await escape(c);
  await click(c, 0, 'touch', [0], theme); await input(c, {x:1,y:850}, 'touch'); await settle(c); await evaluate(c,()=>__g69.inspect([])); scenarios++;
  await hover(c, theme);
  await click(c, 10, 'touch', [10], theme, true, 'last'); await escape(c);
  // Non-sentence programmatic and legacy clicks have no pointer source.
  for (const native of [false,true]) {
    await align(c,0); await evaluate(c,native=>{const s=document.querySelector('.sentence[data-index="0"]');if(native)s.click();else s.dispatchEvent(new MouseEvent('click',{bubbles:true}));},native); await settle(c); await evaluate(c,()=>__g69.inspect([])); await escape(c); scenarios++;
  }
  await click(c,0,'touch',[0],theme); await saved(c,0,true); await inspect(c,[0],theme); scenarios++;
  await saved(c,0,false); await inspect(c,[0],theme); scenarios++;
  await saved(c,0,true); await mode(c,'显示'); await evaluate(c,()=>__g69.inspect([])); scenarios++;
  await mode(c,'收起'); await click(c,0,'touch',[0],theme);
  assert(await c.evaluate("![...document.querySelectorAll('.sentence[data-index=\"0\"]')].some(s=>s.classList.contains('sentence-saved-collapsed'))"),'Expanded saved keeps existing underline behavior');
  await click(c,0,'touch',[],theme); await evaluate(c,()=>document.querySelector('.saved-link').click()); await settle(c); await evaluate(c,()=>__g69.inspect([])); scenarios++;
  await escape(c); await offscreen(c,theme,'down'); await offscreen(c,theme,'up');
  await click(c,1,'touch',[1],theme); await navigate(c,'/'); await wait(c,"!!document.querySelector('.landing-demo-visible')",'landing');
  assert(await c.evaluate("!document.querySelector('.sentence-active')"),'Landing unchanged / leaving cleans activity'); scenarios++;
  await navigate(c,'/read/sample'); await ready(c); await evaluate(c,()=>__g69.inspect([]));
  // Generation failures and slow streaming use a fresh local document and CDP response.
  const id='g69-'+width+'-'+theme;
  await evaluate(c,id=>{const paragraphs=['前置参照文字。','这是本地测试的一句原文，用于核对生成时的高亮。这里还有同段的第二句，供并行点开验证。','后面的参照原文保持稳定。'];localStorage.setItem('gloss:doc:'+id,JSON.stringify({version:1,docId:id,paragraphs,headings:[],footnotes:[],meta:{format:'txt',fileName:'G69.txt',charCount:paragraphs.join('').length},savedAt:1}));},id);
  await navigate(c,'/read/'+id); await wait(c,"document.querySelector('.reader-body')?.dataset.measuring==='false'&&!!document.querySelector('.sentence[data-index=\"3\"]')",'local reader');await settle(c);
  await click(c,1,'touch',[1],theme);
  assert(await c.evaluate("document.querySelector('.gloss-panel[data-sentence-index=\"1\"]').dataset.state==='busy'"),'Generation already highlighted');
  await click(c,2,'touch',[1,2],theme);await escape(c);await sleep(200);assert(await c.evaluate('__g69.aborts>0'),'Closing aborts fixed slow stream');scenarios++;
  await evaluate(c,()=>__g69.fail=true);await click(c,3,'touch',[3],theme);await wait(c,"document.querySelector('.gloss-panel[data-sentence-index=\"3\"]')?.dataset.state==='failed'",'failure panel');await inspect(c,[3],theme);await escape(c);scenarios++;
  await navigate(c,'/read/sample');await ready(c);const negative=await negatives(c,theme);
  await align(c,10,true);const before=await c.evaluate('scrollY');const point=await evaluate(c,()=>{const g=__g69.visible().find(g=>g.index===10);if(!g)throw Error('Missing clipped sentence visible glyph');return{x:g.x+2,y:g.y+g.height/2};});
  await input(c,point,'touch',10);await settle(c);const g6Scroll=await c.evaluate('scrollY')-before;await escape(c);scenarios++;
  const state=await c.evaluate('({measurementChecks:__g69.measurementChecks,hidden:__g69.hidden})');
  return {width,theme,scenarios:scenarios-initial,negative:paddingNegative?[...negative,paddingNegative]:negative,g6Scroll,...state};
}
async function displacementChecks(c, width, theme) {
  // Reproduce the preceding sentence interactions from checks(), through the old line 293.
  // All calls below measure clicked glyphs; no paint-only, color or activity criteria run.
  const measurements=[];
  const point=async(index,source,expected,which='first')=>measurements.push(await click(c,index,source,expected,theme,true,which));
  await point(0,'touch',[0]);await escape(c);
  await point(0,'mouse',[]);await point(1,'touch',[1],'middle');
  await point(0,'mouse',[1]);await point(0,'touch',[0,1]);
  await point(1,'touch',[0]);await point(3,'pen',[3]);await escape(c);
  await point(0,'touch',[0]);
  return {width,theme,displacementOnly:true,measurements,target:measurements.at(-1)};
}
async function layout(c) {
  const snapshot=()=>{const nodes=[document.querySelector('.shell'),...document.querySelectorAll('.shell *')];return nodes.filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight;}).map(el=>{const r=el.getBoundingClientRect();return[el.tagName,r.x,r.y,r.width,r.height];});};
  const before=await evaluate(c,snapshot);await click(c,0,'mouse',[],'parchment');await wait(c,"document.querySelector('.gloss-panel[data-sentence-index=\"0\"] .action-row-save:not(:disabled)')",'layout done');await settle(c);const after=await evaluate(c,snapshot);
  return { before:createHash('sha256').update(JSON.stringify(before)).digest('hex'),after:createHash('sha256').update(JSON.stringify(after)).digest('hex') };
}
async function run(width, theme) {
  currentCase={width,theme,ordinal:0};
  const profile=await mkdtemp(join(tmpdir(),'gloss-g69-edge-')),port=await freePort();
  assert(resolve(profile).startsWith(resolve(tmpdir(),'gloss-g69-')),'Safe profile');
  const edge=spawn(EDGE,['--headless=new','--disable-gpu','--no-sandbox','--no-default-browser-check','--disable-sync','--no-first-run','--remote-debugging-port='+port,'--remote-allow-origins=*','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let c,browser,passed=false;const errors=[];
  try {
    let target;const deadline=Date.now()+20000;while(Date.now()<deadline){try{target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');if(target)break;}catch{}await sleep(100);}assert(target,'Edge target');
    c=new Cdp(target.webSocketDebuggerUrl);browser=new Cdp((await(await fetch('http://127.0.0.1:'+port+'/json/version')).json()).webSocketDebuggerUrl);
    await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Network.enable');await c.call('Emulation.setFocusEmulationEnabled',{enabled:true});await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    c.socket.on('message',async data=>{const message=JSON.parse(data);if(message.method!=='Fetch.requestPaused')return;try{const {requestId,request}=message.params,path=new URL(request.url).pathname;let body,status=200,content='text/plain; charset=utf-8';if(path==='/api/gloss'){if(await c.evaluate('__g69.fail')){body=JSON.stringify({error:'api_error'});status=500;content='application/json';}else body=FIXED;}else if(path==='/api/structure'){body=JSON.stringify({structure:'本地固定结构。',prompt:'structure-v1'});content='application/json';}else throw Error('Unexpected API '+path);await c.call('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:content}],body:Buffer.from(body).toString('base64')});}catch(error){errors.push(error.message);}});
    await c.call('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]});await c.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${setup.toString()})(${JSON.stringify(theme)},${DISPLACEMENT_ONLY || BASELINE_RECORD})`});await navigate(c,'/read/sample');await ready(c);
    const result=BASELINE_RECORD?await checks(c,width,theme):DISPLACEMENT_ONLY?await displacementChecks(c,width,theme):process.env.G69_LAYOUT_ONLY==='1'?{width,theme,layout:await layout(c)}:await checks(c,width,theme);
    await healthy(c);assert(errors.length===0,'CDP interception errors',errors);records.push(result);if(BASELINE_RECORD){updateBaseline();await writeFile(BASELINE_PATH,JSON.stringify(baselineReport,null,2));}console.log(JSON.stringify(result));passed=true;
  } finally {
    try { if(browser)await browser.call('Browser.close'); } finally { if(edge.exitCode===null)await Promise.race([new Promise(r=>edge.once('exit',r)),sleep(5000)]);c?.close();browser?.close(); }
    const absolute=resolve(profile);assert(absolute.startsWith(resolve(tmpdir(),'gloss-g69-')),'Safe cleanup');
    try{await rm(absolute,{recursive:true,force:true});}catch(error){if(!passed)throw error;console.warn('Profile cleanup warning: '+error.code);}
  }
}
if(BASELINE_RECORD){assert(DISPLACEMENT_ONLY,'Baseline capture requires displacement-only mode');assert([1,2].includes(BASELINE_PASS)&&BASELINE_WIDTHS.every(width=>WIDTHS.includes(width)),'Baseline pass and widths');for(const width of BASELINE_WIDTHS)for(const theme of Object.keys(COLORS))await run(width,theme);}else if(DISPLACEMENT_ONLY){assert([375,506,768].includes(DIAGNOSTIC_WIDTH),'Diagnostic width');await run(DIAGNOSTIC_WIDTH,'parchment');}else if(process.env.G69_LAYOUT_ONLY==='1')await run(1024,'parchment');else for(const width of WIDTHS)for(const theme of Object.keys(COLORS))await run(width,theme);
if(BASELINE_RECORD&&BASELINE_PASS===2){const stats=baselineReport.stability;assert(stats.compared===stats.total&&stats.total===420,'Two complete baseline passes',stats);assert(stats.unstable/stats.total<=0.1,'Main unstable scenes exceed 10%',stats);console.log(JSON.stringify({baselineStability:stats}));}
console.log(JSON.stringify({totalScenarios:scenarios,groups:records.length,negativeDetections:records.reduce((sum,r)=>sum+(r.negative?.filter(n=>n.detected).length??0),0)}));
console.log(DISPLACEMENT_ONLY?'G-69 displacement diagnostics completed':BASELINE_RECORD?'G-69 baseline capture completed':'G-69 touch-active checks passed');
