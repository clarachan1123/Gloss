// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ANALYTICS_LOCAL_KEY, ANALYTICS_OPTOUT_KEY, emitAnalytics } from "@/lib/analytics-events";
import AnalyticsCollector from "./AnalyticsCollector";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

type Sent = { eventId: string; event: string }[];
const outbox = (): Sent => JSON.parse(localStorage.getItem(ANALYTICS_LOCAL_KEY) ?? "{}").outbox ?? [];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
const beaconMock = vi.fn((_url: string, _data?: BodyInit | null) => true);
const fetched = (): Sent[] => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).events);
const beaconed = async (): Promise<Sent[]> =>
  Promise.all(beaconMock.mock.calls.map(async ([, data]) => JSON.parse(await (data as Blob).text()).events));
const emitClicks = (count: number) => {
  for (let index = 0; index < count; index++) emitAnalytics({ event: "report_error_click", sentenceIndex: index });
};
const settle = () => act(async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); });

let root: Root;
let container: HTMLElement;
let tick: () => void;

beforeEach(async () => {
  localStorage.clear();
  nav.pathname = "/";
  fetchMock.mockClear();
  beaconMock.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beaconMock });
  vi.spyOn(window, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback;
    return 1;
  }) as unknown as typeof window.setInterval);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(AnalyticsCollector)); });
  // 挂载时 visitAnalytics 记下 reader_first_seen。
  expect(outbox().map((event) => event.event)).toEqual(["reader_first_seen"]);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  Reflect.deleteProperty(document, "hidden");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("G-15a 上报管道（浏览器端）", () => {
  it("满 10 条立即发送一次，204 后清出队列", async () => {
    emitClicks(9);
    await settle();
    expect(fetched().map((batch) => batch.length)).toEqual([10]);
    expect(outbox()).toEqual([]);
  });

  it("不满 10 条时等 30 秒定时发送", async () => {
    emitClicks(2);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    tick();
    await settle();
    expect(fetched().map((batch) => batch.length)).toEqual([3]);
    expect(outbox()).toEqual([]);
  });

  it("页面隐藏与站内跳转时用 sendBeacon 冲刷，记录留到 fetch 收到 204 才删除", async () => {
    emitClicks(2);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    nav.pathname = "/read/local-only";
    await act(async () => { root.render(createElement(AnalyticsCollector)); });
    expect((await beaconed()).map((batch) => batch.length)).toEqual([3, 3]);
    expect(beaconMock.mock.calls.every(([url]) => url === "/api/analytics")).toBe(true);
    expect(outbox()).toHaveLength(3);
  });
});

describe("G-15b 退出开关清空队列", () => {
  it("同页写入：下一次检查即清空；删除开关后不补发", async () => {
    emitClicks(2);
    const queued = outbox().map((event) => event.eventId);
    localStorage.setItem(ANALYTICS_OPTOUT_KEY, "1");
    tick();
    await settle();
    expect(outbox()).toEqual([]);
    emitClicks(3);
    expect(outbox()).toEqual([]);

    localStorage.removeItem(ANALYTICS_OPTOUT_KEY);
    tick();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    const sentIds = [...fetched(), ...(await beaconed())].flat().map((event) => event.eventId);
    expect(sentIds.filter((id) => queued.includes(id))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it("另一标签页写入：storage 事件到达时立即清空", async () => {
    emitClicks(2);
    localStorage.setItem(ANALYTICS_OPTOUT_KEY, "1");
    expect(outbox()).toHaveLength(3);
    window.dispatchEvent(new StorageEvent("storage", { key: ANALYTICS_OPTOUT_KEY, newValue: "1" }));
    expect(outbox()).toEqual([]);

    localStorage.removeItem(ANALYTICS_OPTOUT_KEY);
    tick();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("清空只动 outbox，不动首用日、回访与文档标记", async () => {
    const before = JSON.parse(localStorage.getItem(ANALYTICS_LOCAL_KEY)!);
    localStorage.setItem(ANALYTICS_OPTOUT_KEY, "1");
    tick();
    const after = JSON.parse(localStorage.getItem(ANALYTICS_LOCAL_KEY)!);
    expect(after).toEqual({ ...before, outbox: [] });
  });
});
