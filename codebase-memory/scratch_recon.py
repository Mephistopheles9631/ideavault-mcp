import tree_sitter_python as tspython
import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts
import tree_sitter_c_sharp as tscs
import tree_sitter_rust as tsrust
from tree_sitter import Language, Parser

samples = {
    "python": (tspython.language(), b"""
class Foo:
    def bar(self, x):
        return self.baz(x) + qux(x)

def qux(x):
    return x
"""),
    "javascript": (tsjs.language(), b"""
class Foo {
  bar(x) {
    return this.baz(x) + qux(x);
  }
}
function qux(x) { return x; }
const arrow = (x) => x + 1;
"""),
    "typescript": (tsts.language_typescript(), b"""
class Foo {
  bar(x: number): number {
    return this.baz(x) + qux(x);
  }
}
function qux(x: number): number { return x; }
interface Baz { qux(x: number): number; }
"""),
    "c_sharp": (tscs.language(), b"""
namespace App {
  public class Foo {
    public int Bar(int x) {
      return this.Baz(x) + Qux(x);
    }
    private int Baz(int x) => x;
  }
  public static class Utils {
    public static int Qux(int x) { return x; }
  }
}
"""),
    "rust": (tsrust.language(), b"""
struct Foo;
impl Foo {
    fn bar(&self, x: i32) -> i32 {
        self.baz(x) + qux(x)
    }
    fn baz(&self, x: i32) -> i32 { x }
}
fn qux(x: i32) -> i32 { x }
"""),
}

def dump(node, src, depth=0, max_depth=12):
    if depth > max_depth:
        return
    text = src[node.start_byte:node.end_byte]
    snippet = text[:40].replace(b"\n", b"\\n").decode("utf8", "replace")
    print("  " * depth + f"{node.type}  [{snippet!r}]")
    for child in node.children:
        dump(child, src, depth + 1, max_depth)

for lang_name, (lang_capsule, src) in samples.items():
    print(f"\n=== {lang_name} ===")
    lang = Language(lang_capsule)
    parser = Parser(lang)
    tree = parser.parse(src)
    dump(tree.root_node, src)
