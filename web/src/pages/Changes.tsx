import { useEffect, useState } from "react";
import { api, type ChangedSymbol } from "../api";
import { Card, EmptyState, ErrorBanner, KindBadge, RiskBadge, Spinner } from "../components/ui";

export function Changes({ project, onOpenInGraph }: { project: string; onOpenInGraph: (symbol: string) => void }) {
  const [symbols, setSymbols] = useState<ChangedSymbol[] | null>(null);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSymbols(null);
    setError(null);
    api
      .changes(project)
      .then((res) => {
        setSymbols(res.changed_symbols);
        setNote(res.note);
      })
      .catch((err) => setError(err.message));
  }, [project]);

  if (error) return <ErrorBanner message={error} />;
  if (!symbols) return <Spinner />;

  if (symbols.length === 0) {
    return <EmptyState>{note ?? "No uncommitted changes touch any indexed symbol."}</EmptyState>;
  }

  return (
    <Card title={`${symbols.length} changed symbol${symbols.length === 1 ? "" : "s"} vs HEAD`}>
      <ul className="divide-y divide-[var(--border)]">
        {symbols.map((s) => (
          <li key={s.qualified_name}>
            <button
              onClick={() => onOpenInGraph(s.qualified_name)}
              className="flex w-full items-center gap-3 py-2.5 text-left hover:opacity-80"
            >
              <KindBadge kind={s.kind} />
              <span className="mono flex-1 truncate text-sm">{s.qualified_name}</span>
              <span className="text-xs text-[var(--text-muted)]">
                {s.caller_count} caller{s.caller_count === 1 ? "" : "s"}
              </span>
              <RiskBadge risk={s.risk} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
