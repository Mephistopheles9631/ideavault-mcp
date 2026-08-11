"""codebase-memory: a local, personal MCP server that indexes this machine's
repos into a SQLite symbol/call graph so structural questions ("what calls
X", "show me just this function", "what's in this file") can be answered
with one cheap query instead of Grep/Read round trips or full-file reads.

Scope, deliberately: name-based call resolution (no type inference), 6
languages (C#, Python, JS, TS/TSX, Rust, Go -- what's actually in use on
this machine, plus Go for future projects), no Cypher engine, no
cross-repo graph, no multi-agent install. Personal tool for this user's
own Claude Code sessions, not a distributable product -- see
/home/mephisto/codebase-memory-mcp for the production-grade reference
project this borrows the *idea* from.

Two conveniences query tools share: `project` is optional everywhere
except index_repository -- omit it and the last project you named is
reused for the rest of the session. And every query auto-refreshes a git
project first if its HEAD or working tree changed since the last index,
so you don't need to remember to call index_repository again after an
edit (non-git directories still need an explicit re-index).
"""

import hashlib
import re
import subprocess
from pathlib import Path

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

import gitutil
import indexer
import store

mcp = FastMCP("codebase-memory", instructions=__doc__)

RO = {"readOnlyHint": True, "openWorldHint": False}

# A callee name matching more project-wide symbols than this (get/run/init/...)
# is too generic to resolve reliably -- reporting all of them as edges is both
# misleading (implies calls that don't exist) and a token sink. Past this
# threshold we report the name as unresolved instead.
MAX_CALLEE_FANOUT = 5

# Last project name used in this process (one server process per Claude Code
# session) -- lets `project` be omitted on follow-up calls instead of
# re-passed every time.
_state: dict = {"active_project": None}


def _conn():
    return store.connect()


def _project_name(project: str | None) -> str:
    if project:
        _state["active_project"] = project
        return project
    if _state["active_project"]:
        return _state["active_project"]
    raise ToolError(
        "No `project` given and no active project set yet in this session. "
        "Pass `project` explicitly, or call list_projects to see what's indexed."
    )


def _project_row(conn, name: str):
    """Look up a project, auto-refreshing it first if it's a git repo whose
    HEAD or working-tree state has changed since it was last indexed. This
    is why every query tool is safe to call without an explicit
    index_repository first, as long as the project has been indexed once."""
    row = conn.execute("SELECT * FROM projects WHERE name = ?", (name,)).fetchone()
    if row is None:
        available = [r["name"] for r in conn.execute("SELECT name FROM projects")]
        raise ToolError(
            f"No indexed project named '{name}'. "
            f"Indexed projects: {available or '(none yet)'}. "
            f"Call index_repository first."
        )
    root = Path(row["root_path"])
    sig = gitutil.git_signature(root)
    if sig is not None and sig != row["git_signature"]:
        indexer.index_repository(conn, row["name"], str(root))
        store.set_git_signature(conn, row["id"], sig)
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (row["id"],)).fetchone()
    return row


def _callers_of(conn, project_id: int, sym) -> list:
    return conn.execute(
        "SELECT s.* FROM calls c JOIN symbols s ON s.id = c.caller_symbol_id "
        "WHERE c.callee_name = ? AND c.project_id = ?",
        (sym["name"], project_id),
    ).fetchall()


def _callees_of(conn, project_id: int, sym) -> tuple[list, list]:
    names = [r["callee_name"] for r in conn.execute(
        "SELECT DISTINCT callee_name FROM calls WHERE caller_symbol_id = ?", (sym["id"],)
    ).fetchall()]
    resolved, unresolved = [], []
    for name in names:
        matches = conn.execute(
            "SELECT * FROM symbols WHERE project_id = ? AND name = ?", (project_id, name)
        ).fetchall()
        if not matches:
            unresolved.append(name)
        elif len(matches) > MAX_CALLEE_FANOUT:
            unresolved.append(f"{name} ({len(matches)} project-wide matches, too common to resolve)")
        else:
            resolved.extend(matches)
    return resolved, unresolved


def _read_snippet(conn, project_row, sym) -> tuple[dict, str]:
    file_row = conn.execute("SELECT * FROM files WHERE id = ?", (sym["file_id"],)).fetchone()
    full_path = Path(project_row["root_path"]) / file_row["path"]
    try:
        data = full_path.read_bytes()
    except OSError as e:
        raise ToolError(f"Could not read {full_path}: {e}")
    current_sha1 = hashlib.sha1(data).hexdigest()
    if current_sha1 != file_row["sha1"]:
        raise ToolError(
            f"{file_row['path']} has changed on disk since it was indexed -- "
            f"line offsets may be stale. Run index_repository again first."
        )
    return file_row, data[sym["start_byte"]:sym["end_byte"]].decode("utf8", "replace")


@mcp.tool(
    description=(
        "Index (or re-index) a local repo into the code graph: parses every "
        "supported source file with tree-sitter and records its functions and "
        "methods (classes/namespaces/impls are used to build qualified names, "
        "e.g. Class.method, but aren't stored as symbols of their own) and "
        "best-effort call edges into SQLite. Incremental "
        "-- unchanged files (by content hash) are skipped, so re-running "
        "after a small edit is fast. Call this once per project before using "
        "the other tools, and again after making non-trivial edits so the "
        "graph doesn't go stale (though for git repos the other tools auto-refresh "
        "on their own -- see server instructions). Supported languages: C#, Python, "
        "JavaScript, TypeScript/TSX, Rust, Go -- other files are ignored."
    ),
    annotations={"readOnlyHint": False, "idempotentHint": True, "openWorldHint": False},
)
def index_repository(project: str, repo_path: str) -> dict:
    conn = _conn()
    try:
        result = indexer.index_repository(conn, project, repo_path)
    except FileNotFoundError as e:
        raise ToolError(str(e))
    _state["active_project"] = project
    row = conn.execute("SELECT id FROM projects WHERE name = ?", (project,)).fetchone()
    store.set_git_signature(conn, row["id"], gitutil.git_signature(Path(repo_path).resolve()))
    conn.commit()
    return {
        "project": project,
        "files_scanned": result.files_scanned,
        "files_indexed": result.files_indexed,
        "files_skipped_unchanged": result.files_skipped_unchanged,
        "files_removed": result.files_removed,
        "symbols_found": result.symbols_found,
        "calls_found": result.calls_found,
        "errors": result.errors[:10],
    }


@mcp.tool(
    description="List every indexed project with file/symbol counts and when it was last indexed. Call this first if you don't know the exact project name a repo was indexed under.",
    annotations=RO,
)
def list_projects() -> list[dict]:
    conn = _conn()
    rows = conn.execute("SELECT * FROM projects").fetchall()
    out = []
    for p in rows:
        files = conn.execute("SELECT COUNT(*) c FROM files WHERE project_id = ?", (p["id"],)).fetchone()["c"]
        symbols = conn.execute("SELECT COUNT(*) c FROM symbols WHERE project_id = ?", (p["id"],)).fetchone()["c"]
        out.append({
            "project": p["name"],
            "root_path": p["root_path"],
            "last_indexed_at": p["last_indexed_at"],
            "files": files,
            "symbols": symbols,
        })
    return out


@mcp.tool(
    description=(
        "Search indexed functions/methods/classes by name substring (case-insensitive). "
        "Returns qualified_name, kind, file, and line range for each match -- use "
        "qualified_name with get_code_snippet or trace_calls. Prefer this over Grep "
        "when you're looking for a symbol by name, not arbitrary text."
    ),
    annotations=RO,
)
def search_symbols(query: str, project: str | None = None, kind: str | None = None, limit: int = 30) -> dict:
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    limit = max(1, min(limit, 200))
    sql = (
        "SELECT s.kind, s.qualified_name, s.name, f.path, s.start_line, s.end_line "
        "FROM symbols s JOIN files f ON f.id = s.file_id "
        "WHERE s.project_id = ? AND s.name LIKE ?"
    )
    params: list = [p["id"], f"%{query}%"]
    if kind:
        sql += " AND s.kind = ?"
        params.append(kind)
    total = conn.execute(f"SELECT COUNT(*) c FROM ({sql})", params).fetchone()["c"]
    sql += " ORDER BY s.qualified_name LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    results = [
        {
            "kind": r["kind"], "qualified_name": r["qualified_name"],
            "file": r["path"], "start_line": r["start_line"], "end_line": r["end_line"],
        }
        for r in rows
    ]
    out = {"results": results, "shown": len(results), "total_matches": total}
    if total > len(results):
        out["note"] = f"Showing {len(results)} of {total} matches. Narrow `query` or set `kind` to see the rest."
    return out


def _file_path_for(conn, sym) -> str:
    return conn.execute("SELECT path FROM files WHERE id = ?", (sym["file_id"],)).fetchone()["path"]


def _sibling_name_count(conn, project_id: int, name: str) -> int:
    """How many symbols in this project share this bare name. >1 means callers
    found for one of them (matched by bare name -- see _callers_of) may actually
    belong to a different same-named symbol elsewhere in the project."""
    return conn.execute(
        "SELECT COUNT(*) c FROM symbols WHERE project_id = ? AND name = ?", (project_id, name)
    ).fetchone()["c"]


def _resolve_one_symbol(conn, project_id: int, qualified_name: str, file: str | None = None):
    rows = conn.execute(
        "SELECT * FROM symbols WHERE project_id = ? AND qualified_name = ?",
        (project_id, qualified_name),
    ).fetchall()
    if not rows:
        # fall back to suffix match (caller may have passed just Class.Method or Method)
        rows = conn.execute(
            "SELECT * FROM symbols WHERE project_id = ? AND qualified_name LIKE ?",
            (project_id, f"%{qualified_name}"),
        ).fetchall()
    if not rows:
        raise ToolError(f"No symbol matching '{qualified_name}' in this project. Use search_symbols to find the exact qualified_name.")
    if file and len(rows) > 1:
        narrowed = [r for r in rows if _file_path_for(conn, r) == file or _file_path_for(conn, r).endswith(file)]
        if narrowed:
            rows = narrowed
    if len(rows) > 1:
        candidates = [f"{r['qualified_name']} ({_file_path_for(conn, r)}:{r['start_line']})" for r in rows[:10]]
        raise ToolError(
            f"'{qualified_name}' is ambiguous ({len(rows)} matches). Candidates: {candidates}. "
            f"Pass a more specific qualified_name, or pass `file` (exact path or suffix, e.g. a "
            f"unique trailing segment) to disambiguate."
        )
    return rows[0]


@mcp.tool(
    description=(
        "Trace the call graph around one function/method by qualified_name (from "
        "search_symbols). direction='callers' finds who calls it (backed by real call "
        "sites, but matched by bare name -- if this symbol's name isn't unique in the "
        "project, callers of a different same-named symbol can be mixed in; the response "
        "flags this with `callers_caveat` when it applies), direction='callees' finds what "
        "it calls (best-effort name matching, no type inference -- may include false "
        "positives for overloaded/duplicate names, and calls into external libraries "
        "show up as unresolved leaf names). direction='both' returns one hop each way. "
        "depth controls how many hops to expand (1-10). If qualified_name is ambiguous "
        "(matches multiple symbols), pass `file` (exact path or unique suffix) to pick one. "
        "Use this instead of grepping for a function name across the repo."
    ),
    annotations=RO,
)
def trace_calls(
    qualified_name: str,
    project: str | None = None,
    direction: str = "both",
    depth: int = 1,
    file: str | None = None,
) -> dict:
    if direction not in ("callers", "callees", "both"):
        raise ToolError("direction must be 'callers', 'callees', or 'both'")
    depth = max(1, min(depth, 10))
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    root = _resolve_one_symbol(conn, p["id"], qualified_name, file)

    def callers_of(sym):
        return _callers_of(conn, p["id"], sym)

    def callees_of(sym):
        return _callees_of(conn, p["id"], sym)

    # A safety valve, not a practical limit -- these are personal-repo-scale
    # projects (low hundreds of symbols at most), so the BFS naturally
    # terminates via visited_ids/empty frontier well below this. It exists to
    # bound a genuinely pathological graph, not to truncate real results.
    MAX_NODES = 2000

    def bfs(expand_fn, direction_label):
        visited_ids = {root["id"]}
        frontier = [root]
        edges = []
        unresolved_leaves = set()
        for _ in range(depth):
            next_frontier = []
            for sym in frontier:
                if direction_label == "callees":
                    resolved, unresolved = expand_fn(sym)
                    unresolved_leaves.update(unresolved)
                    neighbors = resolved
                else:
                    neighbors = expand_fn(sym)
                for n in neighbors:
                    edges.append({"from": sym["qualified_name"], "to": n["qualified_name"]})
                    if n["id"] not in visited_ids:
                        visited_ids.add(n["id"])
                        next_frontier.append(n)
                    if len(visited_ids) > MAX_NODES:
                        return edges, unresolved_leaves, True
            frontier = next_frontier
            if not frontier:
                break
        return edges, unresolved_leaves, False

    out: dict = {"root": root["qualified_name"], "direction": direction, "depth": depth}
    if direction in ("callers", "both"):
        edges, _, truncated = bfs(callers_of, "callers")
        out["callers"] = edges
        if truncated:
            out["callers_truncated"] = True
        sibling_count = _sibling_name_count(conn, p["id"], root["name"])
        if sibling_count > 1:
            out["callers_caveat"] = (
                f"'{root['name']}' is not a unique name in this project ({sibling_count} symbols "
                "share it) -- callers are matched by bare name, so some of these may actually "
                "call a different same-named symbol."
            )
    if direction in ("callees", "both"):
        edges, unresolved, truncated = bfs(callees_of, "callees")
        out["callees"] = edges
        out["callees_unresolved"] = sorted(unresolved)[:40]
        if truncated:
            out["callees_truncated"] = True
    return out


@mcp.tool(
    description=(
        "Return just one function/method's source code by qualified_name, without "
        "reading the whole file. Use this instead of Read when you only need one "
        "function -- much cheaper for large files. Fails closed with a clear error "
        "if the file changed on disk since it was indexed (re-run index_repository). "
        "If qualified_name is ambiguous (matches multiple symbols, e.g. duplicated "
        "across a template/vendor dir), pass `file` (exact path or unique suffix) to pick one."
    ),
    annotations=RO,
)
def get_code_snippet(qualified_name: str, project: str | None = None, file: str | None = None) -> dict:
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    sym = _resolve_one_symbol(conn, p["id"], qualified_name, file)
    file_row, snippet = _read_snippet(conn, p, sym)
    return {
        "qualified_name": sym["qualified_name"],
        "kind": sym["kind"],
        "file": file_row["path"],
        "start_line": sym["start_line"],
        "end_line": sym["end_line"],
        "source": snippet,
    }


@mcp.tool(
    description=(
        "One call for 'show me this function and what touches it': returns its source "
        "plus its immediate callers and callees together. Use this instead of chaining "
        "get_code_snippet + trace_calls when investigating a function -- same data, one "
        "round trip instead of two or three. If qualified_name is ambiguous (matches "
        "multiple symbols), pass `file` (exact path or unique suffix) to pick one."
    ),
    annotations=RO,
)
def get_symbol_overview(qualified_name: str, project: str | None = None, file: str | None = None) -> dict:
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    sym = _resolve_one_symbol(conn, p["id"], qualified_name, file)
    file_row, snippet = _read_snippet(conn, p, sym)
    callers = _callers_of(conn, p["id"], sym)
    callees_resolved, callees_unresolved = _callees_of(conn, p["id"], sym)
    caller_names = sorted({c["qualified_name"] for c in callers})
    out = {
        "qualified_name": sym["qualified_name"],
        "kind": sym["kind"],
        "file": file_row["path"],
        "start_line": sym["start_line"],
        "end_line": sym["end_line"],
        "source": snippet,
        "callers": caller_names[:30],
        "caller_count": len(caller_names),
        "callees": sorted({c["qualified_name"] for c in callees_resolved}),
        "callees_unresolved": sorted(set(callees_unresolved))[:20],
    }
    if len(caller_names) > 30:
        out["note"] = f"Showing 30 of {len(caller_names)} callers."
    sibling_count = _sibling_name_count(conn, p["id"], sym["name"])
    if sibling_count > 1:
        out["callers_caveat"] = (
            f"'{sym['name']}' is not a unique name in this project ({sibling_count} symbols "
            "share it) -- callers are matched by bare name, so some of these may actually "
            "call a different same-named symbol."
        )
    return out


@mcp.tool(
    description=(
        "Map this project's uncommitted git changes (working tree vs HEAD) to the "
        "functions/methods they touched, plus each touched symbol's immediate callers "
        "as a rough blast radius before you consider a change done. risk='high' is a "
        "crude heuristic (>5 callers) -- a hint to look closer, not a verdict. Requires "
        "a git repo with uncommitted changes; says so clearly otherwise."
    ),
    annotations=RO,
)
def detect_changes(project: str | None = None) -> dict:
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    root = Path(p["root_path"])
    if not (root / ".git").exists():
        raise ToolError(f"'{project}' is not a git repository.")

    diff = subprocess.run(
        ["git", "-C", str(root), "diff", "--unified=0", "HEAD"],
        capture_output=True, text=True, timeout=5,
    )
    if diff.returncode != 0:
        raise ToolError(f"git diff failed: {diff.stderr.strip()[:200]}")
    if not diff.stdout.strip():
        return {"project": project, "changed_symbols": [], "note": "No uncommitted changes."}

    touched: dict[int, dict] = {}
    current_file = None
    for line in diff.stdout.splitlines():
        if line.startswith("+++ b/"):
            current_file = line[6:]
            continue
        if line.startswith("@@") and current_file:
            m = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if not m:
                continue
            start = int(m.group(1))
            count = int(m.group(2)) if m.group(2) is not None else 1
            if count == 0:
                continue
            end = start + count - 1
            file_row = conn.execute(
                "SELECT * FROM files WHERE project_id = ? AND path = ?", (p["id"], current_file)
            ).fetchone()
            if not file_row:
                continue
            rows = conn.execute(
                "SELECT * FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ?",
                (file_row["id"], end, start),
            ).fetchall()
            for r in rows:
                touched[r["id"]] = r

    out = []
    for sym in touched.values():
        callers = _callers_of(conn, p["id"], sym)
        caller_names = sorted({c["qualified_name"] for c in callers})
        out.append({
            "qualified_name": sym["qualified_name"],
            "kind": sym["kind"],
            "callers": caller_names[:20],
            "caller_count": len(caller_names),
            "risk": "high" if len(caller_names) > 5 else "low",
        })
    out.sort(key=lambda x: -x["caller_count"])
    return {"project": project, "changed_symbols": out}


@mcp.tool(
    description=(
        "One-call architecture overview of an indexed project: language breakdown, "
        "symbol counts by kind, top-level folders, and the files with the most "
        "symbols (rough proxy for where the real logic lives). Use this to orient "
        "in an unfamiliar or long-untouched repo instead of exploring file-by-file."
    ),
    annotations=RO,
)
def get_architecture(project: str | None = None) -> dict:
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    pid = p["id"]

    languages = {
        r["language"]: r["c"]
        for r in conn.execute(
            "SELECT language, COUNT(*) c FROM files WHERE project_id = ? GROUP BY language", (pid,)
        )
    }
    kinds = {
        r["kind"]: r["c"]
        for r in conn.execute(
            "SELECT kind, COUNT(*) c FROM symbols WHERE project_id = ? GROUP BY kind", (pid,)
        )
    }
    top_folders = [
        r["folder"]
        for r in conn.execute(
            "SELECT CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) "
            "ELSE '(root)' END AS folder, COUNT(*) c "
            "FROM files WHERE project_id = ? GROUP BY folder ORDER BY c DESC LIMIT 15",
            (pid,),
        )
    ]
    hotspots = [
        {"file": r["path"], "symbols": r["c"]}
        for r in conn.execute(
            "SELECT f.path, COUNT(*) c FROM symbols s JOIN files f ON f.id = s.file_id "
            "WHERE s.project_id = ? GROUP BY f.id ORDER BY c DESC LIMIT 10",
            (pid,),
        )
    ]
    return {
        "project": project,
        "root_path": p["root_path"],
        "last_indexed_at": p["last_indexed_at"],
        "languages": languages,
        "symbol_counts": kinds,
        "top_level_folders": top_folders,
        "hotspot_files": hotspots,
    }


@mcp.tool(
    description=(
        "A capped snapshot of a whole project's own internal call graph, for an "
        "overview rather than trace_calls' single-symbol trace: its highest-degree "
        "symbols (most callers+callees combined, a proxy for structural centrality) "
        "and the call edges among just those symbols. Use this to render or reason "
        "about a project's overall shape -- e.g. several projects side by side -- "
        "not to find a specific function (use search_symbols/trace_calls for that). "
        "limit caps how many symbols are included (default 40, max 200)."
    ),
    annotations=RO,
)
def project_graph(project: str | None = None, limit: int = 40) -> dict:
    project = _project_name(project)
    conn = _conn()
    p = _project_row(conn, project)
    pid = p["id"]
    limit = max(1, min(limit, 200))

    rows = conn.execute(
        """
        WITH out_deg AS (
            SELECT caller_symbol_id AS sid, COUNT(*) AS c
            FROM calls WHERE project_id = ? GROUP BY caller_symbol_id
        ), in_deg AS (
            SELECT callee.id AS sid, COUNT(*) AS c
            FROM calls c2
            JOIN symbols callee ON callee.project_id = c2.project_id AND callee.name = c2.callee_name
            WHERE c2.project_id = ?
            GROUP BY callee.id
        )
        SELECT s.id, s.qualified_name, s.kind, f.path AS file,
               COALESCE(out_deg.c, 0) + COALESCE(in_deg.c, 0) AS degree
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        LEFT JOIN out_deg ON out_deg.sid = s.id
        LEFT JOIN in_deg ON in_deg.sid = s.id
        WHERE s.project_id = ?
        ORDER BY degree DESC
        LIMIT ?
        """,
        (pid, pid, pid, limit),
    ).fetchall()

    # Symbol id, not qualified_name, is the node identity: the same bare name
    # (e.g. "main") commonly labels multiple distinct symbols in one project
    # (one per file), so name alone would collide two unrelated functions
    # into one graph node and misattribute edges between them.
    node_ids = [r["id"] for r in rows]
    nodes = [
        {"id": r["id"], "qualified_name": r["qualified_name"], "kind": r["kind"], "file": r["file"], "degree": r["degree"]}
        for r in rows
    ]

    edges: list[dict] = []
    if node_ids:
        placeholders = ",".join("?" for _ in node_ids)
        edge_rows = conn.execute(
            f"""
            SELECT DISTINCT caller.id AS from_id, callee.id AS to_id
            FROM calls c
            JOIN symbols caller ON caller.id = c.caller_symbol_id
            JOIN symbols callee ON callee.project_id = caller.project_id AND callee.name = c.callee_name
            WHERE caller.project_id = ? AND caller.id IN ({placeholders}) AND callee.id IN ({placeholders})
            """,
            (pid, *node_ids, *node_ids),
        ).fetchall()
        edges = [{"from": r["from_id"], "to": r["to_id"]} for r in edge_rows]

    return {"project": project, "nodes": nodes, "edges": edges}


if __name__ == "__main__":
    mcp.run()
