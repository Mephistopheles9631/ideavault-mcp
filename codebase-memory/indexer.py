"""Walks a repo, parses supported files with tree-sitter, and populates the
graph store. Best-effort, name-based call resolution -- no type inference.
A call site is only recorded if we can already tell which enclosing
function/method it lives in; anything outside a known symbol (module-level
statements, etc.) is skipped rather than guessed at.
"""

import hashlib
import time
from dataclasses import dataclass
from pathlib import Path

from tree_sitter import Node, Parser

import store
from languages import EXTENSION_MAP, IGNORED_DIR_NAMES, LanguageConfig


@dataclass
class IndexResult:
    files_scanned: int
    files_indexed: int
    files_skipped_unchanged: int
    files_removed: int
    symbols_found: int
    calls_found: int
    errors: list[str]


def _text(node: Node, src: bytes) -> str:
    return src[node.start_byte:node.end_byte].decode("utf8", "replace")


def _iter_files(root: Path):
    for path in root.rglob("*"):
        if path.is_dir():
            continue
        if any(part in IGNORED_DIR_NAMES for part in path.parts):
            continue
        if path.suffix not in EXTENSION_MAP:
            continue
        if path.is_symlink():
            continue
        yield path


def _find_first_type_identifier(node: Node, src: bytes) -> str | None:
    if node.type == "type_identifier":
        return _text(node, src)
    for child in node.children:
        found = _find_first_type_identifier(child, src)
        if found:
            return found
    return None


def _resolve_callee_name(cfg: LanguageConfig, func_node: Node, src: bytes) -> str | None:
    if func_node.type in cfg.member_access_types:
        field_name = cfg.member_access_types[func_node.type]
        target = func_node.child_by_field_name(field_name)
        return _text(target, src) if target is not None else None
    if "identifier" in func_node.type:
        return _text(func_node, src)
    return None


def _walk(
    node: Node,
    src: bytes,
    cfg: LanguageConfig,
    conn,
    project_id: int,
    file_id: int,
    stack: list[str],
    current_symbol_id: int | None,
    counts: dict,
) -> None:
    t = node.type

    if t in cfg.container_types:
        field_name = cfg.container_name_field.get(t, "name")
        name_node = node.child_by_field_name(field_name)
        if name_node is not None:
            stack = stack + [_text(name_node, src)]

    elif t in cfg.function_types:
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, src)
            receiver_type = None
            if cfg.method_receiver_field:
                recv_node = node.child_by_field_name(cfg.method_receiver_field)
                if recv_node is not None:
                    receiver_type = _find_first_type_identifier(recv_node, src)
            if receiver_type:
                qualified = cfg.sep.join([receiver_type, name])
                kind = "Method"
                new_stack = stack + [receiver_type, name]
            else:
                qualified = cfg.sep.join(stack + [name])
                kind = "Method" if stack else "Function"
                new_stack = stack + [name]
            current_symbol_id = store.insert_symbol(
                conn, project_id, file_id, kind, name, qualified,
                node.start_point[0] + 1, node.end_point[0] + 1,
                node.start_byte, node.end_byte,
            )
            counts["symbols"] += 1
            stack = new_stack

    elif cfg.detect_variable_function and t == "variable_declarator":
        value_node = node.child_by_field_name("value")
        name_node = node.child_by_field_name("name")
        if (
            value_node is not None
            and name_node is not None
            and value_node.type in ("arrow_function", "function_expression")
        ):
            name = _text(name_node, src)
            qualified = cfg.sep.join(stack + [name])
            kind = "Method" if stack else "Function"
            current_symbol_id = store.insert_symbol(
                conn, project_id, file_id, kind, name, qualified,
                node.start_point[0] + 1, node.end_point[0] + 1,
                node.start_byte, node.end_byte,
            )
            counts["symbols"] += 1
            stack = stack + [name]

    elif t in cfg.call_types:
        func_node = node.child_by_field_name("function")
        if func_node is not None and current_symbol_id is not None:
            callee = _resolve_callee_name(cfg, func_node, src)
            if callee:
                store.insert_call(conn, project_id, current_symbol_id, callee)
                counts["calls"] += 1

    for child in node.children:
        _walk(child, src, cfg, conn, project_id, file_id, stack, current_symbol_id, counts)


_PARSERS: dict[str, Parser] = {}


def _parser_for(cfg: LanguageConfig) -> Parser:
    if cfg.name not in _PARSERS:
        _PARSERS[cfg.name] = Parser(cfg.ts_language)
    return _PARSERS[cfg.name]


def index_repository(conn, project_name: str, repo_path: str) -> IndexResult:
    root = Path(repo_path).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Not a directory: {root}")

    project_id = store.get_or_create_project(conn, project_name, str(root))

    files_scanned = files_indexed = files_skipped_unchanged = 0
    symbols_found = calls_found = 0
    errors: list[str] = []
    seen_paths: set[str] = set()

    for path in _iter_files(root):
        files_scanned += 1
        rel_path = str(path.relative_to(root))
        seen_paths.add(rel_path)
        cfg = EXTENSION_MAP[path.suffix]

        try:
            data = path.read_bytes()
        except OSError as e:
            errors.append(f"{rel_path}: {e}")
            continue

        mtime = path.stat().st_mtime
        sha1 = hashlib.sha1(data).hexdigest()

        existing = store.get_file(conn, project_id, rel_path)
        if existing is not None and existing["sha1"] == sha1:
            files_skipped_unchanged += 1
            continue

        try:
            parser = _parser_for(cfg)
            tree = parser.parse(data)
        except Exception as e:
            errors.append(f"{rel_path}: parse failed: {e}")
            continue

        file_id = store.upsert_file(conn, project_id, rel_path, cfg.name, mtime, sha1)

        counts = {"symbols": 0, "calls": 0}
        _walk(tree.root_node, data, cfg, conn, project_id, file_id, [], None, counts)
        symbols_found += counts["symbols"]
        calls_found += counts["calls"]
        files_indexed += 1

    files_removed = store.delete_missing_files(conn, project_id, seen_paths)

    conn.execute(
        "UPDATE projects SET last_indexed_at = ? WHERE id = ?",
        (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), project_id),
    )
    conn.commit()

    return IndexResult(
        files_scanned=files_scanned,
        files_indexed=files_indexed,
        files_skipped_unchanged=files_skipped_unchanged,
        files_removed=files_removed,
        symbols_found=symbols_found,
        calls_found=calls_found,
        errors=errors,
    )
