"""SQLite-backed storage for the code graph."""

import sqlite3
from pathlib import Path

DB_PATH = Path.home() / ".cache" / "codebase-memory" / "graph.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    root_path TEXT NOT NULL,
    last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    mtime REAL NOT NULL,
    sha1 TEXT NOT NULL,
    UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified_name ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);

CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    callee_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON calls(callee_name);
"""


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
    if "git_signature" not in cols:
        conn.execute("ALTER TABLE projects ADD COLUMN git_signature TEXT")


def set_git_signature(conn: sqlite3.Connection, project_id: int, signature: str | None) -> None:
    conn.execute("UPDATE projects SET git_signature = ? WHERE id = ?", (signature, project_id))


def get_or_create_project(conn: sqlite3.Connection, name: str, root_path: str) -> int:
    row = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
    if row:
        conn.execute("UPDATE projects SET root_path = ? WHERE id = ?", (root_path, row["id"]))
        return row["id"]
    cur = conn.execute(
        "INSERT INTO projects (name, root_path) VALUES (?, ?)", (name, root_path)
    )
    return cur.lastrowid


def get_file(conn: sqlite3.Connection, project_id: int, rel_path: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM files WHERE project_id = ? AND path = ?", (project_id, rel_path)
    ).fetchone()


def upsert_file(
    conn: sqlite3.Connection, project_id: int, rel_path: str, language: str, mtime: float, sha1: str
) -> int:
    existing = get_file(conn, project_id, rel_path)
    if existing:
        conn.execute("DELETE FROM symbols WHERE file_id = ?", (existing["id"],))
        conn.execute(
            "UPDATE files SET language = ?, mtime = ?, sha1 = ? WHERE id = ?",
            (language, mtime, sha1, existing["id"]),
        )
        return existing["id"]
    cur = conn.execute(
        "INSERT INTO files (project_id, path, language, mtime, sha1) VALUES (?, ?, ?, ?, ?)",
        (project_id, rel_path, language, mtime, sha1),
    )
    return cur.lastrowid


def delete_missing_files(conn: sqlite3.Connection, project_id: int, seen_paths: set[str]) -> int:
    rows = conn.execute("SELECT id, path FROM files WHERE project_id = ?", (project_id,)).fetchall()
    stale_ids = [r["id"] for r in rows if r["path"] not in seen_paths]
    if stale_ids:
        conn.executemany("DELETE FROM files WHERE id = ?", [(i,) for i in stale_ids])
    return len(stale_ids)


def insert_symbol(
    conn: sqlite3.Connection,
    project_id: int,
    file_id: int,
    kind: str,
    name: str,
    qualified_name: str,
    start_line: int,
    end_line: int,
    start_byte: int,
    end_byte: int,
) -> int:
    cur = conn.execute(
        """INSERT INTO symbols
           (project_id, file_id, kind, name, qualified_name, start_line, end_line, start_byte, end_byte)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (project_id, file_id, kind, name, qualified_name, start_line, end_line, start_byte, end_byte),
    )
    return cur.lastrowid


def insert_call(conn: sqlite3.Connection, project_id: int, caller_symbol_id: int, callee_name: str) -> None:
    conn.execute(
        "INSERT INTO calls (project_id, caller_symbol_id, callee_name) VALUES (?, ?, ?)",
        (project_id, caller_symbol_id, callee_name),
    )
