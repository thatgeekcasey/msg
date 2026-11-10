import { describe, expect, it } from "vitest";
import { FormError, formBoundaryOf, FormReader, isFormType, type FormPart } from "../src/files/form-parts";

// Reading a bot's form a part at a time, as it arrives, as Rack's multipart parser reads the form
// `curl -F` sends (rack/lib/rack/multipart/parser.rb).

const BOUNDARY = "------------------------d74496d66958873e";

/** A form's body as `curl -F` writes one, its parts each a field's headers and bytes. */
function formOf(parts: Array<{ headers: string[]; body: string | Uint8Array }>, { boundary = BOUNDARY, preamble = "", epilogue = "" } = {}): Uint8Array {
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [encoder.encode(preamble)];
  for (const { headers, body } of parts) {
    pieces.push(encoder.encode(`--${boundary}\r\n${headers.map((header) => `${header}\r\n`).join("")}\r\n`));
    pieces.push(typeof body === "string" ? encoder.encode(body) : body);
    pieces.push(encoder.encode("\r\n"));
  }
  pieces.push(encoder.encode(`--${boundary}--\r\n${epilogue}`));
  return concatenated(pieces);
}

const concatenated = (pieces: Uint8Array[]) => {
  const joined = new Uint8Array(pieces.reduce((length, piece) => length + piece.length, 0));
  pieces.reduce((at, piece) => (joined.set(piece, at), at + piece.length), 0);
  return joined;
};

/** `bytes` as a body that arrives `size` bytes at a time. */
const arriving = (bytes: Uint8Array, size = bytes.length) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });

/** Every part of the form `body` brings, with its bytes as text. */
async function partsOf(body: ReadableStream<Uint8Array> | null, boundary = BOUNDARY): Promise<Array<FormPart & { text: string }>> {
  const form = new FormReader(body, boundary);
  const parts: Array<FormPart & { text: string }> = [];
  for (let part = await form.next(); part; part = await form.next()) {
    const chunks: Uint8Array[] = [];
    for (let chunk = await form.read(); chunk; chunk = await form.read()) chunks.push(chunk);
    parts.push({ ...part, text: new TextDecoder().decode(concatenated(chunks)) });
  }
  return parts;
}

const fileHeaders = (filename: string, type = "text/plain") => [`Content-Disposition: form-data; name="attachment"; filename="${filename}"`, `Content-Type: ${type}`];

describe("Bots post messages", () => {
  it("reads a form as a browser sends it, whatever size of pieces it arrives in", async () => {
    const form = new FormData();
    form.set("note", "Hello\r\nthere");
    form.set("attachment", new File(["line one\r\n--not a boundary\r\nline three"], "report.txt", { type: "text/plain" }));
    const request = new Request("https://ember.test/", { method: "POST", body: form });
    const boundary = formBoundaryOf(request.headers.get("Content-Type"))!;
    const bytes = new Uint8Array(await request.arrayBuffer());

    for (const size of [1, 2, 3, 7, 64, 1000, bytes.length]) {
      expect(await partsOf(arriving(bytes, size), boundary), `${size} at a time`).toEqual([
        { name: "note", filename: null, contentType: null, text: "Hello\r\nthere" },
        { name: "attachment", filename: "report.txt", contentType: "text/plain", text: "line one\r\n--not a boundary\r\nline three" },
      ]);
    }
  });

  it("keeps a file's bytes as they came, the start of a delimiter among them, and an empty file empty", async () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i % 3 === 0 ? 13 : i % 3 === 1 ? 10 : 45));
    const body = formOf([
      { headers: fileHeaders("bytes.bin", "application/octet-stream"), body: bytes },
      { headers: fileHeaders("empty.txt"), body: "" },
    ]);
    for (const size of [1, 5, 4096]) {
      const form = new FormReader(arriving(body, size), BOUNDARY);
      expect(await form.next()).toEqual({ name: "attachment", filename: "bytes.bin", contentType: "application/octet-stream" });
      const chunks: Uint8Array[] = [];
      for (let chunk = await form.read(); chunk; chunk = await form.read()) chunks.push(chunk);
      expect(concatenated(chunks)).toEqual(bytes);
      expect(await form.next()).toEqual({ name: "attachment", filename: "empty.txt", contentType: "text/plain" });
      expect(await form.read()).toBeNull();
      expect(await form.next()).toBeNull();
    }
  });

  it("keeps bytes that only look like a delimiter, the boundary with more after it than padding and a line break, as Rack does", async () => {
    const text = `line one\r\n--${BOUNDARY}XYZ\r\nline three\r\n--${BOUNDARY} \tand more\r\n--${BOUNDARY}-\r\nline seven`;
    const body = formOf([
      { headers: fileHeaders("report.txt"), body: text },
      { headers: ['Content-Disposition: form-data; name="note"'], body: "after" },
    ]);
    for (const size of [1, 2, 3, 7, 64, body.length]) {
      expect(await partsOf(arriving(body, size)), `${size} at a time`).toEqual([
        { name: "attachment", filename: "report.txt", contentType: "text/plain", text },
        { name: "note", filename: null, contentType: null, text: "after" },
      ]);
    }
  });

  it("skips what's before the first part and after the last, padding after a delimiter, and what's left of a part not read", async () => {
    const body = formOf(
      [
        { headers: ['Content-Disposition: form-data; name="skipped"'], body: "x".repeat(10_000) },
        { headers: ['Content-Disposition: form-data; name="kept"'], body: "y" },
      ],
      { preamble: "This is a preamble.\r\n", epilogue: "This is an epilogue." },
    );
    const padded = new TextDecoder().decode(body).replace(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="kept"`, `--${BOUNDARY} \t \r\nContent-Disposition: form-data; name="kept"`);
    const form = new FormReader(arriving(new TextEncoder().encode(padded), 100), BOUNDARY);
    expect(await form.next()).toMatchObject({ name: "skipped" });
    expect(await form.next()).toMatchObject({ name: "kept" });
    expect(await form.read()).toEqual(new TextEncoder().encode("y"));
    expect(await form.next()).toBeNull();
    expect(await form.next()).toBeNull();
  });

  it("reads a file's name as Rack does: escaped as browsers and curl escape it, encoded as RFC 5987 has it, or a Windows path", async () => {
    const named = async (disposition: string) => (await partsOf(arriving(formOf([{ headers: [`Content-Disposition: form-data; name="attachment"; ${disposition}`], body: "" }]))))[0]!.filename;
    expect(await named('filename="a %22quoted%22 name.txt"')).toBe('a "quoted" name.txt');
    expect(await named('filename="a \\"quoted\\" name.txt"')).toBe('a "quoted" name.txt');
    expect(await named("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe("résumé.pdf");
    expect(await named('filename="report.txt"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf')).toBe("résumé.pdf");
    expect(await named('filename="C:\\Users\\ada\\notes.txt"')).toBe("C:\\Users\\ada\\notes.txt");
    expect(await named('filename="100% done.txt"')).toBe("100% done.txt");
    expect(await named("filename=bare.txt")).toBe("bare.txt");
    expect(await named('filename=""')).toBe("");
  });

  it("reads a part's name and type, and none without headers", async () => {
    const body = formOf([
      { headers: ['content-disposition: form-data; name="attachment"; filename="moon.jpg"', "content-type: image/jpeg"], body: "" },
      { headers: [], body: "anonymous" },
    ]);
    expect(await partsOf(arriving(body))).toEqual([
      { name: "attachment", filename: "moon.jpg", contentType: "image/jpeg", text: "" },
      { name: "", filename: null, contentType: null, text: "anonymous" },
    ]);
  });

  it("refuses a form that ends early, has no parts, or whose headers or delimiters run on, as Rack does", async () => {
    const whole = new TextDecoder().decode(formOf([{ headers: fileHeaders("report.txt"), body: "Report" }]));
    const refused = (text: string) => partsOf(arriving(new TextEncoder().encode(text), 16));
    await expect(refused("")).rejects.toThrow(new FormError("The form has no parts"));
    await expect(partsOf(null)).rejects.toThrow(new FormError("The form has no parts"));
    await expect(refused("just text")).rejects.toThrow(new FormError("The form has no parts"));
    await expect(refused(whole.slice(0, whole.indexOf("Report") + 3))).rejects.toThrow(new FormError("The form ends before its last part does"));
    await expect(refused(whole.slice(0, whole.indexOf("Content-Type")))).rejects.toThrow(new FormError("The form ends in a part's headers"));
    await expect(refused(`--${BOUNDARY}`)).rejects.toThrow(new FormError("The form ends after a delimiter"));
    await expect(refused(`--${BOUNDARY}${" ".repeat(2000)}\r\n\r\n`)).rejects.toThrow(new FormError("A delimiter has no line break after it"));
    const longHeaders = `--${BOUNDARY}\r\nX-Long: ${"x".repeat(20_000)}\r\n\r\n`;
    await expect(refused(longHeaders)).rejects.toThrow(new FormError("A part's headers are too long"));
    await expect(partsOf(arriving(new TextEncoder().encode(longHeaders)))).rejects.toThrow(new FormError("A part's headers are too long"));
  });

  it("finds a form's boundary in its type, as Rack does, and none for anything else", () => {
    expect(formBoundaryOf(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    expect(formBoundaryOf('Multipart/Form-Data; charset=utf-8; boundary="with spaces and :"')).toBe("with spaces and :");
    expect(formBoundaryOf("multipart/form-data;boundary=x")).toBe("x");
    expect(formBoundaryOf("multipart/form-data")).toBeNull();
    expect(formBoundaryOf(`multipart/form-data; boundary=${"x".repeat(71)}`)).toBeNull();
    expect(formBoundaryOf("multipart/mixed; boundary=x")).toBeNull();
    expect(formBoundaryOf("application/x-www-form-urlencoded")).toBeNull();
    expect(formBoundaryOf(null)).toBeNull();
  });

  it("tells a form's type from any other, whether it names a boundary or not", () => {
    expect(["multipart/form-data", " Multipart/Form-Data ; boundary=x", `multipart/form-data; boundary=${"x".repeat(71)}`].map(isFormType)).toEqual([true, true, true]);
    expect(["multipart/form-datas", "multipart/mixed; boundary=x", "text/plain", null].map(isFormType)).toEqual([false, false, false, false]);
  });
});
