import { expect, it } from "vitest";
import { readerProgress } from "./reader-progress";
it("示例书三段与标题计数", () => {
  const sample = [{ paraIndex: 0 }, { paraIndex: 0 }, { paraIndex: 1 }, { paraIndex: 2 }];
  expect([0, 2, 3].map(index => readerProgress(3, sample, index))).toEqual([
    { current: 1, total: 3, ratio: 1 / 3 }, { current: 2, total: 3, ratio: 2 / 3 }, { current: 3, total: 3, ratio: 1 }]);
  expect(readerProgress(15, [{ paraIndex: 2 }, { paraIndex: 3 }], 0)?.current).toBe(3);
  expect(readerProgress(15, [{ paraIndex: 2 }, { paraIndex: 3 }], 1)?.current).toBe(4);
});
it("空文档不渲染；越界和非法 index 安全夹取", () => {
  expect(readerProgress(0, [], 0)).toBeNull(); expect(readerProgress(3, [], 0)).toBeNull();
  const sentences = [{ paraIndex: 0 }, { paraIndex: 2 }];
  expect(readerProgress(3, sentences, -10)?.current).toBe(1);
  expect(readerProgress(3, sentences, 99)?.current).toBe(3);
  expect(readerProgress(3, sentences, NaN)?.current).toBe(1);
  expect(readerProgress(3, [{ paraIndex: 99 }], 0)?.current).toBe(3);
});
