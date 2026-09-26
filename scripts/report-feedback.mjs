import { Redis } from "@upstash/redis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "gloss:report:v1:";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_DIR = resolve(ROOT, "report-exports");

async function envValue(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  let contents;
  try {
    contents = await readFile(resolve(ROOT, ".env.local"), "utf8");
  } catch {
    return undefined;
  }
  for (const name of names) {
    const line = contents.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
    if (!line) continue;
    const value = line.slice(name.length + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

async function connect() {
  const url = await envValue(["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]);
  const token = await envValue(["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"]);
  if (!url || !token) throw new Error("Redis credentials are not configured");
  return new Redis({ url, token, enableTelemetry: false });
}

async function listKeys(redis) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: `${PREFIX}*`, count: 100 });
    cursor = String(next);
    keys.push(...batch.filter((key) => key.startsWith(PREFIX)));
  } while (cursor !== "0");
  return keys;
}

async function exportReports(redis) {
  const keys = await listKeys(redis);
  const records = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    const values = await redis.mget(...keys.slice(offset, offset + 100));
    records.push(...values.filter((value) => value !== null));
  }
  await mkdir(EXPORT_DIR, { recursive: true });
  const target = resolve(EXPORT_DIR, `report-feedback-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(target, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${target}\n${records.length}\n`);
}

async function purgeReports(redis) {
  const keys = await listKeys(redis);
  let deleted = 0;
  for (let offset = 0; offset < keys.length; offset += 100) {
    deleted += await redis.del(...keys.slice(offset, offset + 100));
  }
  process.stdout.write(`${deleted}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command !== "export" && command !== "purge") {
    throw new Error("Usage: node scripts/report-feedback.mjs export|purge");
  }
  const redis = await connect();
  if (command === "export") await exportReports(redis);
  else await purgeReports(redis);
}

main().catch(() => {
  process.stderr.write("report-feedback command failed\n");
  process.exitCode = 1;
});
