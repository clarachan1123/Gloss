# Gloss

读难懂的中文哲学书时，点一下句子，就地给出这句话的大白话改写。

统一原则：**一切服务于阅读的连贯性。**

## 本地运行

```bash
npm install
npm run dev
```

打开 http://localhost:3000

## 技术选型

- Next.js（App Router）+ React + TypeScript
- 原生 CSS + CSS 变量（不使用 Tailwind）
- 部署：Vercel（GitHub 集成，每个分支自动生成 preview）

## 主题与 token

`styles/tokens.css` 定义三套主题，每套 6 个颜色变量：
`--paper-main` `--paper-side` `--ink` `--gloss` `--rule` `--term`。

| 主题 | `data-theme` |
|---|---|
| 羊皮纸（默认） | `parchment` |
| 月白 | `moon-white` |
| 护眼绿 | `eye-green` |

切换方式：修改 `<html>` 的 `data-theme` 属性，六个变量整套替换。
中栏最亮，侧栏退后一档。

目前在浏览器控制台手动切换（界面内的切换入口见 G-19）：

```js
document.documentElement.dataset.theme = "moon-white"; // parchment / moon-white / eye-green
```

## 字体

| 用途 | 字体 | 加载方式 |
|---|---|---|
| 正文 | 中文衬线字体栈 `--font-serif-cjk` | 读者本机字体，不下载网络字体 |
| 展示 / 字标 | Cinzel | `next/font/google`，构建时自托管 |
| 工具 / 参数 | JetBrains Mono | `next/font/google`，构建时自托管 |

## 目录结构

后续 issue 新建文件时按以下路径放置，不预先创建空文件。

```
app/
  layout.tsx
  page.tsx
  read/[docId]/page.tsx
  api/
    gloss/route.ts
    explain/route.ts
    structure/route.ts
    segment/route.ts
components/
  reader/
    Reader.tsx
    Sentence.tsx
    GlossPanel.tsx
    ActionRow.tsx
    TermMark.tsx
    ContextMenu.tsx
  shelf/
    Shelf.tsx
    Spine.tsx
    EmptyShelf.tsx
  settings/
    SettingsPanel.tsx
lib/
  parse/
    docx.ts
    txt.ts
    pdf.ts
  segment.ts
  context.ts
  cache.ts
  storage.ts
  analytics.ts
  prompts/
    gloss.ts
    explain.ts
styles/
  tokens.css
  reader.css
public/
  samples/
```
