// @vitest-environment happy-dom
import { act, createElement, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Landing from "./Landing";

vi.mock("./LandingDemo", () => ({ default: () => createElement("div", { "data-demo-stub": true }) }));

it("G-52 Strict Mode 重放挂载只记录一次 landing_view；次按钮只派白名单 target", async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const imported = vi.fn();
  const details: unknown[] = [];
  const listener = (event: Event) => details.push((event as CustomEvent).detail);
  window.addEventListener("gloss:analytics", listener);
  try {
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Landing, { onImport: imported, importButtonRef: createRef<HTMLButtonElement>() }))); });
    const outbox = JSON.parse(localStorage.getItem("gloss:analytics:local:v1") ?? "{}").outbox ?? [];
    expect(outbox.filter((event: { event: string }) => event.event === "landing_view")).toHaveLength(1);
    await act(async () => { host.querySelector<HTMLButtonElement>(".landing-secondary")!.click(); });
    expect(imported).toHaveBeenCalledOnce();
    expect(details).toContainEqual({ event: "landing_cta_click", target: "import" });
  } finally {
    window.removeEventListener("gloss:analytics", listener);
    await act(async () => { root.unmount(); });
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});


it("G-57 按钮及小字在 DOM 中位于演示之前，窄屏自然顺排，宽屏恢复原区域顺序", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Landing, { onImport: () => {}, importButtonRef: createRef<HTMLButtonElement>() })); });
    const actions = host.querySelector(".landing-actions")!;
    const demo = host.querySelector(".landing-demonstration")!;
    expect(actions.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.querySelector(".landing-secondary-group small")?.textContent).toBe("支持 docx、txt、文字版 PDF，也可以直接粘贴。");
    expect([...host.querySelectorAll("a, button")].map((element) => element.textContent)).toEqual(["读一段示例", "导入自己的书", "再看一遍"]);
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const css = readFileSync(path.resolve(process.cwd(), "styles/landing.css"), "utf8");
    expect(css).toMatch(/@media \(min-width: 600px\)\s*\{\s*\.landing-content \{ display: grid; grid-template-areas: "header" "demo" "actions" "supplement"; \}/);
    for (const [selector, area] of [["header", "header"], ["demonstration", "demo"], ["actions", "actions"], ["supplement", "supplement"]]) {
      expect(css).toContain(`.landing-${selector} { grid-area: ${area}; }`);
    }
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  }
});
