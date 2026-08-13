import tree_sitter_python as tspython
import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts
import tree_sitter_c_sharp as tscs
import tree_sitter_rust as tsrust
import tree_sitter_bash as tsbash
from tree_sitter import Language, Parser

def find(node, type_name):
    if node.type == type_name:
        yield node
    for c in node.children:
        yield from find(c, type_name)

cases = [
    ("python", tspython.language(), b"class Foo:\n    def bar(self, x):\n        return self.baz(x) + qux(x)\n",
     ["class_definition", "function_definition", "call", "attribute"]),
    ("javascript", tsjs.language(), b"class Foo { bar(x) { return this.baz(x) + qux(x); } }\nfunction top(x){return x;}\n",
     ["class_declaration", "method_definition", "function_declaration", "call_expression", "member_expression"]),
    ("typescript", tsts.language_typescript(), b"interface Baz { qux(x: number): number; }\n",
     ["interface_declaration", "method_signature"]),
    ("c_sharp", tscs.language(), b"class Foo { public int Bar(int x) { return this.Baz(x) + Qux(x); } }\n",
     ["class_declaration", "method_declaration", "invocation_expression", "member_access_expression"]),
    ("rust", tsrust.language(), b"impl Foo { fn bar(&self, x: i32) -> i32 { self.baz(x) + qux(x) } }\n",
     ["impl_item", "function_item", "call_expression", "field_expression"]),
    ("bash", tsbash.language(), b"foo() {\n  bar \"$1\"\n}\nfunction baz {\n  qux $x\n}\n",
     ["function_definition", "command", "command_name"]),
]

for name, lang_capsule, src, types in cases:
    print(f"\n=== {name} ===")
    lang = Language(lang_capsule)
    parser = Parser(lang)
    tree = parser.parse(src)
    for t in types:
        nodes = list(find(tree.root_node, t))
        if not nodes:
            print(f"  {t}: NOT FOUND")
            continue
        n = nodes[0]
        fields = {}
        for i in range(n.child_count):
            child = n.children[i]
            fname = n.field_name_for_child(i)
            if fname:
                fields.setdefault(fname, []).append(child.type)
        print(f"  {t}: fields={fields}")
