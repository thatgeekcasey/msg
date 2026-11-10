import { describe, expect, it, vi } from "vitest";
import { SessionCache } from "../src/session-cache";

/** A lookup that finds `session`, counting its calls. */
const finding = (session: string | null) => vi.fn(async () => session);

describe("Stay signed in, per device", () => {
  it("keeps the sessions it finds, so the Workspace looks each up once", async () => {
    const cache = new SessionCache<string>(10);
    const lookUp = finding("Ada's");
    expect(await cache.get("a", lookUp)).toBe("Ada's");
    expect(await cache.get("a", lookUp)).toBe("Ada's");
    expect(lookUp).toHaveBeenCalledTimes(1);
  });

  it("keeps a session it starts, so the next request doesn't look it up", async () => {
    const cache = new SessionCache<string>(10);
    expect(await cache.keep("a", async () => "Ada's")).toBe("Ada's");
    const lookUp = finding(null);
    expect(await cache.get("a", lookUp)).toBe("Ada's");
    expect(lookUp).not.toHaveBeenCalled();
  });

  it("looks again for a session it didn't find", async () => {
    const cache = new SessionCache<string>(10);
    const lookUp = finding(null);
    expect(await cache.get("a", lookUp)).toBeNull();
    expect(await cache.get("a", lookUp)).toBeNull();
    expect(lookUp).toHaveBeenCalledTimes(2);
  });

  it("forgets the least recently used session past its limit", async () => {
    const cache = new SessionCache<string>(2);
    await cache.get("a", finding("Ada's"));
    cache.remember("b", "Grace's");
    await cache.get("a", finding(null));
    cache.remember("c", "Linus's");

    expect(await cache.get("a", finding(null))).toBe("Ada's");
    expect(await cache.get("c", finding(null))).toBe("Linus's");
    expect(await cache.get("b", finding(null))).toBeNull();
  });

  it("forgets a session once it ends, even if ending it failed, and answers what ending it did", async () => {
    const cache = new SessionCache<string>(10);
    cache.remember("a", "Ada's");
    cache.remember("b", "Grace's");
    expect(await cache.end("a", async () => "queued")).toBe("queued");
    await expect(cache.end("b", () => Promise.reject(new Error("Storage isn't answering")))).rejects.toThrow();

    expect(await cache.get("a", finding(null))).toBeNull();
    expect(await cache.get("b", finding(null))).toBeNull();
  });

  it("doesn't answer a session from memory once it starts ending, since it may be gone before ending it is done", async () => {
    const cache = new SessionCache<string>(10);
    cache.remember("a", "Ada's");
    let ended!: () => void;
    const ending = cache.end("a", () => new Promise<void>((resolve) => (ended = resolve)));

    const lookUp = finding(null);
    expect(await cache.get("a", lookUp)).toBeNull();
    expect(lookUp).toHaveBeenCalledOnce();
    ended();
    await ending;
  });

  it("doesn't keep a session found while it was ending, even if the lookup finished first", async () => {
    const cache = new SessionCache<string>(10);
    let ended!: () => void;
    const ending = cache.end("a", () => new Promise<void>((resolve) => (ended = resolve)));
    expect(await cache.get("a", finding("Ada's"))).toBe("Ada's");
    ended();
    await ending;

    const lookUp = finding(null);
    expect(await cache.get("a", lookUp)).toBeNull();
    expect(lookUp).toHaveBeenCalledOnce();
  });

  it("doesn't keep a session found while one was ending, since it may have been read before it went", async () => {
    const cache = new SessionCache<string>(10);
    let found!: (session: string) => void;
    const lookingUp = cache.get("a", () => new Promise<string | null>((resolve) => (found = resolve)));
    await cache.end("a", async () => {});
    found("Ada's");
    expect(await lookingUp).toBe("Ada's");

    const lookUp = finding(null);
    expect(await cache.get("a", lookUp)).toBeNull();
    expect(lookUp).toHaveBeenCalledOnce();
  });
});

describe("Make or revoke administrators", () => {
  it("forgets the sessions a change picks, and only those, so they're read again as they are now", async () => {
    const cache = new SessionCache<string>(10);
    cache.remember("a", "Ada's laptop");
    cache.remember("b", "Ada's phone");
    cache.remember("c", "Grace's laptop");
    expect(await cache.change((session) => session.startsWith("Ada's"), async () => "changed")).toBe("changed");

    expect(await cache.get("a", finding("Ada's laptop, changed"))).toBe("Ada's laptop, changed");
    expect(await cache.get("b", finding(null))).toBeNull();
    const lookUp = finding(null);
    expect(await cache.get("c", lookUp)).toBe("Grace's laptop");
    expect(lookUp).not.toHaveBeenCalled();
  });

  it("forgets them even if the change failed, since it may have been made", async () => {
    const cache = new SessionCache<string>(10);
    cache.remember("a", "Ada's");
    await expect(cache.change(() => true, () => Promise.reject(new Error("Storage isn't answering")))).rejects.toThrow();
    expect(await cache.get("a", finding(null))).toBeNull();
  });

  it("doesn't keep a session found while a change was under way, since it may have been read before it", async () => {
    const cache = new SessionCache<string>(10);
    let found!: (session: string) => void;
    const lookingUp = cache.get("a", () => new Promise<string | null>((resolve) => (found = resolve)));
    let changed!: () => void;
    const changing = cache.change(() => true, () => new Promise<void>((resolve) => (changed = resolve)));
    found("Ada's, read before the change");
    expect(await lookingUp).toBe("Ada's, read before the change");
    changed();
    await changing;

    const lookUp = finding("Ada's, read again");
    expect(await cache.get("a", lookUp)).toBe("Ada's, read again");
    expect(lookUp).toHaveBeenCalledOnce();
  });

  it("doesn't keep a session started while a change was under way, since it may have read what changed", async () => {
    const cache = new SessionCache<string>(10);
    let started!: (session: string) => void;
    const starting = cache.keep("a", () => new Promise<string | null>((resolve) => (started = resolve)));
    await cache.change(() => true, async () => {});
    started("Ada's, as a member");
    expect(await starting).toBe("Ada's, as a member");

    const lookUp = finding("Ada's, as an administrator");
    expect(await cache.get("a", lookUp)).toBe("Ada's, as an administrator");
    expect(lookUp).toHaveBeenCalledOnce();
  });
});
