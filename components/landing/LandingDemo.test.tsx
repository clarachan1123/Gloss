// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sampleContent from "../../public/samples/shan-yu-e.json";
import LandingDemo from "./LandingDemo";

vi.mock("@/components/reader/lineSplit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reader/lineSplit")>()),
  measureSplit: () => 109,
}));

const roots: { root: ReturnType<typeof createRoot>; host: HTMLDivElement }[] = [];
afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("G-52 演示只读取静态示例 JSON，不调用任何 /api/*", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const fetchMock = vi.fn(async (url: string) => {
    expect(url).toBe("/samples/shan-yu-e.json");
    return Response.json(sampleContent);
  });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 0 })); });
  for (let step = 0; step < 4; step++) await act(async () => { await Promise.resolve(); });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/samples/shan-yu-e.json"]);
  expect(host.querySelectorAll(".landing-demo-visible .sentence").length).toBe(4);
  await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 1 })); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("G-52 系统减少动态效果时首个演示状态已完整展开且无指针", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(sampleContent)));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 0 })); });
  for (let step = 0; step < 4; step++) await act(async () => { await Promise.resolve(); });
  expect(host.querySelector(".landing-demo-pointer")).toBeNull();
  expect(host.querySelector(".landing-demo-panel-play .gloss-panel-text")?.textContent).toBe(sampleContent.glosses[10]);
});

it("G-52 点击前原文完整，reveal 时才拆段并保留最终白话高度；重播复原", async () => {
  // G-57：演示改为进入视口才播放，此处模拟一挂载即可见，以下时序断言沿用 G-52
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect() {}
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(sampleContent)));
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("landing-demo-expanded-measure")) return { height: 240 } as DOMRect;
    if (this.classList.contains("landing-demo-panel-slot")) return { height: 83 } as DOMRect;
    return originalRect.call(this);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  vi.useFakeTimers();
  try {
  await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 0 })); });
  for (let step = 0; step < 4; step++) await act(async () => { await Promise.resolve(); });
  const visible = () => host.querySelector(".landing-demo-visible")!;
  const expectWhole = () => {
    expect(visible().querySelectorAll("p.reader-para")).toHaveLength(1);
    expect(visible().querySelectorAll(".sentence")).toHaveLength(4);
    expect(visible().querySelector(".landing-demo-panel-slot")).toBeNull();
    expect(host.querySelector<HTMLElement>(".landing-demo-canvas")?.style.minHeight).toBe("240px");
  };
  expectWhole();
  await act(async () => { vi.advanceTimersByTime(1_000); });
  expectWhole();
  await act(async () => { vi.advanceTimersByTime(650); });
  expectWhole();
  await act(async () => { vi.advanceTimersByTime(180); });
  expect(visible().querySelectorAll("p.reader-para")).toHaveLength(2);
  expect(visible().querySelector(".landing-demo-panel-slot")).not.toBeNull();
  expect(visible().querySelector<HTMLElement>(".landing-demo-panel-slot")?.style.height).toBe("83px");
  expect(host.querySelector<HTMLElement>(".landing-demo-canvas")?.style.minHeight).toBe("240px");
  await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 1 })); });
  expectWhole();
  } finally {
    vi.useRealTimers();
  }
});

it("G-52 白话占位覆盖阅读器 busy 态的三行最小高度", () => {
  const css = readFileSync(path.resolve(process.cwd(), "styles/landing.css"), "utf8");
  expect(css).toMatch(/\.landing-demo-stage \.gloss-panel \{ min-height: 0; \}/);
  expect(css).not.toMatch(/landing-demo-panel-measure/);
});

it("G-52 拆点测量段落继承与可见段落相同的 reader-body 样式", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(sampleContent)));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 0 })); });
  for (let step = 0; step < 4; step++) await act(async () => { await Promise.resolve(); });
  const paragraph = host.querySelector(".landing-demo-measure p");
  expect(paragraph).not.toBeNull();
  const article = paragraph!.closest("article.reader-body.landing-demo-body");
  expect(article).not.toBeNull();
  expect(article?.getAttribute("lang")).toBe(host.querySelector(".landing-demo-visible")?.getAttribute("lang"));
});


describe("G-57 演示进入视口后启动", () => {
  let notify: IntersectionObserverCallback;
  let target: Element;
  let observedOptions: IntersectionObserverInit | undefined;
  let observer: IntersectionObserver;
  const disconnect = vi.fn();

  beforeEach(() => {
    disconnect.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(sampleContent)));
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        notify = callback;
        observedOptions = options;
        observer = this as unknown as IntersectionObserver;
      }
      observe(element: Element) { target = element; }
      disconnect = disconnect;
    });
  });

  async function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push({ root, host });
    await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 0 })); });
    for (let step = 0; step < 6; step++) await act(async () => { await Promise.resolve(); });
    return { host, root };
  }

  async function visible(ratio: number, intersecting = true) {
    await act(async () => {
      notify([{ target, isIntersecting: intersecting, intersectionRatio: ratio } as IntersectionObserverEntry], observer);
    });
  }

  async function advance(ms: number) {
    await act(async () => { vi.advanceTimersByTime(ms); });
  }

  it("未报可见、不到 50% 或不相交时不播放", async () => {
    const { host } = await mount();
    expect(target).toBe(host.querySelector(".landing-demo-stage"));
    expect(observedOptions).toEqual({ threshold: 0.5 });
    await advance(10_000);
    expect(host.querySelector(".landing-demo-pointer")).toBeNull();
    await visible(0.49);
    await advance(10_000);
    await visible(0.5, false);
    await advance(10_000);
    expect(host.querySelector(".landing-demo-visible .gloss-panel")).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("可见达到 50% 后按原时序播放", async () => {
    const { host } = await mount();
    await visible(0.5);
    expect(disconnect).toHaveBeenCalledOnce();
    await advance(999);
    expect(host.querySelector(".landing-demo-pointer-waiting")).not.toBeNull();
    await advance(1);
    expect(host.querySelector(".landing-demo-pointer-moving")).not.toBeNull();
    await advance(650);
    expect(host.querySelector(".landing-demo-pointer-clicking")).not.toBeNull();
    await advance(180);
    expect(host.querySelector(".landing-demo-visible .gloss-panel")).not.toBeNull();
  });

  it("只自动启动一次；之后重播无需重新进入视口", async () => {
    const { host, root } = await mount();
    await visible(0.8);
    await advance(1_000);
    expect(host.querySelector(".landing-demo-pointer-moving")).not.toBeNull();
    await visible(0);
    await visible(0.8);
    expect(host.querySelector(".landing-demo-pointer-moving")).not.toBeNull();
    await advance(650);
    expect(host.querySelector(".landing-demo-pointer-clicking")).not.toBeNull();
    await act(async () => { root.render(createElement(LandingDemo, { replayIndex: 1 })); });
    expect(host.querySelector(".landing-demo-pointer-waiting")).not.toBeNull();
    await advance(1_000);
    expect(host.querySelector(".landing-demo-pointer-moving")).not.toBeNull();
  });

  it("没有 IntersectionObserver 时立即启动现有计时", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { host } = await mount();
    await advance(1_000);
    expect(host.querySelector(".landing-demo-pointer-moving")).not.toBeNull();
    await advance(650);
    await advance(180);
    expect(host.querySelector(".landing-demo-visible .gloss-panel")).not.toBeNull();
  });

  it("减少动态效果直接终态，无需可见通知", async () => {
    const construct = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { constructor() { construct(); } observe() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const { host } = await mount();
    expect(construct).not.toHaveBeenCalled();
    expect(host.querySelector(".landing-demo-pointer")).toBeNull();
    expect(host.querySelector(".landing-demo-visible .gloss-panel-text")?.textContent).toBe(sampleContent.glosses[10]);
  });

  it("G-57 可见通知前无指针，首次挂载即位于起点", async () => {
    const { host } = await mount();
    const canvas = host.querySelector<HTMLElement>(".landing-demo-canvas")!;
    Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 320 });
    expect(host.querySelector(".landing-demo-pointer")).toBeNull();
    await advance(10_000);
    expect(host.querySelector(".landing-demo-pointer")).toBeNull();
    await visible(0.49);
    expect(host.querySelector(".landing-demo-pointer")).toBeNull();
    const firstPositions: string[][] = [];
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("landing-demo-pointer")) {
            firstPositions.push([node.style.left, node.style.top]);
          }
        }
      }
    });
    mutations.observe(canvas, { childList: true });
    try {
      await visible(0.5);
      const pointer = host.querySelector<HTMLElement>(".landing-demo-pointer")!;
      expect(pointer).not.toBeNull();
      expect(pointer.classList.contains("landing-demo-pointer-waiting")).toBe(true);
      expect([pointer.style.left, pointer.style.top]).toEqual(["290px", "10px"]);
      expect(firstPositions).toEqual([["290px", "10px"]]);
    } finally {
      mutations.disconnect();
    }
  });

});
