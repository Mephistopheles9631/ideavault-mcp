import { useEffect, useState } from "react";
import { api, clearToken, getToken, type ProjectSummary } from "./api";
import { TokenGate } from "./components/TokenGate";
import { Dashboard } from "./pages/Dashboard";
import { Search } from "./pages/Search";
import { GraphView } from "./pages/GraphView";
import { Changes } from "./pages/Changes";
import { Overview } from "./pages/Overview";

type Tab = "dashboard" | "search" | "graph" | "changes" | "overview";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "dashboard", label: "Dashboard" },
  { id: "search", label: "Search" },
  { id: "graph", label: "Graph" },
  { id: "changes", label: "Changes" },
];

const LAST_PROJECT_KEY = "ideavault_last_project";

export default function App() {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string>(() => localStorage.getItem(LAST_PROJECT_KEY) ?? "");
  const [tab, setTab] = useState<Tab>("dashboard");
  const [graphTarget, setGraphTarget] = useState<{ symbol: string; file?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    api
      .projects()
      .then((list) => {
        setProjects(list);
        if (!project && list.length > 0) setProject(list[0].project);
      })
      .catch((err) => setError(err.message));
  }, [signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (project) localStorage.setItem(LAST_PROJECT_KEY, project);
  }, [project]);

  function openInGraph(symbol: string, file?: string) {
    setGraphTarget({ symbol, file });
    setTab("graph");
  }

  function selectProjectSymbol(targetProject: string, symbol: string, file?: string) {
    setProject(targetProject);
    openInGraph(symbol, file);
  }

  function focusProject(targetProject: string) {
    setProject(targetProject);
    setTab("dashboard");
  }

  if (!signedIn) {
    return <TokenGate onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="text-sm font-semibold tracking-tight">ideavault · code graph</span>

          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="mono rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm"
          >
            {projects.length === 0 && <option value="">(no projects indexed)</option>}
            {projects.map((p) => (
              <option key={p.project} value={p.project}>
                {p.project}
              </option>
            ))}
          </select>

          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === t.id
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <button
            onClick={() => {
              clearToken();
              setSignedIn(false);
            }}
            className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}
        {tab === "overview" && <Overview onSelectProjectSymbol={selectProjectSymbol} onFocusProject={focusProject} />}
        {tab !== "overview" && !project && (
          <p className="py-16 text-center text-sm text-[var(--text-muted)]">
            No indexed projects yet — run <code className="mono">index_repository</code> from Claude first.
          </p>
        )}
        {tab !== "overview" && project && (
          <>
            {tab === "dashboard" && <Dashboard project={project} />}
            {tab === "search" && <Search project={project} onOpenInGraph={openInGraph} />}
            {tab === "graph" && <GraphView project={project} target={graphTarget} />}
            {tab === "changes" && <Changes project={project} onOpenInGraph={openInGraph} />}
          </>
        )}
      </main>
    </div>
  );
}
