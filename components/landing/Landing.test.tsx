// @vitest-environment happy-dom
import { act, createElement, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Landing from "./Landing";

const demoMode = vi.hoisted(() => ({ real: false }));
vi.mock("next/font/local", () => ({ default: () => ({ className: "title-font-test" }) }));
vi.mock("./LandingDemo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./LandingDemo")>();
  return { ...actual, default: (props: Parameters<typeof actual.default>[0]) => demoMode.real ? createElement(actual.default, props) : createElement("div", { "data-demo-stub": true }) };
});
afterEach(() => { demoMode.real = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

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


it("G-73b 单组按钮在演示后，平板与电脑由网格排序，手机吸底", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Landing, { onImport: () => {}, importButtonRef: createRef<HTMLButtonElement>() })); });
    const actions = host.querySelector(".landing-actions")!;
    const demo = host.querySelector(".landing-demonstration")!;
    expect(demo.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.querySelector(".landing-secondary-group small")?.textContent).toBe("docx · txt · PDF · 粘贴");
    expect([...host.querySelectorAll("a, button")].filter(element => !element.closest("[inert]")).map((element) => element.textContent)).toEqual(["体验反馈体验反馈", "再看一遍", "读一段示例 →", "导入自己的书"]);
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const css = readFileSync(path.resolve(process.cwd(), "styles/landing.css"), "utf8");
    expect(css).toMatch(/@media \(min-width: 1000px\)/);
    expect(css).toContain("grid-template-columns: minmax(0, 5fr) minmax(0, 6fr)");
    expect(css).toContain("column-gap:72px");
    expect(css).toContain("--landing-hero-top");
    expect(css).not.toContain("padding-top: 56px");
    expect(css).toContain("max-width:1312px");
    expect(css).toContain(":root:has(.landing-page) { scrollbar-gutter: stable; }");
    expect(css).toContain("grid-template-areas");
    expect(css).not.toContain("overflow-x: hidden");
    expect(host.querySelector(".landing-header .wordmark")?.textContent).toBe("GLOSS");
    expect(host.querySelector(".landing-supplement")).toBeNull();
    expect(host.querySelector(".landing-formats")?.textContent).toContain("书和白话只存在你的浏览器里");
    expect(host.querySelector(".landing-demo-header")?.textContent).toContain("再看一遍");
    const compact = host.querySelector("ol.landing-demo-steps")!;
    expect(host.querySelector(".landing-demo-header")!.nextElementSibling).toBe(compact);
    expect(compact.nextElementSibling?.matches("[data-demo-stub]")).toBe(true);
    expect(compact.querySelector("a,button,input,[tabindex]")).toBeNull();
    const texts = ["句子太绕、结构复杂？点一下句子，原地转成大白话", "还是不懂？点「听不懂」，结合前后文讲清这一句"];
    expect([...host.querySelectorAll(".landing-step")].map(el => el.querySelector("div")?.textContent)).toEqual(texts);
    expect([...compact.querySelectorAll(".landing-demo-step-text")].map(el => el.textContent)).toEqual(["点一下句子，转成大白话", "还不懂？点「听不懂」，结合前后文讲清"]);
    for (const list of [host.querySelector(".landing-steps > ol")!, compact]) {
      expect(list.querySelectorAll("li")).toHaveLength(2);
      expect([...list.querySelectorAll("li > span:first-child")].map(el => [el.textContent, el.getAttribute("aria-hidden")])).toEqual([["1", "true"], ["2", "true"]]);
    }
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  }
});

async function mountRealLanding(reduced: boolean, resizeObserver: unknown = class { observe() {} disconnect() {} }) {
  demoMode.real = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", resizeObserver === false ? undefined : resizeObserver);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
  const { default: sample } = await import("../../public/samples/shan-yu-e.json");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(sample)));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Landing, { onImport: () => {}, importButtonRef: createRef<HTMLButtonElement>() })); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  return { host, root, sample };
}
it("G-62 同一次 act 提交指针移动与当前步骤；连播解释、重播同步复原", async () => {
  vi.useFakeTimers();
  const { host, root, sample } = await mountRealLanding(false);
  const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
  try {
    expect(host.querySelector(".landing-step-current")).toBeNull();
    expect(host.querySelector(".landing-demo-step-current")).toBeNull();
    await advance(1_000);
    expect(host.querySelector(".landing-demo-pointer-moving")).not.toBeNull();
    expect(host.querySelectorAll(".landing-step")[0].classList.contains("landing-step-current")).toBe(true);
    expect(host.querySelectorAll(".landing-demo-step")[0].getAttribute("aria-current")).toBe("step");
    expect(host.querySelectorAll(".landing-demo-step")[1].getAttribute("aria-current")).toBeNull();
    await advance(650); await advance(180);
    expect(host.querySelector(".action-row-save")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".action-row-save")?.disabled).toBe(true);
    expect(host.querySelector(".action-row-explain")?.getAttribute("aria-hidden")).toBe("true");
    for (let i = 4; i < Array.from(sample.glosses[10]).length; i += 4) await advance(45);
    expect(host.querySelector(".gloss-panel-text")?.textContent).toBe(sample.glosses[10]);
    expect(host.querySelector(".landing-demo-pointer-gloss-ready")).not.toBeNull();
    await advance(1_600);
    expect(host.querySelector(".landing-demo-pointer-explain-moving")).not.toBeNull();
    expect(host.querySelectorAll(".landing-step")[1].classList.contains("landing-step-current")).toBe(true);
    expect(host.querySelectorAll(".landing-demo-step")[1].getAttribute("aria-current")).toBe("step");
    expect(host.querySelectorAll(".landing-demo-step")[0].classList.contains("landing-demo-step-completed")).toBe(true);
    await advance(700);
    const point = host.querySelector<HTMLElement>(".landing-demo-pointer")!;
    const frozen = [point.style.left, point.style.top];
    expect(host.querySelector(".landing-demo-explain-pressed")).not.toBeNull();
    await advance(260);
    expect(host.querySelector(".explain-result-pending")?.textContent).toBe("……");
    await advance(700);
    const { DEMO_EXPLANATION } = await import("./LandingDemo");
    const chars = Array.from(DEMO_EXPLANATION);
    for (let n = 0; n < chars.length; n += 4) {
      await advance(70);
      expect(host.querySelector(".explain-result-text")?.textContent).toBe(chars.slice(0, n + 4).join(""));
      expect([point.style.left, point.style.top]).toEqual(frozen);
    }
    expect(host.querySelector(".action-row-explain")?.getAttribute("aria-disabled")).toBe("true");
    await advance(600);
    expect(host.querySelector(".landing-demo-pointer-settled")).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>(".landing-demo-header button")!.click(); });
    expect(host.querySelector(".landing-step-current")).toBeNull();
    expect(host.querySelector(".landing-demo-step-current")).toBeNull();
    expect(host.querySelector(".explain-result")).toBeNull();
    expect(host.querySelector(".landing-demo-pointer-waiting")).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("G-62 减少动态效果终态有两个 inert 演示按钮，真实入口列表仍精确", async () => {
  const { host, root } = await mountRealLanding(true);
  try {
    expect([...host.querySelectorAll("a, button")].filter(el => !el.closest("[inert]")).map(el => el.textContent)).toEqual(["体验反馈体验反馈", "再看一遍", "读一段示例 →", "导入自己的书"]);
    const buttons = [...host.querySelectorAll(".landing-demo-panel-play button")];
    expect(buttons.map(el => el.textContent)).toEqual(["留下", "听不懂"]);
    expect(buttons.every(el => !!el.closest("[inert]"))).toBe(true);
    expect(host.querySelectorAll(".landing-step")[1].classList.contains("landing-step-current")).toBe(true);
    expect(host.querySelectorAll(".landing-demo-step")[1].getAttribute("aria-current")).toBe("step");
    expect(host.querySelectorAll(".landing-demo-step")[0].classList.contains("landing-demo-step-completed")).toBe(true);
    expect(host.querySelector(".landing-demo-pointer")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each([true, false])("G-62b 隐藏步骤不写零高度并清除 positioned，恢复时重新定位（ResizeObserver=%s）", async (hasObserver) => {
  let notify: (() => void) | undefined;
  const Observer = class { constructor(callback: () => void) { notify = callback; } observe() {} disconnect() {} };
  const { host, root } = await mountRealLanding(true, hasObserver ? Observer : false);
  try {
    const steps = host.querySelector<HTMLElement>(".landing-steps")!;
    const slider = host.querySelector<HTMLElement>(".landing-step-slider")!;
    const active = steps.querySelector<HTMLElement>(".landing-step-current")!;
    let hasLayout = true;
    vi.spyOn(steps, "getClientRects").mockImplementation(() => (hasLayout ? [new DOMRect(0, 0, 400, 200)] : []) as unknown as DOMRectList);
    Object.defineProperties(active, { offsetTop: { value: 100 }, offsetHeight: { value: 80 } });
    const measure = () => hasObserver ? notify!() : window.dispatchEvent(new Event("resize"));
    measure();
    expect(slider.style.height).toBe("80px");
    expect(slider.dataset.positioned).toBe("true");
    hasLayout = false;
    measure();
    expect(slider.style.opacity).toBe("0");
    expect(slider.style.height).toBe("80px");
    expect(slider.dataset.positioned).toBeUndefined();
    hasLayout = true;
    measure();
    expect(slider.style.transform).toBe("translateY(100px)");
    expect(slider.style.height).toBe("80px");
    expect(slider.style.opacity).toBe("1");
    expect(slider.dataset.positioned).toBe("true");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("G-73b 标题只强调第二个哪句，导入弹窗隐藏按钮且关闭恢复", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const ref = createRef<HTMLButtonElement>();
  try {
    await act(async () => root.render(createElement(Landing, { onImport: () => {}, importButtonRef: ref, importOpen: true })));
    expect(host.querySelector("h1")?.textContent).toBe("哪句不懂，点哪句。");
    expect(host.querySelectorAll("h1 em")).toHaveLength(1);
    expect(host.querySelector("h1 > span:last-child em")?.textContent).toBe("哪句");
    expect(host.querySelector(".landing-page")?.classList.contains("landing-import-open")).toBe(true);
    expect(host.querySelector(".landing-action-area")?.hasAttribute("inert")).toBe(true);
    await act(async () => root.render(createElement(Landing, { onImport: () => {}, importButtonRef: ref, importOpen: false })));
    expect(host.querySelector(".landing-action-area")?.hasAttribute("inert")).toBe(false);
    expect(host.querySelectorAll(".landing-secondary")).toHaveLength(1); expect(ref.current).toBe(host.querySelector(".landing-secondary"));
  } finally { await act(async () => root.unmount()); host.remove(); }
});
