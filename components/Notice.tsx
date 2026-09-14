import styles from "./Notice.module.css";

export interface NoticeProps {
  /** block：阻断型提示；banner：横幅，不阻断 */
  tone: "block" | "banner";
  message: string;
  action?: { label: string; onClick: () => void };
}

/** 通用异常提示。文案由 lib/parse/validate.ts 的 noticeContent() 提供。 */
export default function Notice({ tone, message, action }: NoticeProps) {
  return (
    <div
      role={tone === "block" ? "alert" : "status"}
      className={`${styles.notice} ${tone === "block" ? styles.block : styles.banner}`}
    >
      <p className={styles.message}>{message}</p>
      {action && (
        <button type="button" className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
