import { useEffect, useState } from "react";
import { clearAllGlossCache } from "@/lib/cache";

const SETTINGS = ["呈现模式", "保存形态", "导出形态", "字号", "行距", "纸面底色"];
const CONFIRM_MS = 5_000;
const RESULT_MS = 3_000;

export default function SettingsPanel() {
  const [state, setState] = useState<"idle" | "confirm" | "cleared" | "failed">("idle");

  useEffect(() => {
    if (state !== "confirm" && state !== "cleared" && state !== "failed") return;
    const timer = window.setTimeout(() => setState("idle"), state === "confirm" ? CONFIRM_MS : RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function clear() {
    if (state === "idle") {
      setState("confirm");
      return;
    }
    if (state !== "confirm") return;
    setState((await clearAllGlossCache()) ? "cleared" : "failed");
  }

  const label = state === "confirm" ? "确认清除？" : "清除自动缓存";
  const result = state === "cleared" ? "已清除" : state === "failed" ? "清除失败" : null;

  return (
    <>
      <h2 id="settings-title" className="side-title">
        设置
      </h2>
      <ul className="settings-skeleton">
        {SETTINGS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="settings-cache-action">
        <button type="button" className="settings-cache-button" onClick={() => void clear()}>
          {label}
        </button>
        {result && <span className="settings-cache-result" role="status">{result}</span>}
      </div>
    </>
  );
}
