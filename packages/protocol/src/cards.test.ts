import { describe, expect, it } from "vitest";
import { MAX_CARDS, parseCards, type CardAddress } from "./cards";
import { MAX_MESSAGE_HTML_LENGTH } from "./index";

/** Keeps https addresses on example.com, as the room's rule keeps addresses on named hosts. */
const address: CardAddress = (url) => (url.startsWith("https://example.com/") ? url : undefined);

const card = (parts: unknown[], rest: Record<string, unknown> = {}) => ({ source: "attachment", parts, ...rest });

describe("Bot cards", () => {
  it("keeps a card with every part an attachment shows", () => {
    const whole = card(
      [
        { kind: "author", name: "Alertmanager", href: "https://example.com/am", icon: "https://example.com/am.png" },
        { kind: "title", text: "[FIRING:1] HighErrorRate", href: "https://example.com/alerts" },
        { kind: "text", html: "<p>5xx responses are at <strong>7.2%</strong></p>" },
        { kind: "fields", fields: [{ title: "Severity", html: "<p>critical</p>", short: true }, { html: "<p>untitled</p>", short: false }] },
        { kind: "image", image: { url: "https://example.com/graph.png", alt: "Error rate" } },
        { kind: "buttons", buttons: [{ text: "Runbook", href: "https://example.com/runbook", style: "primary" }, { text: "Silence", href: "https://example.com/silence" }] },
        { kind: "footer", text: "Prometheus", icon: "https://example.com/p.png", at: 1792612211 },
      ],
      { color: "danger", pretext: "<p>Alert</p>", thumb: { url: "https://example.com/thumb.png", alt: "" } },
    );
    expect(parseCards([whole], address)).toEqual([whole]);
  });

  it("keeps Slack's colors and six hex digits in lowercase, leaving out any other color, and an address the rule doesn't keep", () => {
    expect(parseCards(["#36a64f", "#ABCDEF", "DANGER", "DaNgEr"].map((color) => card([{ kind: "title", text: "Hi" }], { color })), address)).toEqual(
      ["#36a64f", "#abcdef", "danger", "danger"].map((color) => card([{ kind: "title", text: "Hi" }], { color })),
    );
    for (const color of ["red", "#fff", "#36a64f; background: url(x)", "javascript:alert(1)", 7]) {
      expect(parseCards([card([{ kind: "title", text: "Hi" }], { color })], address)).toEqual([card([{ kind: "title", text: "Hi" }])]);
    }
    const parts = [
      { kind: "author", name: "Ada", href: "javascript:alert(1)", icon: "http://example.com/a.png" },
      { kind: "title", text: "Title", href: "https://elsewhere.test/" },
      { kind: "image", image: { url: "data:image/png;base64,AAAA", alt: "" } },
      { kind: "buttons", buttons: [{ text: "Go", href: "mailto:ada@example.com" }] },
      { kind: "footer", text: "Footer", icon: 7 },
    ];
    expect(parseCards([card(parts, { thumb: { url: "ftp://example.com/t.png" } })], address)).toEqual([
      card([
        { kind: "author", name: "Ada" },
        { kind: "title", text: "Title" },
        { kind: "footer", text: "Footer" },
      ]),
    ]);
  });

  it("leaves out parts of kinds it doesn't know, malformed ones and ones too long, and a card left with nothing", () => {
    const parts = [
      { kind: "video", text: "Not a part" },
      { kind: "title", text: "   " },
      { kind: "title", text: "x".repeat(3001) },
      { kind: "text", html: "x".repeat(MAX_MESSAGE_HTML_LENGTH + 1) },
      { kind: "text", html: 7 },
      { kind: "fields", fields: [{ short: true }, "field", { title: "Kept", short: "yes" }] },
      { kind: "footer", text: "", at: Number.NaN },
      { kind: "footer", at: 1e20 },
      "part",
      null,
    ];
    expect(parseCards([card(parts)], address)).toEqual([card([{ kind: "fields", fields: [{ title: "Kept", html: "", short: false }] }])]);
    expect(parseCards([card([{ kind: "title", text: "" }]), card([], { pretext: "<p>Only this</p>" }), { source: "embed", parts: [{ kind: "title", text: "Hi" }] }, "card"], address)).toEqual([
      card([], { pretext: "<p>Only this</p>" }),
    ]);
    expect(parseCards({ source: "attachment" }, address)).toEqual([]);
  });

  it("keeps a card of a message's blocks, framed without a bar, with every part blocks show", () => {
    const blocks = {
      source: "blocks",
      parts: [
        { kind: "header", text: "Deploy finished" },
        {
          kind: "section",
          html: "<p><strong>web</strong> is live</p>",
          fields: [{ html: "<p>production</p>", short: true }],
          thumb: { url: "https://example.com/logo.png", alt: "logo" },
          button: { text: "Open", href: "https://example.com/open", style: "primary" },
        },
        { kind: "divider" },
        { kind: "context", items: [{ image: { url: "https://example.com/ada.png", alt: "Ada" } }, { html: "<p>By Ada</p>" }] },
        { kind: "image", image: { url: "https://example.com/chart.png", alt: "Error rate" }, title: "Last hour" },
        {
          kind: "table",
          rows: [
            ["<p>Service</p>", "<p>Errors</p>"],
            ["<p>api</p>", ""],
          ],
          columns: [
            { align: "left", wrap: true },
            { align: "right", wrap: false },
          ],
        },
        {
          kind: "tiles",
          tiles: [
            {
              hero: { url: "https://example.com/hero.png", alt: "" },
              icon: { url: "https://example.com/icon.png", alt: "" },
              title: "Room 1",
              subtitle: "Second floor",
              body: "<p>Seats 8</p>",
              subtext: "<p>Free until 3</p>",
              buttons: [{ text: "Book", href: "https://example.com/book", style: "primary" }],
            },
            { title: "Room 2" },
          ],
        },
      ],
    };
    expect(parseCards([blocks], address)).toEqual([blocks]);
    // Only an attachment has a bar, a pretext and a thumbnail.
    expect(parseCards([{ ...blocks, color: "good", pretext: "<p>Above</p>", thumb: { url: "https://example.com/t.png", alt: "" } }], address)).toEqual([blocks]);
  });

  it("leaves out what a block's part can't keep, and a card that shows nothing but rules", () => {
    const parts = [
      { kind: "section", thumb: { url: "https://example.com/logo.png", alt: "" } },
      { kind: "section", html: "<p>Kept</p>", thumb: { url: "ftp://example.com/logo.png", alt: "" }, button: { text: "Mail", href: "mailto:ada@example.com" } },
      { kind: "context", items: [{ image: { url: "data:image/png;base64,AAAA", alt: "" } }, { html: "" }, "item"] },
      { kind: "context", items: [{ image: { url: "https://example.com/a.png" } }, { html: "<p>Kept</p>", image: 7 }] },
      { kind: "image", image: { url: "https://example.com/chart.png", alt: "" }, title: "x".repeat(3001) },
      { kind: "header", text: "   " },
      { kind: "table", rows: ["row", [], [7, "<p>Kept</p>", ...Array.from({ length: 20 }, () => "<p>More</p>")]], columns: [{ align: "justify", wrap: "yes" }, null] },
      { kind: "tiles", tiles: [{ icon: { url: "https://example.com/icon.png", alt: "" } }, { title: "Kept", buttons: Array.from({ length: 4 }, (_, index) => ({ text: `Go ${index}`, href: "https://example.com/go" })) }] },
    ];
    expect(parseCards([{ source: "blocks", parts }], address)).toEqual([
      {
        source: "blocks",
        parts: [
          { kind: "section", html: "<p>Kept</p>" },
          { kind: "context", items: [{ image: { url: "https://example.com/a.png", alt: "" } }] },
          { kind: "image", image: { url: "https://example.com/chart.png", alt: "" } },
          {
            kind: "table",
            rows: [["", "<p>Kept</p>", ...Array.from({ length: 18 }, () => "<p>More</p>")]],
            columns: [
              { align: "left", wrap: false },
              { align: "left", wrap: false },
            ],
          },
          { kind: "tiles", tiles: [{ title: "Kept", buttons: [0, 1, 2].map((index) => ({ text: `Go ${index}`, href: "https://example.com/go" })) }] },
        ],
      },
    ]);
    expect(parseCards([{ source: "blocks", parts: [{ kind: "divider" }, { kind: "divider" }] }, card([{ kind: "divider" }]), card([{ kind: "divider" }], { pretext: "<p>Above</p>" })], address)).toEqual([
      card([{ kind: "divider" }], { pretext: "<p>Above</p>" }),
    ]);
  });

  it("keeps up to a message's cards", () => {
    const cards = Array.from({ length: MAX_CARDS + 1 }, (_, index) => card([{ kind: "title", text: `Card ${index}` }]));
    expect(parseCards(cards, address)).toEqual(cards.slice(0, MAX_CARDS));
  });
});
