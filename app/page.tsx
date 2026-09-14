export default function Home() {
  return (
    <div className="shell">
      <aside className="col col-left">
        <span className="wordmark">Gloss</span>
      </aside>

      <main className="col col-main">
        <p className="col-main-empty">正文栏</p>
      </main>

      <aside className="col col-right" />
    </div>
  );
}
