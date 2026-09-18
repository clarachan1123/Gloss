<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gloss 工作约定

## 文档职责

- KANBAN.md 是唯一事实源：开工前、更新验收或 Backlog 前、交付前都先读相关条目。
- PRD.md 是产品需求：实现和验收以它为准；发现冲突或缺口先记录或提问，不暗改需求。
- HANDOFF.md 保存历史与设计决策：接手时、涉及既有取舍时阅读；当前进度仍以 KANBAN.md 为准。

## 协作流程

1. 每个 issue 开工前，复述任务、验收项、会改文件清单，并一次问完问题，等确认后才改动。
2. 交付的 diff 必须与开工复述一致；多改文件必须单独说明原因。
3. 不接受“顺手修一下”。中途发现的问题记进 KANBAN.md 对应 issue 或新卡，按顺序处理，不塞进当前改动。
4. 不改 PRD.md。实现发现需求问题时，先停下说明。

## 验收与数字

- 自测、亲验分开标注；未验不打勾。
- 每个 issue 结束时，给出 Clara 能独立执行、不依赖本报告、且能证伪的检查动作。
- 所有数字都标明实测或估算；不确定时明确写“不确定”，不补造结论。

## 安全底线

1. API key 只存在本机 .env.local（已忽略）与 Vercel 环境变量；不得出现在代码、注释、日志、报错、提交记录或对话输出。
2. 每次提交前做两遍 key 扫描，只报告命中次数；任一不为 0 就停止提交。
3. G-07 的服务端 IP 级速率限制与供应商消费上限是硬阻塞，不能以“先上线”跳过。
4. 上线后每周查看一次 DeepSeek 用量曲线；异常尖峰立即作废并重建 key。
5. 已泄露的 key 只能作废，不能补救。
6. 只有防护措施就位后才配置线上 key：先限流，后上 key。

提交时逐路径暂存，例如：

    git add -- KANBAN.md scripts/eval-gloss.mjs

禁止使用 git add -A、git add . 或任何扩大暂存范围的变体。

提交前完整扫描命令：

    (git -c core.quotepath=false diff --cached | Select-String -Pattern "sk-[a-zA-Z0-9]{20,}" | Measure-Object).Count
    (git -c core.quotepath=false log -p --all | Select-String -Pattern "sk-[a-zA-Z0-9]{20,}" | Measure-Object).Count

## 本地服务与真实调用

- 本地启动 next dev 或 next start 做测试时，一律以无效 key 覆盖环境变量，例如 PowerShell 中设置 DEEPSEEK_API_KEY 为 local-test-invalid。
- 启动后先发一个请求，确认服务端日志有 HTTP 401，再开始普通测试。
- 只有明确需要真实生成的评测才使用真 key；事先说明调用范围与预计成本，事后报告实际调用数、token 或可得用量、花费及不能确认的部分。
- 不索取、记录或输出任何 key。

## 技术禁区与固定约定

- 生产环境禁用 Tailwind Play CDN；样式使用原生 CSS 与 CSS 变量。
- 调用模型时必须显式关闭 thinking。
- 固定 prompt 在消息最前，结构摘要次之，目标句最后。
- .reader-body 必须设置 overflow-anchor: none，以维护阅读视口不变量。
- 每次修改提示词都要增加版本号、存档旧版；提示词示例词不得取自评测集或 Clara 正在读的书。

## 回复格式

每次回复分为两段，中间单独一行 ---。

分割线前写过程叙述：查了什么、试了什么、哪里返工。

分割线后第一行必须写“以下为正式报告”。该部分独立说明结论、数字表、diff、问题、不确定项、需决定事项和独立验证动作；发生错误或改方案时，也在此简短说明原因。
