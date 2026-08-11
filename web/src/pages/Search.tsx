import { useEffect, useState } from "react";
import { api, type SymbolResult } from "../api";
import { Card, EmptyState, ErrorBanner, KindBadge, Spinner } from "../components/ui";

export function Search({ project, onOpenInGraph }: { project: string; onOpenInGraph: (symbol: string, file?: string) => void }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [results, setResults] = useState<SymbolResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      api
        .search(project, query.trim(), kind || undefined)
        .then((res) => {
          setResults(res.results);
          setTotal(res.total_matches);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [project, query, kind]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search functions, methods, classes…"
          className="mono flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text-muted)]"
        >
          <option value="">any kind</option>
          <option value="function">function</option>
          <option value="method">method</option>
          <option value="class">class</option>
        </select>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && <Spinner />}

      {!loading && results && results.length === 0 && <EmptyState>No matches for “{query}”.</EmptyState>}

      {!loading && results && results.length > 0 && (
        <Card>
          <p className="mb-2 text-xs text-[var(--text-muted)]">
            {total} match{total === 1 ? "" : "es"}
            {total > results.length ? ` (showing ${results.length})` : ""}
          </p>
          <ul className="divide-y divide-[var(--border)]">
            {results.map((r) => (
              <li key={`${r.qualified_name}:${r.file}:${r.start_line}`}>
                <button
                  onClick={() => onOpenInGraph(r.qualified_name, r.file)}
                  className="flex w-full items-center gap-3 py-2 text-left hover:opacity-80"
                >
                  <KindBadge kind={r.kind} />
                  <span className="mono flex-1 truncate text-sm">{r.qualified_name}</span>
                  <span className="mono truncate text-xs text-[var(--text-muted)]">
                    {r.file}:{r.start_line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!query.trim() && <EmptyState>Start typing to search this project's symbols.</EmptyState>}
    </div>
  );
}
