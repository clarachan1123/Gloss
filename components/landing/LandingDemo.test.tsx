// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
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
