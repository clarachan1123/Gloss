// 把 pdfjs-dist 自带的 cMap 字符映射表复制到 public/pdfjs/<版本号>/cmaps/，由站点自己提供，不走 CDN。
// 由 package.json 的 predev / prebuild 自动执行；生成物不提交（.gitignore 忽略 public/pdfjs/）。
// 升级 pdfjs-dist 后目录名随版本号变化，旧版本目录在这里清掉；lib/parse/pdf.test.ts 检查版本号一致。
// 只用 Node 自带的 fs，Windows / macOS / Linux 都能跑。
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** cMap 的目标目录；lib/parse/pdf.ts 按 /pdfjs/<pdfjs.version>/cmaps/ 读取 */
export function assetDir(root, version) {
  return path.join(root, "public", "pdfjs", version, "cmaps");
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(path.join(root, "package.json"));
  const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

  const base = path.join(root, "public", "pdfjs");
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      if (entry !== version) rmSync(path.join(base, entry), { recursive: true, force: true });
    }
  }

  const target = assetDir(root, version);
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(pkgDir, "cmaps"), target, { recursive: true });
  const files = readdirSync(target).length;
  console.log(`[copy-pdfjs-assets] pdfjs-dist ${version}: ${files} cMap files -> public/pdfjs/${version}/cmaps/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
