import { ROOM_ICON_NAMES } from "@ember/protocol";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import picker from "./picker/catalog.json";
import { RoomIcon, roomIconUrl } from "./room-icon";
import { iconLabel, roomIconLabel } from "./room-icon-label";

describe("Room icons", () => {
  it("draws `#` for a room without an icon, in the size of the text around it", () => {
    const { container } = render(<RoomIcon icon={null} size={19} className="text-[22px]" />);
    expect(container.innerHTML).toBe('<span aria-hidden="true" class="text-[22px]">#</span>');
  });

  it("draws an icon in the color of the text around it, from the icon's own address, at the size given", () => {
    const { container } = render(<RoomIcon icon="coffee" size={19} className="text-muted-foreground" />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).toHaveAttribute("aria-hidden", "true");
    expect(outer).toHaveClass("inline-flex", "text-muted-foreground");
    const icon = outer.querySelector<HTMLElement>('[data-icon="coffee"]')!;
    expect(icon).toHaveClass("bg-current");
    expect(icon.style.width).toBe("19px");
    expect(icon.style.height).toBe("19px");
    expect(icon.style.maskImage).toBe('url("/lucide/icons/coffee.svg")');
    expect(outer).toHaveTextContent("");
  });

  it("serves each icon at an address of its own, Iconoir's by variant", () => {
    expect(roomIconUrl("gamepad-2")).toBe("/lucide/icons/gamepad-2.svg");
    expect(roomIconUrl("iconoir:regular:coffee-cup")).toBe("/iconoir/icons/regular/coffee-cup.svg");
    expect(roomIconUrl("iconoir:solid:heart")).toBe("/iconoir/icons/solid/heart.svg");
  });

  it("names every icon as the catalog does for a room, crediting Iconoir, and the default Default hashtag", () => {
    expect(picker.icons.map((icon) => icon.name)).toEqual(ROOM_ICON_NAMES);
    const named = (icon: (typeof picker.icons)[number]) => `${("roomLabel" in icon && icon.roomLabel) || icon.label}${icon.collection === "Iconoir" ? " · Iconoir" : ""}`;
    expect(picker.icons.filter((icon) => roomIconLabel(icon.name as (typeof ROOM_ICON_NAMES)[number]) !== named(icon))).toEqual([]);
    expect(roomIconLabel("air-vent")).toBe("Air Vent");
    expect(roomIconLabel("gamepad-2")).toBe("Video Games");
    expect(roomIconLabel("code-xml")).toBe("Engineering");
    expect(roomIconLabel("iconoir:regular:building")).toBe("Company Info · Iconoir");
    expect(roomIconLabel("iconoir:solid:heart")).toBe("Heart (Solid) · Iconoir");
    expect(roomIconLabel(null)).toBe("Default hashtag");
  });

  it("calls a navigation icon by its own name rather than a room's purpose", () => {
    expect(iconLabel("code-xml", "navigation")).toBe("Code Xml");
    expect(iconLabel("iconoir:regular:home", "navigation")).toBe("Home · Iconoir");
  });
});
