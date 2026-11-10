import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";

// Campfire's code highlighting (app/javascript/initializers/highlight.js): highlight.js 11.9.0, which it
// vendors, with the same 12 languages. Messages load this when they first show a code block.

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("xml", xml);

/** Highlighted code: its text, and the spans highlight.js classes parts of it with. */
export type Token = string | { className: string; children: Token[] };

/** The classes highlight.js gives a span: its scopes (`hljs-built_in`, `hljs-title class_`), and the languages it switches to. */
const HIGHLIGHT_CLASS = /^(?:hljs-[a-z_-]+|[a-z]+_+|language-[a-z]+)$/;

/**
 * Code as Campfire's `MessageFormatter` highlights it: in its language when that's one of the 12
 * (or an alias of one, such as `js`), and otherwise in whichever of them fits best.
 */
export function highlight(code: string, language: string | undefined): Token[] {
  const { value } = language && hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }) : hljs.highlightAuto(code);
  // Read in a document of its own, which runs and loads nothing, rather than set on the page, and in
  // its body from the start: before it, the parser drops the spaces and newlines code starts with.
  return tokensOf(new DOMParser().parseFromString(`<body>${value}`, "text/html").body);
}

function tokensOf(parent: Node): Token[] {
  return Array.from(parent.childNodes, (node): Token => {
    if (node.nodeType !== Node.ELEMENT_NODE) return node.textContent ?? "";
    const classes = Array.from((node as Element).classList).filter((name) => HIGHLIGHT_CLASS.test(name));
    return { className: classes.join(" "), children: tokensOf(node) };
  });
}
