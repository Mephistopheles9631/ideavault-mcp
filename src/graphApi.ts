// Thin read-only REST/JSON layer over the proxied codebase-memory tools, for
// the web UI (web/) to consume from the browser. Each route is a pass-through
// to one MCP tool call -- no new logic, just unwrapping the MCP tool-result
// envelope into plain JSON so the frontend doesn't need an MCP client.
import { Router, type Request, type Response, type NextFunction } from "express";
import { callProxiedTool } from "./codebaseMemory.js";

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await callProxiedTool(name, args)) as ToolResultLike;
  // Error results carry a plain-text message (e.g. FastMCP's ToolError text),
  // not JSON -- check isError before ever trying to JSON.parse the content,
  // or a real tool error crashes here on the parse instead of surfacing it.
  if (result.isError) {
    const message = result.content?.find((c) => c.type === "text")?.text ?? "tool call failed";
    const err = new Error(message);
    (err as Error & { isToolError: true }).isToolError = true;
    throw err;
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content?.find((c) => c.type === "text")?.text ?? "null";
  return JSON.parse(text);
}

// Drop undefined/empty-string query params so codebase-memory's own
// function-parameter defaults apply, same convention as codebaseMemory.ts's
// jsonSchemaPropToZod (an explicit empty value is not the same as "omitted").
function cleanArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}

function strParam(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function numParam(v: unknown): number | undefined {
  const s = strParam(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export const graphApi = Router();

function route(
  path: string,
  toolName: string,
  buildArgs: (query: Record<string, unknown>) => Record<string, unknown>,
  unwrap: (data: unknown) => unknown = (data) => data,
) {
  graphApi.get(path, async (req, res, next) => {
    try {
      const args = cleanArgs(buildArgs(req.query as Record<string, unknown>));
      const data = await callTool(toolName, args);
      res.json(unwrap(data));
    } catch (err) {
      next(err);
    }
  });
}

// FastMCP wraps bare-list tool returns as {result: [...]} in structuredContent,
// since MCP structured content must be a JSON object at the top level --
// list_projects is the only proxied tool with a list return type, so it's
// the only route that needs unwrapping (confirmed against a live response;
// every other tool here returns a dict already).
route("/projects", "list_projects", () => ({}), (data) => (data as { result?: unknown })?.result ?? data);

route("/architecture", "get_architecture", (q) => ({
  project: strParam(q.project),
}));

route("/search", "search_symbols", (q) => ({
  query: strParam(q.q) ?? "",
  project: strParam(q.project),
  kind: strParam(q.kind),
  limit: numParam(q.limit),
}));

route("/trace", "trace_calls", (q) => ({
  qualified_name: strParam(q.symbol) ?? "",
  project: strParam(q.project),
  direction: strParam(q.direction),
  depth: numParam(q.depth),
  file: strParam(q.file),
}));

route("/snippet", "get_code_snippet", (q) => ({
  qualified_name: strParam(q.symbol) ?? "",
  project: strParam(q.project),
  file: strParam(q.file),
}));

route("/changes", "detect_changes", (q) => ({
  project: strParam(q.project),
}));

route("/project-graph", "project_graph", (q) => ({
  project: strParam(q.project),
  limit: numParam(q.limit),
}));

// Express identifies error-handling middleware solely by arity (4 params) --
// must come after all routes above, per Express's routing rules.
graphApi.use((err: Error & { isToolError?: boolean }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.isToolError ? 400 : 502;
  res.status(status).json({ error: err.message });
});
