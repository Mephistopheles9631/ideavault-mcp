import type { ReactNode } from "react";

export function Card({ title, children, className = "" }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 ${className}`}>
      {title && <h3 className="mb-3 text-sm font-medium text-[var(--text-muted)]">{title}</h3>}
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
      Loading…
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
      {message}
    </div>
  );
}

const KIND_COLORS: Record<string, string> = {
  function: "#7c5cff",
  method: "#3b9eff",
  class: "#f5a623",
};

export function kindColor(kind: string): string {
  return KIND_COLORS[kind.toLowerCase()] ?? "#8a8c9c";
}

export function KindBadge({ kind }: { kind: string }) {
  const color = kindColor(kind);
  return (
    <span
      className="mono inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color, background: `${color}22` }}
    >
      {kind}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: "high" | "low" }) {
  const isHigh = risk === "high";
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: isHigh ? "var(--danger)" : "var(--ok)",
        background: isHigh ? "var(--danger-soft)" : "var(--ok-soft)",
      }}
    >
      {risk} risk
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-[var(--text-muted)]">{children}</p>;
}
