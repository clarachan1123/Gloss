# Reader performance harness

This is the shared harness for every card that changes the reader. It measures click-to-first-DOM-update and React Fiber `memoizedProps` reference changes, rather than DOM-node replacement.

1. Generate the ignored sample: `node scripts/perf/make-preface-sample.mjs test-fixtures/政治经济学批判-序言.docx %TEMP%\gloss-preface-perf.txt`. It must report 450 paragraphs (about 1830 sentences).
2. Build and start the target revision with an invalid key. First make one `/api/gloss` request and verify its upstream log is 401. Then use only `scripts/dev-slow-gloss.mjs` as the local upstream.
3. Use one Chrome executable and one sample for main, cold miss, session hit, and cross-session hit. Start each group with three warm-up clicks, then collect 40 clicks. Inject `page-measure.js` only after the reader URL has loaded; it exports JSON-ready `window.__glossPerf`.
4. For a hit group, wait for a complete mock answer before closing/reopening the sentence. For cross-session, close Chrome, reopen the same profile, then wait for `gloss:preload:end`. Read `__glossPerf.preload()` immediately: it reports preloading duration and its Fiber rerender count.
5. Record the JSON returned by `__glossPerf.summarize(samples)`. A passing click distribution is exactly `{ "1": 40 }`; preload must report `0` paragraphs.

The browser driver is intentionally not a project dependency. Install `playwright-core` in a temporary directory, point it at the locally installed Chrome via `executablePath`, inject this file after navigation, then remove that directory. Do not edit package.json or package-lock.json.
