// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import sampleContent from "../../public/samples/shan-yu-e.json";
import LandingDemo from "./LandingDemo";

const roots: { root: ReturnType<typeof createRoot>; host: HTMLDivElement }[] = [];
afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
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
  expect(host.querySelectorAll(".landing-demo-body .sentence").length).toBe(4);
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
