import { describe, expect, it } from "vitest";
import { inItNow, inTheHuddle } from "./huddle-people";

describe("inItNow", () => {
  it("names up to three people by first name", () => {
    expect(inItNow(["Sam Rivera"], 1)).toBe("Sam is in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel"], 2)).toBe("Sam and Priya are in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel", "Leo Park"], 3)).toBe("Sam, Priya, and Leo are in it now.");
  });

  it("counts whoever's past the third", () => {
    expect(inItNow(["Sam Rivera", "Priya Patel", "Leo Park", "Maya Chen"], 4)).toBe("Sam, Priya, Leo, and 1 other are in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel", "Leo Park", "Maya Chen", "Ada Lovelace"], 5)).toBe("Sam, Priya, Leo, and 2 others are in it now.");
  });

  it("counts people it has no name for among the others", () => {
    expect(inItNow(["Sam Rivera"], 3)).toBe("Sam and 2 others are in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel"], 3)).toBe("Sam, Priya, and 1 other are in it now.");
  });

  it("counts people when it has no name at all", () => {
    expect(inItNow([], 1)).toBe("1 person is in it now.");
    expect(inItNow([], 4)).toBe("4 people are in it now.");
  });

  it("takes a name of one word, or with spaces around it, whole", () => {
    expect(inItNow(["Cher"], 1)).toBe("Cher is in it now.");
    expect(inItNow(["  Sam   Rivera "], 1)).toBe("Sam is in it now.");
  });
});

describe("inTheHuddle", () => {
  it("says when nobody else is in it", () => {
    expect(inTheHuddle([])).toBe("Just you in the huddle");
  });

  it("names up to three others, then you", () => {
    expect(inTheHuddle(["Sam Rivera"])).toBe("Sam and you are in the huddle");
    expect(inTheHuddle(["Sam Rivera", "Priya Patel"])).toBe("Sam, Priya, and you are in the huddle");
    expect(inTheHuddle(["Sam Rivera", "Priya Patel", "Leo Park"])).toBe("Sam, Priya, Leo, and you are in the huddle");
  });

  it("counts the others past the third", () => {
    expect(inTheHuddle(["Sam Rivera", "Priya Patel", "Leo Park", "Ada Lovelace"])).toBe("Sam, Priya, Leo, and 1 other are in the huddle");
    expect(inTheHuddle(Array.from({ length: 49 }, (_, index) => `Person ${index}`))).toBe("Person, Person, Person, and 46 others are in the huddle");
  });
});
