/** One number-over-label tile, for an import/export plan summary. */
export function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="import-stat">
      <span className="import-stat__n">{n}</span>
      <span className="import-stat__label">{label}</span>
    </div>
  );
}
