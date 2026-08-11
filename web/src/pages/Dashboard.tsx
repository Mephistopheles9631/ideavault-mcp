import { useEffect, useState } from "react";
import { api, type Architecture } from "../api";
import { Card, EmptyState, ErrorBanner, Spinner, kindColor } from "../components/ui";

const LANGUAGE_COLORS = ["#7c5cff", "#3b9eff", "#f5a623", "#2fb380", "#e0555f", "#8a8c9c"];

export function Dashboard({ project }: { project: string }) {
  const [data, setData] = useState<Architecture | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .architecture(project)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [project]);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Spinner />;

  const langEntries = Object.entries(data.languages).sort((a, b) => b[1] - a[1]);
  const langTotal = langEntries.reduce((sum, [, n]) => sum + n, 0) || 1;
  const kindEntries = Object.entries(data.symbol_counts).sort((a, b) => b[1] - a[1]);
  const kindTotal = kindEntries.reduce((sum, [, n]) => sum + n, 0) || 1;
  const hotspotMax = Math.max(...data.hotspot_files.map((h) => h.symbols), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Files" value={langTotal} />
        <Stat label="Symbols" value={kindTotal} />
        <Stat label="Folders" value={data.top_level_folders.length} />
        <Stat label="Last indexed" value={data.last_indexed_at ? timeAgo(data.last_indexed_at) : "—"} small />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Languages">
          {langEntries.length === 0 ? (
            <EmptyState>No files indexed.</EmptyState>
          ) : (
            <div className="space-y-2">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                {langEntries.map(([lang, count], i) => (
                  <div
                    key={lang}
                    style={{ width: `${(count / langTotal) * 100}%`, background: LANGUAGE_COLORS[i % LANGUAGE_COLORS.length] }}
                    title={`${lang}: ${count}`}
                  />
                ))}
              </div>
              <ul className="mono grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
                {langEntries.map(([lang, count], i) => (
                  <li key={lang} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: LANGUAGE_COLORS[i % LANGUAGE_COLORS.length] }} />
                    {lang} <span className="ml-auto text-[var(--text)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card title="Symbol kinds">
          {kindEntries.length === 0 ? (
            <EmptyState>No symbols found.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {kindEntries.map(([kind, count]) => (
                <li key={kind} className="flex items-center gap-2">
                  <span className="mono w-20 shrink-0 text-xs text-[var(--text-muted)]">{kind}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(count / kindTotal) * 100}%`, background: kindColor(kind) }}
                    />
                  </div>
                  <span className="mono w-10 shrink-0 text-right text-xs text-[var(--text-muted)]">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Top-level folders">
          {data.top_level_folders.length === 0 ? (
            <EmptyState>No folders.</EmptyState>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {data.top_level_folders.map((f) => (
                <span key={f} className="mono rounded-full bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-muted)]">
                  {f}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="Hotspot files (most symbols)">
          {data.hotspot_files.length === 0 ? (
            <EmptyState>No hotspots.</EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {data.hotspot_files.map((h) => (
                <li key={h.file} className="flex items-center gap-2">
                  <span className="mono flex-1 truncate text-xs text-[var(--text)]" title={h.file}>
                    {h.file}
                  </span>
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${(h.symbols / hotspotMax) * 100}%` }} />
                  </div>
                  <span className="mono w-6 shrink-0 text-right text-xs text-[var(--text-muted)]">{h.symbols}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <Card>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className={small ? "mt-1 text-sm font-medium" : "mt-1 text-2xl font-semibold"}>{value}</p>
    </Card>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string][] = [[86400, "d"], [3600, "h"], [60, "m"]];
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return "just now";
}
