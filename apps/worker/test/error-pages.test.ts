import { afterEach, describe, expect, it, vi } from "vitest";
import notFoundPage from "../../web/public/404.html";
import failedPage from "../../web/public/500.html";
import type { Env } from "../src/env";
import { api, apiWith, builtPages, origin } from "./support";

type Init = RequestInit<IncomingRequestCfProperties>;

/** `path`, from a Worker whose built app answers each path with its own name. */
const page = (path: string, init: Init = {}, changes: Partial<Env> = {}) => apiWith({ ASSETS: builtPages, ...changes }, path, { redirect: "manual", ...init });

/** A Workspace that can't be reached, so whatever asks it fails. */
const unreachable = {
  getByName: () => {
    throw new Error("The Workspace is out of reach");
  },
} as unknown as Env["WORKSPACE"];

const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

async function expectPage(response: Response, status: number, html: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(await response.text()).toBe(html);
}

afterEach(() => vi.restoreAllMocks());

describe("Error pages", () => {
  it("serves the app's page at every address the app shows one", async () => {
    const paths = ["/", "/rooms", "/rooms/general", "/rooms/general/@m-1", "/rooms/general/messages/m-1", "/rooms/opens/general", "/rooms/opens/new", "/rooms/closeds/general/edit", "/account/edit", "/session/new"];
    for (const path of [...paths, "/users/me/profile"]) {
      const response = await page(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe("page /");
    }
  });

  it("has the browser fetch what the app asks for first along with its page, its sidebar only with a session", async () => {
    const preload = (path: string) => `<${path}>; rel=preload; as=fetch; crossorigin`;
    const signedIn = { headers: { Cookie: `__Host-session_token=${"A".repeat(43)}` } };
    for (const path of ["/", "/rooms/general", "/account/edit", "/users/me/profile"]) {
      const response = await page(path, signedIn);
      expect(response.headers.get("Link"), path).toBe([preload("/api/bootstrap"), preload("/api/sidebar"), preload("/api/users")].join(", "));
      expect(response.headers.get("Vary"), path).toContain("Cookie");
    }
    // Signed out, the app goes to sign in, which has no sidebar, as setup's and the join link's pages don't.
    expect((await page("/rooms/general")).headers.get("Link")).toBe(preload("/api/bootstrap"));
    expect((await page("/session/new", signedIn)).headers.get("Link")).toBe(preload("/api/bootstrap"));
    expect((await page("/rooms/general", { headers: { Cookie: "__Host-session_token=forged" } })).headers.get("Link")).toBe(preload("/api/bootstrap"));
  });

  it("leaves any other path to the built app, which answers Campfire's 404 page for a file it doesn't have", async () => {
    for (const path of ["/nope", "/rooms/new", "/rooms/general/edit", "/rooms/general/extra", "/rooms/general/messages", "/rooms/%FF", "/404.html"]) {
      expect(await (await page(path)).text(), path).toBe(`page ${path}`);
    }
  });

  it("answers a write to a page with Campfire's 404 page", async () => {
    for (const method of WRITES) {
      for (const path of ["/", "/rooms/general", "/nope", "/up", "/webmanifest.json", "/qr_code/aGk"]) {
        await expectPage(await page(path, { method }), 404, notFoundPage);
      }
    }
  });

  it("answers Campfire's 404 page under setup's address, and for a QR code's address with no code", async () => {
    for (const path of ["/first_run/new", "/first_run/edit", "/first_run/access", "/qr_code/", "/qr_code/a/b"]) {
      await expectPage(await page(path), 404, notFoundPage);
    }
    const head = await page("/first_run/new", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  it("sends a page's address with extra slashes to its own", async () => {
    for (const [path, address] of [
      ["/rooms/general/", "/rooms/general"],
      ["//rooms//general?x=1", "/rooms/general?x=1"],
      ["/session/new/", "/session/new"],
      ["//", "/"],
    ]) {
      // Whole URLs, since a path starting // would name another host.
      const response = await page(`${origin}${path}`);
      expect(response.status, path).toBe(307);
      expect(response.headers.get("Location"), path).toBe(`${origin}${address}`);
    }
    expect(await (await page("/nope/")).text()).toBe("page /nope/");
  });

  it("answers an exception with Campfire's 500 page, and the API with JSON", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expectPage(await page("/join/AAAA-BBBB-CCCC", {}, { WORKSPACE: unreachable }), 500, failedPage);
    const head = await page("/join/AAAA-BBBB-CCCC", { method: "HEAD" }, { WORKSPACE: unreachable });
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");

    const answer = await apiWith({ WORKSPACE: unreachable }, "/api/bootstrap");
    expect(answer.status).toBe(500);
    expect(answer.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await answer.json()).toEqual({ error: "Something went wrong" });
    expect(logged).toHaveBeenCalledWith("GET /api/bootstrap failed:", expect.objectContaining({ message: "The Workspace is out of reach" }));
  });

  it("logs no more than that setup failed, whose form holds the administrator's password", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const posted = await page("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada", emailAddress: "ada@example.com", password: "12345678" }) }, { WORKSPACE: unreachable });
    expect(posted.status).toBe(500);
    expect(logged.mock.calls).toEqual([["POST /api/first_run failed:", "500 Internal Server Error"]]);
  });

  it("answers unknown API paths with JSON, not the page", async () => {
    const response = await api("/api/nope", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
