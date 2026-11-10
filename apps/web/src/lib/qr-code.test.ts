import { describe, expect, it } from "vitest";
import { qrCodePath } from "./qr-code";

describe("QR codes for links", () => {
  it("names the URL as padded URL-safe base64", () => {
    // Padded, with "-" and "_" for "+" and "/".
    expect(qrCodePath("http://x/?a")).toBe("/qr_code/aHR0cDovL3gvP2E=");
    expect(qrCodePath("http://x/?>?")).toBe("/qr_code/aHR0cDovL3gvPz4_");
    expect(qrCodePath("https://chat.example/join/aB3d-Ef5h-iJ7k")).toBe("/qr_code/aHR0cHM6Ly9jaGF0LmV4YW1wbGUvam9pbi9hQjNkLUVmNWgtaUo3aw==");
  });

  it("encodes the URL's UTF-8", () => {
    expect(qrCodePath("http://x/é")).toBe(`/qr_code/${btoa("http://x/\xc3\xa9")}`);
  });
});
