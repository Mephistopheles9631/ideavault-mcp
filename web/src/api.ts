const TOKEN_KEY = "ideavault_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(401, "not signed in");
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  const suffix = qs.toString();
  const res = await fetch(`/api/graph${path}${suffix ? `?${suffix}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiError(401, "session expired, sign in again");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface ProjectSummary {
  project: string;
  root_path: string;
  last_indexed_at: string | null;
  files: number;
  symbols: number;
}

export interface Architecture {
  project: string;
  root_path: string;
  last_indexed_at: string | null;
  languages: Record<string, number>;
  symbol_counts: Record<string, number>;
  top_level_folders: string[];
  hotspot_files: Array<{ file: string; symbols: number }>;
}

export interface SymbolResult {
  kind: string;
  qualified_name: string;
  file: string;
  start_line: number;
  end_line: number;
}

export interface SearchResponse {
  results: SymbolResult[];
  shown: number;
  total_matches: number;
  note?: string;
}

export type Direction = "callers" | "callees" | "both";

export interface CallEdge {
  from: string;
  to: string;
}

export interface TraceResponse {
  root: string;
  direction: Direction;
  depth: number;
  callers?: CallEdge[];
  callers_truncated?: boolean;
  callers_caveat?: string;
  callees?: CallEdge[];
  callees_unresolved?: string[];
  callees_truncated?: boolean;
}

export interface Snippet {
  qualified_name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  source: string;
}

export interface ChangedSymbol {
  qualified_name: string;
  kind: string;
  callers: string[];
  caller_count: number;
  risk: "high" | "low";
}

export interface ChangesResponse {
  project: string;
  changed_symbols: ChangedSymbol[];
  note?: string;
}

export interface ProjectGraphNode {
  id: number;
  qualified_name: string;
  kind: string;
  file: string;
  degree: number;
}

export interface ProjectGraphEdge {
  from: number;
  to: number;
}

export interface ProjectGraphResponse {
  project: string;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}

export const api = {
  projects: () => request<ProjectSummary[]>("/projects"),
  architecture: (project: string) => request<Architecture>("/architecture", { project }),
  search: (project: string, q: string, kind?: string, limit?: number) =>
    request<SearchResponse>("/search", { project, q, kind, limit }),
  trace: (project: string, symbol: string, direction: Direction, depth: number, file?: string) =>
    request<TraceResponse>("/trace", { project, symbol, direction, depth, file }),
  snippet: (project: string, symbol: string, file?: string) =>
    request<Snippet>("/snippet", { project, symbol, file }),
  changes: (project: string) => request<ChangesResponse>("/changes", { project }),
  projectGraph: (project: string, limit?: number) =>
    request<ProjectGraphResponse>("/project-graph", { project, limit }),
};

export async function verifyToken(token: string): Promise<boolean> {
  const prev = getToken();
  setToken(token);
  try {
    await api.projects();
    return true;
  } catch {
    if (prev) setToken(prev);
    else clearToken();
    return false;
  }
}
