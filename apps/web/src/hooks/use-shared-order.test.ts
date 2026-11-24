import { describe, expect, it } from "vitest";
import { headingOf, sectionOfHeading, withRoomMoved, withSectionMoved } from "./use-shared-order";

describe("Sidebar sections in Rooms and permissions", () => {
  const [one, two, three] = ["s1", "s2", "s3"].map(headingOf);
  // A room in none, then sections one, with two rooms, two, with none, and three, with one.
  const rows = ["a", one!, "b", "c", two!, three!, "d"];

  it("moves a section's heading among the others with its rooms, wherever a drag leaves it among them", () => {
    expect(withSectionMoved(rows, ["a", "b", "c", two!, one!, three!, "d"], one!)).toEqual(["a", two, one, "b", "c", three, "d"]);
    // Dropped among its own rooms, it stays.
    expect(withSectionMoved(rows, ["a", "b", one!, "c", two!, three!, "d"], one!)).toEqual(rows);
    expect(withSectionMoved(rows, ["a", "b", "c", two!, three!, "d", one!], one!)).toEqual(["a", two, three, "d", one, "b", "c"]);
    // Never above the rooms in none.
    expect(withSectionMoved(rows, [three!, "a", one!, "b", "c", two!, "d"], three!)).toEqual(["a", three, "d", one, "b", "c", two]);
  });

  it("leaves the rows as they are once the dragged section is deleted, and a section made since the drag began where it is", () => {
    expect(withSectionMoved(["a", "b", "c", three!, "d"], ["a", "b", "c", two!, one!, three!, "d"], one!)).toEqual(["a", "b", "c", three, "d"]);
    const four = headingOf("s4");
    expect(withSectionMoved([...rows, four, "e"], ["a", "b", "c", two!, one!, three!, "d"], one!)).toEqual(["a", two, one, "b", "c", three, "d", four, "e"]);
  });

  it("drops a room in the section the drag put it in, keeping every other room where it is now", () => {
    // Dragged under two from the top, as c is put in three meanwhile.
    expect(withRoomMoved(["a", one!, "b", two!, three!, "c", "d"], [one!, "b", "c", two!, "a", three!, "d"], "a")).toEqual([one, "b", two, "a", three, "c", "d"]);
    // After b, which stays in one, though c, which was after b, has gone.
    expect(withRoomMoved(["a", one!, "b", two!, three!, "c", "d"], [one!, "b", "a", "c", two!, three!, "d"], "a")).toEqual([one, "b", "a", two, three, "c", "d"]);
    // To the top, and into a section deleted meanwhile, which leaves it in none, after the rooms there.
    expect(withRoomMoved(rows, ["d", "a", one!, "b", "c", two!, three!], "d")).toEqual(["d", "a", one, "b", "c", two, three]);
    expect(withRoomMoved(["a", "b", "c", two!, three!, "d"], ["a", one!, "b", "c", "d", two!, three!], "d")).toEqual(["a", "b", "c", "d", two, three]);
  });

  it("tells a heading's row from a room's", () => {
    expect(sectionOfHeading(headingOf("s1"))).toBe("s1");
    expect(sectionOfHeading("r1")).toBeNull();
  });
});
