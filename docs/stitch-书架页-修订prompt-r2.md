# Gloss Bookshelf — Revision Round 2

Round 1 was applied to the **full shelf** artboard only. The **empty shelf**
artboard did not receive most of it. This round fixes the empty state, plus four
issues on the full shelf.

---

## A. Copy rule — apply to every string on both artboards

Round 1 gave a replacement table. The listed strings were replaced; newly written
strings went back to the old register. So this is now a rule, not a table.

**Every user-facing string must be plain modern Chinese that a 15-year-old reads
correctly on the first pass.**

Banned words and constructions, anywhere on the page:

> 注疏 · 考据 · 文献 · 留白 · 对位 · 逐句对位 · 随按随现 · 卷本 · 释文 ·
> 概念索引 · 泛化 · 库存 · 统立 · 互证 · 校勘 · 雅言式四字短语

Decorative English is still allowed **only** as pure texture that labels nothing
clickable: `CATALOG NO.`, `FOLIO REF`, the book-cover Latin/German lines, the
footer strip.

Any explanatory sentence must be under 30 Chinese characters.

## B. Empty shelf artboard — apply these (they were missed)

1. **Navigation**: same as the full shelf — two Chinese items, `书架` / `阅读`.
   `Shelf` `Desk` `Concordance` `Apparatus` must not appear.
2. **Delete the top-right counter** `本地书架 12 本 · 示例与已导入`. The shelf is
   empty; a count of 12 contradicts the screen.
3. **Delete the breadcrumb** `COLLECTION 04 / SCHOLARLY CODICES / LOC. DESK-A`.
   It is good texture on a full shelf and absurd above an empty one. (Keep it on
   the full shelf.)
4. **Delete the search field and the filter row.** Nothing to search or filter.
   Keep only the view-toggle control, or drop that too.
5. **One layer of explanation, not three.** Currently there is the tagline, the
   `阅览指南` block, and three feature cards. Keep the tagline
   (`放你想读的难书，点句出白话。`) and **delete the 阅览指南 block and the three
   cards entirely.** The empty state has one job: get the first document
   uploaded, or the sample book opened. Three explanations read as anxiety.
6. **Make the import slot a book, not a card.** Right now it is a large white
   card beside a thin spine — two different visual languages side by side. The
   import entry should be a **dashed-outline book** standing on the shelf, the
   same size family as the sample spine, so the empty shelf reads as "two books
   on a shelf, one of them outlined." Label inside it: `导入新书`, and beneath the
   shelf: `拖入或点击上传 · 支持 .docx .txt .pdf`.

## C. Full shelf artboard — four fixes

7. **Spine label size is still too small, and inconsistent.** The four spines on
   the left render noticeably larger than the seven on the right. Set one size
   for all spines and raise it until the vertical Chinese is comfortable at 100%
   zoom. Fewer spines fitting is the correct trade.
8. **Add the horizontal-overflow affordance**: a soft fade at the right edge of
   the shelf, indicating the row scrolls. The shelf never wraps to a second row
   and never shrinks type to fit.
9. **Ink colour violation in the detail card.** The description paragraph, the
   `CATALOG NO.` line and the metadata labels render with a blue-violet cast.
   All body ink on this page is `#212121` (`--ink`); secondary text is `#5D5750`
   (`--gloss`). No blue is defined in this product's palette. Remove the cast.
10. **Only one book may carry the `示例` tag.** Three currently do, and one of
    them is also the book marked `正在读`. The product ships exactly one sample
    document.

## D. Keep exactly as they are

Round 1 landed these. Do not touch them.

- The **continue-reading bar** at the top: position, full width, thumbnail +
  title + `4 天前 · 停在序言结尾` + right-side arrow, whole bar clickable. This is
  the most important element on the screen and it is now correct.
- Navigation reduced to `书架` / `阅读` on the full shelf.
- Page title `我的书架` and the line `12 本书。点开任意一本，接着上次的地方读。`
- Search placeholder `搜书名、作者`, the filter row and its counts.
- The detail card structure and its fields: `著者` / `已存白话` / `上次读到`.
  The `译本状态` field stays deleted. The `.docx` export button stays deleted.
- The selected-book behaviour: pulls forward into a full cover, detail card
  appears below, nothing else on the shelf moves.
- The book-cover design for 《政治经济学批判》 — frame, rules, German subtitle,
  typographic hierarchy.
- The breadcrumb on the **full shelf** (deleted only on the empty shelf).
- Paper `#F8F6F0`, the spine colour family, the shelf ledge, the footer strip.
- The view-toggle control at the right of the filter row.
- The `导入新书` dashed slot at the end of the full shelf (the book-shaped change
  in item 6 applies to the empty state; on the full shelf it stays as is).

## Output

Both artboards, same visual system:
1. Full shelf, 12 books, one selected — round 1 plus items 7–10.
2. Empty shelf — rebuilt per items 1–6.
