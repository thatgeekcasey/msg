import { describe, expect, it } from "vitest";
import { byName } from "./people";

const person = (id: string, name: string) => ({ id, name });

describe("People list", () => {
  it("orders names as SQLite's LOWER does, folding only ASCII letters, then by id", () => {
    expect(byName([person("u2", "alpha"), person("u3", "Éclair"), person("u1", "ALPHA")]).map((p) => p.id)).toEqual(["u1", "u2", "u3"]);
    // LOWER leaves "É" as it is, which sorts after every ASCII letter.
    expect(byName([person("u2", "alpha"), person("u3", "Éclair"), person("u4", "zed")]).map((p) => p.name)).toEqual(["alpha", "zed", "Éclair"]);
  });

  it("orders names by code point, as SQLite orders UTF-8, which puts an emoji after full-width letters", () => {
    expect(byName([person("u1", "😀 Ada"), person("u2", "Zed"), person("u3", "Ａ Ada")]).map((p) => p.name)).toEqual(["Zed", "Ａ Ada", "😀 Ada"]);
  });
});
