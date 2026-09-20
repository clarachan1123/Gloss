import { useEffect, useState } from "react";
import type { StorageErrorCode } from "@/lib/storage";

type ToggleResult = "saved" | "removed" | StorageErrorCode;

export default function ActionRow({
  saved,
  disabled,
  onToggle,
}: {
  saved: boolean;
  disabled: boolean;
  onToggle: () => Promise<ToggleResult>;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function toggle() {
    setPending(true);
    const result = await onToggle();
    setPending(false);
    if (result === "E1") setNotice("存储已满，当前白话仍可继续阅读。");
    if (result === "E2") setNotice("当前模式下无法保存，白话仍可继续阅读。");
  }

  return (
    <div className="action-row">
      <button
        type="button"
        className="action-row-save"
        onClick={(event) => {
          event.stopPropagation();
          void toggle();
        }}
        disabled={disabled || pending}
      >
        {saved ? "已留下" : "留下"}
      </button>
      {notice && <span className="action-row-notice" role="status">{notice}</span>}
    </div>
  );
}
