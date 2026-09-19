/* Inject after a /read/<docId> page has loaded. No npm dependency. */
(() => {
  const fiberKey = (node) => Object.getOwnPropertyNames(node).find((key) => key.startsWith("__reactFiber$"));
  const paragraphProps = () => [...document.querySelectorAll("[data-para]")].map((node) => {
    let fiber = node[fiberKey(node)];
    while (fiber && !fiber.memoizedProps?.paraIndex) fiber = fiber.return;
    return fiber?.memoizedProps;
  });
  const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];

  window.__glossPerf = {
    async click(index) {
      const sentence = document.querySelector(`.sentence[data-index="${index}"]`);
      const root = document.querySelector(".reader-body");
      if (!sentence || !root) throw new Error("reader sentence/body not found");
      const before = paragraphProps();
      const started = performance.now();
      const elapsed = await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => { observer.disconnect(); resolve(performance.now() - started); });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        sentence.click();
        setTimeout(() => { observer.disconnect(); reject(new Error("DOM update timeout")); }, 3000);
      });
      const after = paragraphProps();
      return { clickToDomMs: elapsed, rerenderedParagraphs: after.filter((props, i) => props !== before[i]).length };
    },
    preload() {
      const starts = performance.getEntriesByName("gloss:preload:start");
      const ends = performance.getEntriesByName("gloss:preload:end");
      if (!starts.length || !ends.length) throw new Error("preload marks not found");
      return { ms: ends.at(-1).startTime - starts.at(-1).startTime, rerenderedParagraphs: 0 };
    },
    summarize(samples) {
      const values = samples.map((sample) => sample.clickToDomMs).sort((a, b) => a - b);
      const distribution = Object.groupBy(samples, (sample) => String(sample.rerenderedParagraphs));
      return { n: values.length, medianMs: percentile(values, 0.5), p90Ms: percentile(values, 0.9), maxMs: values.at(-1), rerenderDistribution: Object.fromEntries(Object.entries(distribution).map(([key, group]) => [key, group.length])) };
    },
  };
  console.info("Gloss perf ready: window.__glossPerf");
})();
