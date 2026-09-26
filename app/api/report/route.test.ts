import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createReportPost, REPORT_KEY_PREFIX, REPORT_TTL_SECONDS, type ReportRecord } from "./route";

const sentence = "这是一句用于测试的原文。";
const hash = createHash("sha256").update(sentence, "utf8").digest("hex");
const validBody = {
  hash,
  sentence,
  gloss: "这是测试白话。",
  result: "done",
  promptVersion: "gloss-v9",
};

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeRedis() {
  const set = vi.fn(async (_key: string, _value: ReportRecord, _options: { ex: number }) => "OK");
  return { redis: { set }, set };
}

describe("POST /api/report", () => {
  it("写入六个规定字段并设置 60 天 TTL", async () => {
    const { redis, set } = makeRedis();
    const post = createReportPost({
      getRedis: () => redis,
      now: () => new Date("2026-09-26T12:00:00.000Z"),
      uuid: () => "test-id",
    });

    const response = await post(makeRequest(validBody));

    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(`${REPORT_KEY_PREFIX}test-id`, {
      ...validBody,
      createdAt: "2026-09-26T12:00:00.000Z",
    }, { ex: REPORT_TTL_SECONDS });
    expect(Object.keys(set.mock.calls[0]![1]!)).toEqual([
      "hash", "sentence", "gloss", "result", "promptVersion", "createdAt",
    ]);
  });

  it.each([
    ["缺字段", { ...validBody, gloss: undefined }],
    ["原句超长", { ...validBody, sentence: "甲".repeat(1001) }],
    ["白话超长", { ...validBody, gloss: "乙".repeat(501) }],
    ["result 非法", { ...validBody, result: "failed" }],
  ])("%s 返回 400 且不写存储", async (_label, body) => {
    const { redis, set } = makeRedis();
    const post = createReportPost({ getRedis: () => redis });

    const response = await post(makeRequest(body));

    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it("没有 Upstash 凭据时返回 503 且不写存储", async () => {
    const { redis, set } = makeRedis();
    const post = createReportPost({ getRedis: () => null });

    const response = await post(makeRequest(validBody));

    expect(response.status).toBe(503);
    expect(set).not.toHaveBeenCalled();
  });

  it("拒答可用空白话上报", async () => {
    const { redis, set } = makeRedis();
    const post = createReportPost({ getRedis: () => redis, uuid: () => "refused-id" });
    const body = { ...validBody, gloss: "", result: "refused" };

    const response = await post(makeRequest(body));

    expect(response.status).toBe(200);
    expect(set.mock.calls[0]![1]!.gloss).toBe("");
    expect(set.mock.calls[0]![1]!.result).toBe("refused");
  });
});
