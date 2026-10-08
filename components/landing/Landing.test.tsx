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
