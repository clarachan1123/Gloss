import Upload from "@/components/Upload";

export default function Home() {
  return (
    <div className="shell">
      <aside className="col col-left">
        <span className="wordmark">Gloss</span>
      </aside>

      <main className="col col-main">
        {/* 临时挂载点：G-02 验证上传解析用，G-13 书架上线后替换 */}
        <Upload />
      </main>

      <aside className="col col-right" />
    </div>
  );
}
