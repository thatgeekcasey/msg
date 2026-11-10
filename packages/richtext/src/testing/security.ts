// What no rendered body may hold, checked as a browser would read it: the security assertions, which
// hold whatever the Rails oracle says.

import { ParseLimitError } from "../markup";
import { parseHtml } from "../parse";
import type { SafeList } from "../sanitize";
import { descendants } from "../tree";

const DANGEROUS_ELEMENTS = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "form", "input", "button",
  "textarea", "select", "svg", "math", "template", "noscript", "xmp", "plaintext", "noembed",
]);

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "background", "xlink:href", "srcset", "data"]);

/** A URL that runs script: control characters and whitespace ignored and case folded, as a browser reads it. */
export function dangerousUrl(value: string): boolean {
  const cleaned = value.replace(/[\p{Cc}\p{White_Space}]/gu, "").toLowerCase();
  if (/^(?:javascript|vbscript|livescript):/.test(cleaned)) return true;
  if (!cleaned.startsWith("data:")) return false;
  // A data: URL is only dangerous as markup or script; an unparseable media type is text/plain
  const mediatype = cleaned.slice("data:".length).split(",")[0]!.split(";")[0]!;
  const slash = mediatype.indexOf("/");
  const token = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;
  const valid = slash >= 0 && token.test(mediatype.slice(0, slash)) && token.test(mediatype.slice(slash + 1));
  return valid && ["html", "xml", "svg", "script", "ecmascript"].some((kind) => mediatype.includes(kind));
}

/** The security violations in rendered markup: what `allowed` doesn't list, and anything that runs script. */
export function securityViolations(html: string, allowed: SafeList): string[] {
  let fragment;
  try {
    fragment = parseHtml(html);
  } catch (error) {
    if (error instanceof ParseLimitError) return ["unparseable output"];
    throw error;
  }
  const violations: string[] = [];
  for (const node of descendants(fragment)) {
    if (node.kind !== "element") continue;
    if (DANGEROUS_ELEMENTS.has(node.name)) violations.push(`<${node.name}> element`);
    if (!allowed.tags.has(node.name)) violations.push(`<${node.name}> not in the allowlist`);
    for (const { name, value } of node.attrs) {
      const lower = name.toLowerCase();
      if (!allowed.attributes.has(name)) violations.push(`${name} on <${node.name}> not in the allowlist`);
      if (lower.startsWith("on")) violations.push(`${name} attribute on <${node.name}>`);
      if (URL_ATTRIBUTES.has(lower) && dangerousUrl(value)) violations.push(`${name}=${JSON.stringify(value)} on <${node.name}>`);
      if (lower === "style") violations.push(`style on <${node.name}>`);
      if (lower.startsWith("data-") && lower !== "data-language") violations.push(`${name} on <${node.name}>`);
    }
  }
  return violations;
}
