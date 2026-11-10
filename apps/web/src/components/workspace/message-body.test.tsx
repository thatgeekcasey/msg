import { avatarSvg, type DirectoryUser, type User } from "@ember/protocol";
import { displayBody, OPENGRAPH_EMBED_CONTENT_TYPE, previewContent } from "@ember/richtext/dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { marksFor } from "@/lib/search";
import { MessageBody } from "./message-body";
import { SearchMarks } from "./search-marks";

afterEach(() => history.replaceState(null, "", "/"));

/** What a stored body shows on this page, its plain text `plainText`. */
const shown = (html: string, plainText = "") => displayBody(html, plainText, location.hostname);

/** Shows a stored body as a message shows it, returning its content. */
function show(html: string, trailing?: ReactNode, plainText?: string) {
  const { container } = render(<MessageBody nodes={shown(html, plainText)} mentions={[]} trailing={trailing} />);
  return container.querySelector<HTMLElement>(".message-content")!;
}

/** Waits for highlight.js to load and highlight the code block shown last. */
async function highlighted(content: Element) {
  await vi.waitFor(() => expect(content.querySelector("pre:last-of-type [class^=hljs-]")).not.toBeNull());
}

describe("Rich text, safely", () => {
  it("shows the formatting a message keeps", () => {
    const body = [
      "<p><strong>Bold</strong> <em>italic</em> <s>struck</s> <u>underlined</u> <mark>marked</mark> <code>code</code></p>",
      "<h1>Title</h1><h2>Section</h2>",
      "<blockquote><p>Quoted</p><cite>Ada</cite></blockquote>",
      "<ol><li>First</li><li>Second</li></ol>",
      "<hr>",
      '<p><time datetime="2026-10-14">Today</time> <abbr title="HyperText Markup Language">HTML</abbr></p>',
      "<table><tbody><tr><th>Name</th></tr><tr><td>Ada</td></tr></tbody></table>",
    ].join("");
    expect(show(body).innerHTML).toBe(body);
  });

  it("leaves out the whitespace between a table's rows and cells, which no browser shows", () => {
    expect(show("<table>\n  <tbody>\n    <tr>\n      <td>Ada</td>\n    </tr>\n  </tbody>\n</table>").innerHTML).toBe(
      "<table><tbody><tr><td>Ada</td></tr></tbody></table>",
    );
  });

  it("shows no marker for a list item that only holds a list, as Lexxy nests lists", () => {
    const content = show("<ul><li>One</li><li><ul><li>Nested</li></ul></li></ul>");
    const [one, holder, nested] = content.querySelectorAll("li");
    expect(one).not.toHaveAttribute("data-list");
    expect(holder).toHaveAttribute("data-list", "true");
    expect(nested).not.toHaveAttribute("data-list");
  });

  it("builds the message itself rather than setting markup on the page", () => {
    const nodes = shown('<p>Hi <img src="x" onerror="alert(1)"> <a href="https://example.com">there</a></p><pre>puts 1</pre>');
    const setInnerHtml = vi.spyOn(Element.prototype, "innerHTML", "set");
    render(<MessageBody nodes={nodes} mentions={[]} />);
    expect(setInnerHtml.mock.contexts.filter((element) => (element as Element).ownerDocument === document)).toEqual([]);
    expect(document.querySelector("img")).toBeNull();
  });

  it("highlights a code block in the language it names", async () => {
    const content = show('<pre data-language="ruby">def greet = puts "Hi"</pre>');
    await highlighted(content);
    expect(content.querySelector(".hljs-keyword")).toHaveTextContent("def");
    expect(content.querySelector(".hljs-string")).toHaveTextContent('"Hi"');
    expect(content.querySelector("pre")).toHaveTextContent('def greet = puts "Hi"');
  });

  it("highlights a code block in whichever language fits best when it names none it knows", async () => {
    const content = show('<pre data-language="cobol">SELECT name FROM users WHERE id = 1;</pre>');
    await highlighted(content);
    expect(content.querySelector(".hljs-keyword")).toHaveTextContent("SELECT");
  });

  it("copies a highlighted code block's lines without the surrounding prose or another block", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const content = show('<p>Run this</p><pre data-language="javascript">const a = 1;<br>const b = 2;</pre><pre>another block</pre>');
    await highlighted(content);
    expect(content.querySelector("pre")!.textContent).toBe("const a = 1;\nconst b = 2;");
    expect(content.querySelectorAll(".hljs-keyword")).toHaveLength(2);
    const button = within(content).getAllByRole("button", { name: "Copy code" })[0]!;
    expect(content.querySelector("pre")).toHaveAttribute("data-language", "javascript");
    expect(content.querySelector("pre button")).toBeNull();
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith("const a = 1;\nconst b = 2;");
    expect(button).toHaveClass("text-positive", "motion-safe:animate-success");
    await user.click(button);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(button).toHaveClass("text-positive", "motion-safe:animate-success");
  });

  it("copies a code block containing a link as plain text, its line breaks kept", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const content = show("<pre>See https://example.com\n  next line</pre>");
    expect(within(content).getByRole("link")).toHaveTextContent("https://example.com");
    await user.click(within(content).getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("See https://example.com\n  next line");
    const broken = show("<pre>curl https://example.com<br>echo done</pre>");
    expect(within(broken).getByRole("link")).toHaveTextContent("https://example.com");
    await user.click(within(broken).getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenLastCalledWith("curl https://example.com\necho done");
  });

  it("copies the lines a code block holds as blocks, as a bot can set them, each on its own line as it shows", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const content = show("<pre>echo one<div>echo two</div><div><div>echo three</div></div><div></div>echo four<br><p>echo five</p></pre>");
    await user.click(within(content).getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("echo one\necho two\necho three\necho four\necho five");
  });

  it("copies nothing a code block hides, as the empty paragraph a message's styles hide, which starts no line", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    // index.css's rule, which tests don't load.
    const styles = document.head.appendChild(document.createElement("style"));
    styles.textContent = ".message-content p:empty { display: none }";
    try {
      const content = show("<pre>echo <p></p>one<div>echo two</div></pre>");
      await user.click(within(content).getByRole("button", { name: "Copy code" }));
      expect(writeText).toHaveBeenCalledWith("echo one\necho two");
    } finally {
      styles.remove();
    }
  });

  it("leaves the button unchanged when the clipboard refuses", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
    show("<pre>puts 1</pre>");
    const button = screen.getByRole("button", { name: "Copy code" });
    const classes = button.className;
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith("puts 1");
    expect(button.className).toBe(classes);
  });

  it("highlights neither inline code nor a code block with a link in it", async () => {
    const content = show('<p><code>const a = 1;</code></p><pre>See https://example.com</pre><pre data-language="javascript">const b = 2;</pre>');
    await highlighted(content);
    expect(content.querySelector("code [class^=hljs-]")).toBeNull();
    expect(content.querySelector("pre")!.innerHTML).toBe('See <a href="https://example.com" target="_blank" rel="noopener">https://example.com</a>');
  });

  it("puts what follows a message in its last paragraph", () => {
    expect(show("<p>One</p><p>Two</p>", <span>(edited)</span>).innerHTML).toBe("<p>One</p><p>Two <span>(edited)</span></p>");
    expect(show("<ul><li>One</li></ul>", <span>(edited)</span>).innerHTML).toBe("<ul><li>One</li></ul><span>(edited)</span>");
  });
});

const grace: DirectoryUser = { id: "0123456789abcdef", name: "Grace Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/g.abc/avatar?v=1" };

const GRACE_MENTION = `<action-text-attachment content-type="application/vnd.campfire.mention" sgid="${grace.id}"></action-text-attachment>`;

/**
 * Shows a message mentioning Grace with the directory listing `people`, the message having named whom it
 * mentions as `mentions` does, and saying `body`, if given, where Grace is `GRACE_MENTION`.
 */
function mention(people: People, mentions: User[], body = `<p>Hi ${GRACE_MENTION}!</p>`) {
  const { container } = render(
    <PeopleContext value={people}>
      <MessageBody nodes={shown(body)} mentions={mentions} />
    </PeopleContext>,
  );
  return container.querySelector(".message-content")!;
}

describe("How mentions look", () => {
  it("shows the person's avatar, hidden from screen readers, then their name as the directory lists them now", () => {
    const content = mention(new Map([[grace.id, grace]]), [{ id: grace.id, name: "Grace" }]);
    expect(content).toHaveTextContent("Hi Grace Hopper!");
    const avatar = content.querySelector("p > span > a > img")!;
    expect(avatar).toHaveAttribute("src", grace.avatarUrl);
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });

  it("names someone the directory doesn't list yet as the message did, by their initials", () => {
    const content = mention(new Map(), [{ id: grace.id, name: "Grace" }]);
    expect(content).toHaveTextContent("Hi Grace!");
    expect(content.querySelector("img")).toHaveAttribute("src", `data:image/svg+xml;base64,${btoa(avatarSvg(grace.id, "Grace"))}`);
  });

  it("shows ☒ for someone no one knows, as a message from before messages named the people they mention doesn't", () => {
    expect(mention(new Map(), []).innerHTML).toBe("<p>Hi ☒!</p>");
    expect(mention(new Map(), [{ id: grace.id, name: "" }]).innerHTML).toBe("<p>Hi ☒!</p>");
  });
});

describe("Avatars open people's pages", () => {
  it("links a mention's avatar to the person's page, titled with their name and bio, and follows it in place", async () => {
    const content = mention(new Map([[grace.id, { ...grace, bio: "Wrote the first compiler" }]]), [{ id: grace.id, name: "Grace" }]);
    const link = screen.getByRole("link", { name: "Grace Hopper – Wrote the first compiler" });
    expect(content.querySelector("p > span > a")).toBe(link);
    expect(link).toHaveAttribute("href", `/users/${grace.id}`);
    await userEvent.click(link);
    expect(location.pathname).toBe(`/users/${grace.id}`);
  });

  it("links the avatar of someone the directory doesn't list yet, titled with the name the message gave", () => {
    mention(new Map(), [{ id: grace.id, name: "Grace" }]);
    expect(screen.getByRole("link", { name: "Grace" })).toHaveAttribute("href", `/users/${grace.id}`);
  });

  it("leaves the avatar an image in a mention inside a link, as a link can't hold another", () => {
    const content = mention(new Map([[grace.id, grace]]), [{ id: grace.id, name: "Grace" }], `<p><a href="https://example.com">Ask ${GRACE_MENTION}</a></p>`);
    expect(screen.getAllByRole("link")).toEqual([screen.getByRole("link", { name: "Ask Grace Hopper" })]);
    expect(content.querySelector("a img")).toHaveAttribute("src", grace.avatarUrl);
  });
});

describe("Links in message text", () => {
  it("opens a link to another site in a new tab", () => {
    show("<p>See https://example.com/docs?page=2.</p>");
    const link = screen.getByRole("link", { name: "https://example.com/docs?page=2" });
    expect(link).toHaveAttribute("href", "https://example.com/docs?page=2");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
  });

  it("opens a link to one of the app's pages in place", async () => {
    show(`<p>Over in ${location.origin}/rooms/r2?ref=x#m1</p>`);
    const link = screen.getByRole("link");
    expect(link).not.toHaveAttribute("target");
    const length = history.length;
    await userEvent.click(link);
    expect(location.pathname + location.search + location.hash).toBe("/rooms/r2?ref=x#m1");
    expect(history.length).toBe(length + 1);
  });

  it("leaves a link to another address on this site to the browser, in the same tab", () => {
    show(`<p>${location.origin}/qr_code/abc</p>`);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `${location.origin}/qr_code/abc`);
    expect(link).not.toHaveAttribute("target");
  });

  it("opens a link in a new tab when its address only starts like this site's", () => {
    // Another port, which Campfire's check, whether the address starts with this site's, takes for this site.
    const lookalike = `${location.origin}1/rooms/r2`;
    expect(new URL(lookalike).origin).not.toBe(location.origin);
    show(`<p>${lookalike}</p>`);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
  });
});

/** A link preview as the composer adds one. */
function preview(details: Parameters<typeof previewContent>[0]): string {
  const attachment = document.createElement("action-text-attachment");
  attachment.setAttribute("content-type", OPENGRAPH_EMBED_CONTENT_TYPE);
  attachment.setAttribute("content", previewContent(details));
  return attachment.outerHTML;
}

describe("Link previews in messages", () => {
  const basecamp = { href: "https://basecamp.com/", url: "https://basecamp.com/og.png", filename: "Basecamp", description: "Calm, at https://basecamp.com/calm" };

  it("shows a preview as a card: its title linking to the page in a new tab, its description, and its image, loaded without a referrer", () => {
    const content = show(`<p>Look</p>${preview(basecamp)}`);
    const title = within(content).getByRole("link", { name: "Basecamp" });
    expect(title).toHaveAttribute("href", "https://basecamp.com/");
    expect(title).toHaveAttribute("target", "_blank");
    expect(within(content).getByRole("link", { name: "https://basecamp.com/calm" })).toHaveAttribute("href", "https://basecamp.com/calm");
    const image = content.querySelector("img")!;
    expect(image).toHaveAttribute("src", "https://basecamp.com/og.png");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("loading", "lazy");
    // So the page's site doesn't learn which Ember shows it.
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("shows an X avatar small and round", () => {
    const content = show(preview({ href: "https://twitter.com/dhh/status/1", url: "https://pbs.twimg.com/profile_images/1/dhh.jpg", filename: "DHH" }));
    expect(content.querySelector("img")!.parentElement).toHaveClass("size-[2lh]", "rounded-full");
  });

  it("shows the title as text when the preview has no link, or is in one", () => {
    const content = show(`${preview({ filename: "Free cookies" })}<a href="https://example.com/">${preview(basecamp)}</a>`);
    expect(content).toHaveTextContent("Free cookies");
    expect(within(content).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["https://example.com/", "https://basecamp.com/calm"]);
  });

  it("shows only the preview of a message that's only its link", () => {
    const content = show(`<p><a href="https://basecamp.com/">https://basecamp.com/</a></p>${preview(basecamp)}`, undefined, "https://basecamp.com/");
    expect(content.querySelector("p")).toBeNull();
    expect(within(content).getByRole("link", { name: "Basecamp" })).toBeInTheDocument();
  });
});

describe("Search results mark what a search matched", () => {
  /** A stored body as a search's results show it, marking `words`. */
  function showMarked(html: string, words: string[]) {
    const { container } = render(
      <SearchMarks value={marksFor(words)}>
        <MessageBody nodes={shown(html)} mentions={[]} />
      </SearchMarks>,
    );
    return container.querySelector<HTMLElement>(".message-content")!;
  }

  it("marks each word it matched, wherever it is in the text, and leaves the text as it was", () => {
    const content = showMarked("<p>Deploying the <strong>deploy</strong> now, not the redeploy</p><ul><li>deploy again</li></ul>", ["deploy", "Deploying"]);
    expect([...content.querySelectorAll("mark[data-search-match]")].map((mark) => mark.textContent)).toEqual(["Deploying", "deploy", "deploy"]);
    expect(content.textContent).toBe("Deploying the deploy now, not the redeploydeploy again");
    expect(content.querySelector("strong mark")).toHaveTextContent("deploy");
  });

  it("marks words in a link's text, which stays a link", () => {
    const content = showMarked('<p>See <a href="https://example.com/launch">the launch notes</a></p>', ["launch"]);
    expect(within(content).getByRole("link", { name: "the launch notes" }).querySelector("mark")).toHaveTextContent("launch");
  });

  it("marks a word in each part of it that formatting splits, but not a part of a longer word, nor words across blocks", () => {
    const content = showMarked("<p><strong>de</strong>ploy, <em>re</em>deploy <span>dep</span><s>loy</s></p><p>de</p><p>ploy</p>", ["deploy"]);
    expect([...content.querySelectorAll("mark[data-search-match]")].map((mark) => mark.textContent)).toEqual(["de", "ploy", "dep", "loy"]);
    expect(content.querySelector("strong mark")).toHaveTextContent("de");
    expect(content.textContent).toBe("deploy, redeploy deploydeploy");
  });

  it("keeps the words it matched in a code block marked once the code is highlighted", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const content = showMarked('<pre data-language="javascript">const deploy = "deploy now";</pre>', ["deploy"]);
    await highlighted(content);
    expect([...content.querySelectorAll("mark[data-search-match]")].map((mark) => mark.textContent)).toEqual(["deploy", "deploy"]);
    expect(content.querySelector(".hljs-string mark")).toHaveTextContent("deploy");
    expect(content.textContent).toBe('const deploy = "deploy now";');
    await user.click(within(content).getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith('const deploy = "deploy now";');
  });

  it("marks nothing when the search had no words, nor Lexxy's highlights as matches", () => {
    const content = showMarked("<p>Deploy <mark>soon</mark></p>", []);
    expect(content.querySelectorAll("mark")).toHaveLength(1);
    expect(content.querySelector("mark[data-search-match]")).toBeNull();
  });
});
