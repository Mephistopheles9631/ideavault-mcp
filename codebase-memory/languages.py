"""Per-language tree-sitter configuration.

Field names below (container_name_field, member_access_types, etc.) were
confirmed empirically against the installed grammar versions via
node.child_by_field_name() -- not guessed from memory. See scratch_recon.py
/ check_fields.py in this directory for the recon that produced them.
"""

from dataclasses import dataclass, field

import tree_sitter_bash as tsbash
import tree_sitter_c_sharp as tscs
import tree_sitter_go as tsgo
import tree_sitter_javascript as tsjs
import tree_sitter_python as tspython
import tree_sitter_rust as tsrust
import tree_sitter_typescript as tsts
from tree_sitter import Language


@dataclass(frozen=True)
class LanguageConfig:
    name: str
    ts_language: Language
    sep: str
    # node type -> symbol kind, for scope-introducing declarations (classes, impls, ...)
    container_types: dict[str, str]
    # node type -> field name holding the container's name (default "name")
    container_name_field: dict[str, str] = field(default_factory=dict)
    # node type -> symbol kind for callable declarations
    function_types: dict[str, str] = field(default_factory=dict)
    # node types that represent a call expression
    call_types: frozenset[str] = frozenset()
    # call node type -> field name holding the callee expression (default "function")
    call_function_field: dict[str, str] = field(default_factory=dict)
    # node type (of the callee expression) -> field holding the final identifier,
    # for member/attribute/field access call targets (obj.method())
    member_access_types: dict[str, str] = field(default_factory=dict)
    # extra ad-hoc rule for JS/TS: const x = (...) => ... / function(...) {...}
    detect_variable_function: bool = False
    # Go-style: methods aren't nested in a class body, they carry a receiver
    # field (e.g. "func (f *Foo) Bar()") that determines the qualified name.
    method_receiver_field: str | None = None


PYTHON = LanguageConfig(
    name="python",
    ts_language=Language(tspython.language()),
    sep=".",
    container_types={"class_definition": "Class"},
    function_types={"function_definition": "Function"},
    call_types=frozenset({"call"}),
    member_access_types={"attribute": "attribute"},
)

JAVASCRIPT = LanguageConfig(
    name="javascript",
    ts_language=Language(tsjs.language()),
    sep=".",
    container_types={"class_declaration": "Class"},
    function_types={
        "method_definition": "Function",
        "function_declaration": "Function",
    },
    call_types=frozenset({"call_expression"}),
    member_access_types={"member_expression": "property"},
    detect_variable_function=True,
)

TYPESCRIPT = LanguageConfig(
    name="typescript",
    ts_language=Language(tsts.language_typescript()),
    sep=".",
    container_types={
        "class_declaration": "Class",
        "interface_declaration": "Interface",
    },
    function_types={
        "method_definition": "Function",
        "function_declaration": "Function",
        "method_signature": "Function",
    },
    call_types=frozenset({"call_expression"}),
    member_access_types={"member_expression": "property"},
    detect_variable_function=True,
)

TSX = LanguageConfig(
    name="tsx",
    ts_language=Language(tsts.language_tsx()),
    sep=".",
    container_types=TYPESCRIPT.container_types,
    function_types=TYPESCRIPT.function_types,
    call_types=TYPESCRIPT.call_types,
    member_access_types=TYPESCRIPT.member_access_types,
    detect_variable_function=True,
)

CSHARP = LanguageConfig(
    name="c_sharp",
    ts_language=Language(tscs.language()),
    sep=".",
    container_types={
        "class_declaration": "Class",
        "interface_declaration": "Interface",
        "struct_declaration": "Struct",
        "record_declaration": "Record",
        "namespace_declaration": "Namespace",
        "file_scoped_namespace_declaration": "Namespace",
    },
    function_types={
        "method_declaration": "Function",
        "constructor_declaration": "Function",
        "local_function_statement": "Function",
    },
    call_types=frozenset({"invocation_expression"}),
    member_access_types={"member_access_expression": "name"},
)

RUST = LanguageConfig(
    name="rust",
    ts_language=Language(tsrust.language()),
    sep="::",
    container_types={
        "impl_item": "Impl",
        "trait_item": "Trait",
        "mod_item": "Module",
    },
    container_name_field={"impl_item": "type"},
    function_types={"function_item": "Function"},
    call_types=frozenset({"call_expression"}),
    member_access_types={"field_expression": "field"},
)

GO = LanguageConfig(
    name="go",
    ts_language=Language(tsgo.language()),
    sep=".",
    container_types={},
    function_types={
        "method_declaration": "Function",
        "function_declaration": "Function",
    },
    call_types=frozenset({"call_expression"}),
    member_access_types={"selector_expression": "field"},
    method_receiver_field="receiver",
)

BASH = LanguageConfig(
    name="bash",
    ts_language=Language(tsbash.language()),
    sep=".",
    container_types={},
    function_types={"function_definition": "Function"},
    # Both `foo() { ... }` and `function foo { ... }` parse to the same
    # function_definition node with a "name" field -- no special-casing
    # needed for the two syntaxes.
    call_types=frozenset({"command"}),
    # Unlike the other languages here, the callee sits under a field named
    # "name" (holding a command_name node), not "function".
    call_function_field={"command": "name"},
    member_access_types={},
)

EXTENSION_MAP: dict[str, LanguageConfig] = {
    ".py": PYTHON,
    ".js": JAVASCRIPT,
    ".jsx": JAVASCRIPT,
    ".mjs": JAVASCRIPT,
    ".cjs": JAVASCRIPT,
    ".ts": TYPESCRIPT,
    ".tsx": TSX,
    ".cs": CSHARP,
    ".rs": RUST,
    ".go": GO,
    ".sh": BASH,
    ".bash": BASH,
}

IGNORED_DIR_NAMES = {
    ".git", ".hg", ".svn",
    "node_modules", "bin", "obj", "target", "dist", "build",
    "__pycache__", ".venv", "venv", "env",
    ".next", ".nuxt", ".cache", ".pytest_cache", ".mypy_cache",
    "vendor", "third_party", "packages",
}
