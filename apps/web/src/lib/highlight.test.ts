import hljs from "highlight.js/lib/core";
import { describe, expect, it } from "vitest";
import { highlight, type Token } from "./highlight";

/** Code in each of Campfire's 12 languages, using as many of its scopes as fit on a line or two. */
const SAMPLES: Record<string, string> = {
  bash: 'for f in *.txt; do echo "$f ${HOME}" | grep -v x; done # files',
  css: '@media screen { a[href^="x"]:hover, #b::before { color: #fff !important; width: calc(1px + 2em); } }',
  diff: "@@ -1,2 +1,2 @@\n-old\n+new\n context",
  go: 'func main() { var x int = 1; fmt.Println(`raw`, x, nil, true) } // done',
  java: '@Override public void m(String s) { System.out.println("x" + s); } /** @param s */',
  javascript: 'class A extends B { static m() { return `t ${this.p}`; } }\nconsole.log(/re/g, null, NaN);',
  json: '{ "a": [1, 2.5, true, null], "b": { "c": "d" } }',
  python: '@decorator\ndef f(self, x: int = 1) -> None:\n    print(f"{x!r}", True)  # done',
  ruby: 'def f(a, *b) = puts "#{a}" if @x && $y # done\n%w[a b]; :sym',
  rust: '#[derive(Debug)]\nfn new() -> Self { let mut v = vec![1u8]; println!("{}", v.len()) }',
  sql: "SELECT a.x, COUNT(*) AS n FROM t a WHERE x = 'y' GROUP BY 1; -- done",
  xml: '<!-- c --><html lang="en"><style>a { color: red }</style><script>let x = 1;</script>&amp;</html>',
};

const classesOf = (tokens: Token[]): string[] =>
  tokens.flatMap((token) => (typeof token === "string" ? [] : [token.className, ...classesOf(token.children)]));

const textOf = (tokens: Token[]): string => tokens.map((token) => (typeof token === "string" ? token : textOf(token.children))).join("");

describe("Rich text, safely", () => {
  it.each(Object.entries(SAMPLES))("keeps the text of %s code and every class highlight.js gives it", (language, code) => {
    const tokens = highlight(code, language);
    expect(textOf(tokens)).toBe(code);
    const given = [...hljs.highlight(code, { language, ignoreIllegals: true }).value.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);
    expect(classesOf(tokens)).toEqual(given);
  });

  it("keeps the spaces and blank lines code starts with", () => {
    for (const code of ["  return a;\n}", "\n\nconst a = 1;", " \n", "\tx"]) expect(textOf(highlight(code, "javascript"))).toBe(code);
  });

  it("highlights code that names no language it knows as whichever fits best", () => {
    expect(classesOf(highlight("SELECT name FROM users;", "cobol"))).toContain("hljs-keyword");
    expect(textOf(highlight("SELECT name FROM users;", undefined))).toBe("SELECT name FROM users;");
  });
});
