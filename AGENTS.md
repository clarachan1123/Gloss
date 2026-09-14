<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Gloss 执行纪律

1. 动手前先复述：本 issue 会改哪些文件、不会改哪些文件，与 KANBAN.md
   对应条目核对。清单之外的文件一律不动。
2. 一轮一个可验证增量，做不到说明 issue 拆大了，先拆。
3. 一个 issue 一个分支一个 commit，分支名见 KANBAN.md。
4. 验收清单未全绿不算完成。
5. 不改 PRD。实现中发现 PRD 有问题，停下来说，不在代码里偷偷改行为。
6. 样式用原生 CSS + CSS 变量，禁止引入 cdn.tailwindcss.com。
