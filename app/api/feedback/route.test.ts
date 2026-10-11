import { describe, expect, it, vi } from "vitest";
import { createFeedbackPost, FEEDBACK_KEY_PREFIX, FEEDBACK_TTL_SECONDS, type FeedbackRecord } from "./route";

const id = "27e0a50d-2c79-4ea2-b54c-ef271b21971d";
const valid = { id, body: " 测试意见 ", contact: " 微信 ", source: "reader" };
const request = (body: unknown) => new Request("http://localhost/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const mixed = "甲".repeat(997) + " \n乙";
function setup() {
  const records = new Map<string, FeedbackRecord>();
  let writes = 0;
  const set = vi.fn(async (key: string, value: FeedbackRecord, _options: { nx: true; ex: number }) => {
    if (records.has(key)) return null;
    records.set(key, value); writes++; return "OK";
  });
  const getRedis = vi.fn(() => ({ set }));
  const post = createFeedbackPost({ enabled: () => true, getRedis, now: () => new Date("2026-10-12T03:04:56.789Z") });
  return { post, set, getRedis, records, writes: () => writes };
}
describe("POST /api/feedback", () => {
  it("关闭时 503，不读取请求体也不调用 Redis", async () => {
    const req = request(valid), body = vi.spyOn(req, "body", "get"), getRedis = vi.fn();
    const post = createFeedbackPost({ enabled: () => false, getRedis });
    expect((await post(req)).status).toBe(503);
    expect(body).not.toHaveBeenCalled(); expect(getRedis).not.toHaveBeenCalled();
  });
  it("合法请求只写五字段，以 NX 和 180 天 EX 写入；服务端时间秒及毫秒为零", async () => {
    const { post, set } = setup();
    const response = await post(request(valid));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(set).toHaveBeenCalledExactlyOnceWith(FEEDBACK_KEY_PREFIX + id, {
      id, body: "测试意见", contact: "微信", source: "reader", createdAt: "2026-10-12T03:04:00.000Z",
    }, { nx: true, ex: 15_552_000 });
    expect(FEEDBACK_TTL_SECONDS).toBe(15_552_000);
    expect(Object.keys(set.mock.calls[0][1])).toEqual(["id", "body", "contact", "source", "createdAt"]);
  });
  it("重复 id 返回相同 200，仅实际写入一次", async () => {
    const { post, writes, records } = setup();
    const first = await post(request(valid)), second = await post(request(valid));
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(writes()).toBe(1); expect(records.size).toBe(1);
  });
  it.each([
    ["多键", { ...valid, docId: "not-allowed" }],
    ["少键", { id, body: valid.body, source: "reader" }],
    ["空正文", { ...valid, body: " \n " }],
    ["1001 码点", { ...valid, body: "甲".repeat(1001) }],
    ["含空格换行的1001码点", { ...valid, body: "甲" + mixed }],
    ["联系方式101码点", { ...valid, contact: "🙂".repeat(101) }],
    ["非法source", { ...valid, source: "other" }],
    ["非v4 UUID", { ...valid, id: "27e0a50d-2c79-1ea2-b54c-ef271b21971d" }],
    ["数组", []], ["null", null], ["错误类型", { ...valid, contact: null }],
  ])("%s 返回400且不取Redis", async (_, body) => {
    const { post, getRedis } = setup(); expect((await post(request(body))).status).toBe(400); expect(getRedis).not.toHaveBeenCalled();
  });
  it.each(["🙂".repeat(1000), mixed])("1000码点（含emoji或内部空白）可发送", async body => {
    const { post, set } = setup();
    expect(Array.from(body).length).toBe(1000);
    if (body.startsWith("🙂")) expect(body.length).toBe(2000);
    expect((await post(request({ ...valid, body }))).status).toBe(200);
    expect(set.mock.calls[0][1].body).toBe(body);
  });
  it.each(["landing", "shelf", "reader"])("接受来源%s", async source => {
    expect((await setup().post(request({ ...valid, source }))).status).toBe(200);
  });
  it("原始请求超过16384字节返回400且不取Redis", async () => {
    const { post, getRedis } = setup();
    const req = new Request("http://localhost/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(16_385) });
    expect((await post(req)).status).toBe(400); expect(getRedis).not.toHaveBeenCalled();
  });
  it("坏JSON或非JSON返回400", async () => {
    for (const [type, body] of [["application/json", "{"], ["text/plain", JSON.stringify(valid)]]) {
      const req = new Request("http://localhost/api/feedback", { method: "POST", headers: { "Content-Type": type }, body });
      expect((await setup().post(req)).status).toBe(400);
    }
  });
  it("无Redis凭据返回503", async () => {
    const post = createFeedbackPost({ enabled: () => true, getRedis: () => null });
    expect((await post(request(valid))).status).toBe(503);
  });
  it("Redis抛错返回503且不透出异常内容", async () => {
    const post = createFeedbackPost({ enabled: () => true, getRedis: () => ({ set: async () => { throw new Error("private error"); } }) });
    const response = await post(request(valid));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
