import { useState, type FormEvent } from "react";
import { verifyToken } from "../api";

export function TokenGate({ onSignedIn }: { onSignedIn: () => void }) {
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setChecking(true);
    setError(null);
    const ok = await verifyToken(value.trim());
    setChecking(false);
    if (ok) onSignedIn();
    else setError("That token was rejected.");
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm"
      >
        <h1 className="mb-1 text-lg font-semibold text-[var(--text)]">ideavault code graph</h1>
        <p className="mb-4 text-sm text-[var(--text-muted)]">Enter the server's AUTH_TOKEN to continue.</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="AUTH_TOKEN"
          className="mono w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
        {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
        <button
          type="submit"
          disabled={checking || !value.trim()}
          className="mt-4 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
        >
          {checking ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
