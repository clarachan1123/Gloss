export default function BrandWordmark({ englishOnly = false, className = "" }: { englishOnly?: boolean; className?: string }) {
  return <span className={"brand-wordmark " + className}>
    <span className="brand-english">Glossline</span>
    {!englishOnly && <span className="brand-chinese">句下</span>}
  </span>;
}
