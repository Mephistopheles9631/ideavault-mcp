// Proxies the codebase-memory Python MCP server (local, stdio-only, SQLite-backed
// code graph) through this server's HTTP endpoint. Nothing about codebase-memory's
// own code changes -- it's spawned once at startup as a persistent child process and
// treated as an internal MCP client connection. This is the merge: one external MCP
// surface (this HTTP server, with its existing auth/rate-limiting), two internal
// engines behind it.
//
// If the child dies, we don't try to respawn it in place -- state like the
// "active project" convenience lives in the Python process's memory, so a silent
// respawn would just paper over a real crash. We exit instead and let systemd's
// Restart=on-failure bring the whole merged server back up clean.
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PYTHON_BIN = "/home/mephisto/codebase-memory/.venv/bin/python";
const SERVER_PATH = "/home/mephisto/codebase-memory/server.py";
const CWD = "/home/mephisto/codebase-memory";

export interface ProxiedTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
}

const client = new Client({ name: "ideavault-mcp-proxy", version: "0.1.0" });
let tools: ProxiedTool[] = [];

function jsonSchemaPropToZod(prop: any, required: boolean): z.ZodTypeAny {
  const types: string[] = Array.isArray(prop?.type) ? prop.type : [prop?.type];
  const nullable = types.includes("null");
  const coreType = types.find((t) => t !== "null") ?? "string";

  let base: z.ZodTypeAny;
  if (Array.isArray(prop?.enum) && prop.enum.length > 0) {
    base = z.enum(prop.enum as [string, ...string[]]);
  } else if (coreType === "integer" || coreType === "number") {
    base = z.number();
  } else if (coreType === "boolean") {
    base = z.boolean();
  } else {
    base = z.string();
  }

  if (prop?.description) base = base.describe(prop.description);
  if (!required || nullable) base = base.optional();
  // Deliberately no .default() here: an omitted key just drops out of the
  // forwarded JSON entirely, so the Python side's own function-parameter
  // defaults apply naturally. Forwarding JSON schema's `default: null` (which
  // Python's `x: str | None = None` produces) as a literal null instead of
  // omitting the key fails pydantic validation on the other side -- confirmed
  // live against search_symbols's optional `kind` param.
  return base;
}

function jsonSchemaToZodShape(schema: any): z.ZodRawShape {
  const required = new Set<string>(schema?.required ?? []);
  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries<any>(schema?.properties ?? {})) {
    shape[key] = jsonSchemaPropToZod(prop, required.has(key));
  }
  return shape;
}

export async function connectCodebaseMemory(): Promise<ProxiedTool[]> {
  const transport = new StdioClientTransport({
    command: PYTHON_BIN,
    args: [SERVER_PATH],
    cwd: CWD,
  });
  transport.onclose = () => {
    console.error("[codebaseMemory] child process connection closed unexpectedly -- exiting so systemd restarts the merged server");
    process.exit(1);
  };
  await client.connect(transport);
  const { tools: listed } = await client.listTools();
  tools = listed.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: jsonSchemaToZodShape(t.inputSchema),
  }));
  console.log(`[codebaseMemory] proxy connected: ${tools.map((t) => t.name).join(", ")}`);
  return tools;
}

export function getProxiedTools(): ProxiedTool[] {
  return tools;
}

export async function callProxiedTool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
