import { describe, expect, it } from "vitest";
import { urlsafeDecode64 } from "../src/encoding";
import { qrCode, qrCodeSvg } from "@ember/protocol/qr-code";
import rqrcode from "./fixtures/rqrcode.json";
import { api, signIn } from "./support";

/**
 * The golden vectors, which rqrcode 3.2.0 made itself: each input's version and modules, and the whole
 * SVG for five of them.
 */
const vectors: Array<{ input_base64: string; version: number; modules: string; svg?: string }> = rqrcode;

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);
const decoded = (id: string) => {
  const bytes = urlsafeDecode64(id);
  return bytes && Array.from(bytes);
};

describe("QR codes for links", () => {
  it("draws every golden vector as rqrcode does, version, modules and SVG", () => {
    expect(vectors).toHaveLength(39);
    for (const vector of vectors) {
      const input = bytesOf(vector.input_base64);
      const code = qrCode(input);
      expect(code?.version, vector.input_base64).toBe(vector.version);
      expect(code?.modules.map((row) => row.map(Number).join("")).join("\n"), vector.input_base64).toBe(vector.modules);
      if (vector.svg) expect(qrCodeSvg(input), vector.input_base64).toBe(vector.svg);
    }
  });

  /** A request from someone signed in. */
  const session = async () => ({ headers: { Cookie: (await signIn("Ada")).cookie } });

  it("answers someone signed in with the link's SVG, cached in their browser for a year", async () => {
    const response = await api("/qr_code/aHR0cDovL2NhbXBmaXJlLnRlc3Q", await session());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31556952");
    const svg = await response.text();
    expect(svg.startsWith('<?xml version="1.0" standalone="yes"?><svg')).toBe(true);
    expect(svg).toBe(qrCodeSvg(utf8("http://campfire.test")));
  });

  it("sends someone signed out to sign in, as an avatar does", async () => {
    for (const headers of [{}, { Cookie: `__Host-session_token=${"A".repeat(43)}` }] as HeadersInit[]) {
      const response = await api("/qr_code/aHR0cDovL2NhbXBmaXJlLnRlc3Q", { headers, redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("https://ember.test/session/new");
      expect(await response.text()).toBe("");
    }
  });

  it("draws any text, not only this site's links", async () => {
    const response = await api(`/qr_code/${btoa("Not a link at all")}`, await session());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(qrCodeSvg(utf8("Not a link at all")));
  });

  it("answers HEAD with the headers alone, and ignores a format, as Rails routes do", async () => {
    const ada = await session();
    const head = await api("/qr_code/aHR0cDovL2NhbXBmaXJlLnRlc3Q", { ...ada, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(await head.text()).toBe("");
    const svg = await api("/qr_code/aHR0cDovL2NhbXBmaXJlLnRlc3Q.svg", ada);
    expect(await svg.text()).toBe(qrCodeSvg(utf8("http://campfire.test")));
  });

  it("reads ids as Ruby's Base64.urlsafe_decode64 does: either alphabet, padded or not", () => {
    expect(decoded("aHR0cDovL2NhbXBmaXJlLnRlc3Q")).toEqual(Array.from(utf8("http://campfire.test")));
    expect(decoded("aHR0cDovL2NhbXBmaXJlLnRlc3Q=")).toEqual(Array.from(utf8("http://campfire.test")));
    expect(decoded("-_8")).toEqual([0xfb, 0xff]);
    expect(decoded("+/8")).toEqual([0xfb, 0xff]);
    expect(decoded("a+b/")).toEqual(decoded("a-b_"));
    expect(decoded("QQ")).toEqual([0x41]);
    expect(decoded("QQ==")).toEqual([0x41]);
    expect(decoded("")).toEqual([]);
    // Where Ruby raises ArgumentError: too short, padded wrongly, bits left over, or not base64.
    for (const id of ["a", "QQ=", "ab=", "ab=c", "QR", "aB==", "a*bc", "QQ== "]) expect(decoded(id), id).toBeNull();
  });

  it("answers 400 for an id that isn't base64", async () => {
    const ada = await session();
    for (const id of ["a", "aB==", "a*bc", "QQ%3", "%E2%82"]) expect((await api(`/qr_code/${id}`, ada)).status, id).toBe(400);
    // Percent-encoding is undone first, as Rails does.
    expect((await api("/qr_code/aGk%3D", ada)).status).toBe(200);
  });

  it("answers 422 for text too long for the largest QR code", async () => {
    expect(qrCodeSvg(new Uint8Array(3_000).fill(0x61))).toBeNull();
    const response = await api(`/qr_code/${btoa("a".repeat(3_000))}`, await session());
    expect(response.status).toBe(422);
  });

  it("answers 404 to other methods and to paths that hold no id, signed in or not", async () => {
    const ada = await session();
    expect((await api("/qr_code/aHR0cDovL2NhbXBmaXJlLnRlc3Q", { ...ada, method: "POST" })).status).toBe(404);
    expect((await api("/qr_code/aHR0cDovL2NhbXBmaXJlLnRlc3Q", { method: "POST" })).status).toBe(404);
    for (const path of ["/qr_code/", "/qr_code/a/b", "/qr_code/.svg"]) expect((await api(path)).status, path).toBe(404);
  });
});
