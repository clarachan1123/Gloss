import { expect, it } from "vitest";
import { FEEDBACK_BODY_MAX, FEEDBACK_CONTACT_MAX, feedbackLength } from "./feedback";
it("反馈字数trim后按全部码点计数，保留内部空格和换行的计数", () => {
  const thousand = "甲".repeat(997) + " \n乙";
  expect(FEEDBACK_BODY_MAX).toBe(1000); expect(FEEDBACK_CONTACT_MAX).toBe(100);
  expect(feedbackLength(" \n ")).toBe(0);
  expect(feedbackLength(" \n" + thousand + " \n")).toBe(1000);
  expect(feedbackLength("甲" + thousand)).toBe(1001);
  expect(feedbackLength("🙂".repeat(1000))).toBe(1000);
});
