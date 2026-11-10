import { describe, expect, it } from "vitest";
import { emojiNamed, mrkdwnHtml, plainTextHtml } from "../src/bots/mrkdwn";

describe("Slack-compatible webhooks", () => {
  describe("mrkdwn", () => {
    it("formats *bold*, _italics_, ~strike-through~ and `code`, nested or not", () => {
      expect(mrkdwnHtml("*bold* _italic_ ~struck~ `code`")).toBe("<p><strong>bold</strong> <em>italic</em> <s>struck</s> <code>code</code></p>");
      expect(mrkdwnHtml("*_both_* and *bold with _italics_ in it*")).toBe("<p><strong><em>both</em></strong> and <strong>bold with <em>italics</em> in it</strong></p>");
      expect(mrkdwnHtml("(*in brackets*), *before a comma*, and ~end~.")).toBe(
        "<p>(<strong>in brackets</strong>), <strong>before a comma</strong>, and <s>end</s>.</p>",
      );
      expect(mrkdwnHtml("`*not bold* _here_`")).toBe("<p><code>*not bold* _here_</code></p>");
    });

    it("needs a word's edge, and something other than a space inside, on one line, as Slack does", () => {
      for (const text of ["node_cpu_seconds_total", "2*3*4", "a * b * c", "* spaced *", "~ spaced ~", "snake_case_name_", "**"]) {
        expect([text, mrkdwnHtml(text)]).toEqual([text, `<p>${text}</p>`]);
      }
      expect(mrkdwnHtml("*one\ntwo*")).toBe("<p>*one<br>two*</p>");
      expect(mrkdwnHtml("**doubled**")).toBe("<p>*<strong>doubled</strong>*</p>");
    });

    it("keeps line breaks, blank lines between paragraphs, and leaves out blank lines at either end", () => {
      expect(mrkdwnHtml("\n\nfirst\nsecond\n\nthird\n \n")).toBe("<p>first<br>second<br><br>third</p>");
      expect(mrkdwnHtml("one\r\ntwo\rthree")).toBe("<p>one<br>two<br>three</p>");
      expect(mrkdwnHtml("")).toBe("");
      expect(mrkdwnHtml(" \n\t\n")).toBe("");
    });

    it("quotes lines that start with >, escaped or not, and everything after >>>", () => {
      expect(mrkdwnHtml(">quoted\n> more\nafter")).toBe("<blockquote><p>quoted<br>more</p></blockquote><p>after</p>");
      expect(mrkdwnHtml("&gt; escaped, *bold*")).toBe("<blockquote><p>escaped, <strong>bold</strong></p></blockquote>");
      expect(mrkdwnHtml("before\n>>> all\nof\n\nthis")).toBe("<p>before</p><blockquote><p>all<br>of<br><br>this</p></blockquote>");
      expect(mrkdwnHtml("> one line\n>>> the rest\n```\nits code\n```\n> and *more*")).toBe(
        "<blockquote><p>one line</p></blockquote><blockquote><p>the rest</p><pre>its code</pre><p>&gt; and <strong>more</strong></p></blockquote>",
      );
      expect(mrkdwnHtml("```first```\n>>> quoted ```code``` too")).toBe("<pre>first</pre><blockquote><p>quoted</p><pre>code</pre><p>too</p></blockquote>");
    });

    it("sets code blocks between ``` fences, where nothing is formatted but links, and an unpaired fence is text", () => {
      expect(mrkdwnHtml("Before\n```\nconst total = *a* + _b_; // :tada:\n  indented\n```\nafter")).toBe(
        "<p>Before</p><pre>const total = *a* + _b_; // :tada:\n  indented</pre><p>after</p>",
      );
      expect(mrkdwnHtml("```one line``` then text")).toBe("<pre>one line</pre><p>then text</p>");
      expect(mrkdwnHtml("```<https://example.com/logs|logs> &lt;tag&gt;```")).toBe('<pre><a href="https://example.com/logs">logs</a> &lt;tag&gt;</pre>');
      expect(mrkdwnHtml("a ``` b")).toBe("<p>a ``` b</p>");
      expect(mrkdwnHtml("```one``` ``` two")).toBe("<pre>one</pre><p>``` two</p>");
      expect(mrkdwnHtml("``` ```")).toBe("");
    });

    it("links web and email addresses, with their labels formatted, and shows other schemes' as text", () => {
      expect(mrkdwnHtml("<https://example.com/a?b=1&amp;c=2|This *is* a link>")).toBe('<p><a href="https://example.com/a?b=1&amp;c=2">This <strong>is</strong> a link</a></p>');
      expect(mrkdwnHtml("<https://example.com>")).toBe('<p><a href="https://example.com/">https://example.com</a></p>');
      expect(mrkdwnHtml("<mailto:bob@example.com|Email Bob> or <mailto:bob@example.com>")).toBe(
        '<p><a href="mailto:bob@example.com">Email Bob</a> or <a href="mailto:bob@example.com">bob@example.com</a></p>',
      );
      expect(mrkdwnHtml('<javascript:alert(1)|click> <ftp://example.com/file> <https://example.com/"q"|q>')).toBe(
        '<p>click ftp://example.com/file <a href="https://example.com/%22q%22">q</a></p>',
      );
      expect(mrkdwnHtml("<https://|empty host>")).toBe("<p>empty host</p>");
    });

    it("shows mentions of people, channels and groups, and @here and its kin, as text that notifies nobody", () => {
      expect(mrkdwnHtml("<@U024BE7LH> <@U123|bob> <#C024BE7LR> <#C123|general>")).toBe("<p>@U024BE7LH @bob #C024BE7LR #general</p>");
      expect(mrkdwnHtml("<!here> <!channel> <!everyone> <!here|here>")).toBe("<p>@here @channel @everyone @here</p>");
      expect(mrkdwnHtml("<!subteam^SAZ94GDB8|@ops> <!subteam^SAZ94GDB8>")).toBe("<p>@ops @SAZ94GDB8</p>");
    });

    it("shows a date as its fallback, linked if it has a link, or in UTC without one", () => {
      expect(mrkdwnHtml("<!date^1392734382^Posted {date_num} {time_secs}|Posted 2014-02-18 6:39:42 AM PST>")).toBe("<p>Posted 2014-02-18 6:39:42 AM PST</p>");
      expect(mrkdwnHtml("<!date^1392734382^{date}^https://example.com/|Feb 18>")).toBe('<p><a href="https://example.com/">Feb 18</a></p>');
      expect(mrkdwnHtml("<!date^1392734382^{date}>")).toBe("<p>2014-02-18 14:39 UTC</p>");
    });

    it("unescapes &amp;, &lt; and &gt;, once, and only those, and shows angle brackets that aren't Slack's as they are", () => {
      expect(mrkdwnHtml("a &lt; b &gt; c &amp; d &amp;lt; &quot;e&quot;")).toBe("<p>a &lt; b &gt; c &amp; d &amp;lt; &amp;quot;e&amp;quot;</p>");
      expect(mrkdwnHtml("1 < 2 & 3 > 2")).toBe("<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
    });

    it("names emoji, in skin tones too, and leaves names it doesn't know as they are", () => {
      expect(mrkdwnHtml(":tada: :+1::skin-tone-3: :thumbsup: :people_holding_hands::skin-tone-2: :skin-tone-4: :no_such_emoji:")).toBe(
        "<p>🎉 👍🏼 👍 🧑🏻‍🤝‍🧑🏻 🏽 :no_such_emoji:</p>",
      );
      expect(mrkdwnHtml(":rotating_light::rotating_light: ok:white_check_mark:")).toBe("<p>🚨🚨 ok✅</p>");
      expect(mrkdwnHtml(":constructor: :tada::skin-tone-2:")).toBe("<p>:constructor: 🎉</p>");
      expect(emojiNamed("__proto__")).toBeUndefined();
      expect(emojiNamed("raised_hand", 6)).toBe("✋🏿");
      expect(emojiNamed("woman-running", 3)).toBe("🏃🏼‍♀️");
      expect(emojiNamed("raised_hand", 2.5)).toBe("✋");
    });

    it("leaves web addresses written out alone, for Ember to link as it shows them", () => {
      expect(mrkdwnHtml("see https://example.com/_a_/b_c:tada: and *this*")).toBe("<p>see https://example.com/_a_/b_c:tada: and <strong>this</strong></p>");
      expect(mrkdwnHtml("https://example.com/?a=1&amp;b=2")).toBe("<p>https://example.com/?a=1&amp;b=2</p>");
    });

    it("ends the emphasis around a web address at the marks after it", () => {
      expect(mrkdwnHtml("*See https://example.com*")).toBe("<p><strong>See https://example.com</strong></p>");
      expect(mrkdwnHtml("(_logs at https://example.com/a_b_), ~https://example.com/~*")).toBe(
        "<p>(<em>logs at https://example.com/a_b</em>), <s>https://example.com/</s>*</p>",
      );
      expect(mrkdwnHtml("https://example.com/a_b_ and https://example.com/𝐀_")).toBe("<p>https://example.com/a_b_ and https://example.com/𝐀_</p>");
    });

    it("formats only links, mentions, dates, emoji and escapes when plain", () => {
      expect(mrkdwnHtml("*not bold* > not quoted\n```not code``` <https://example.com|link> <@U1> :tada: &amp;", "plain")).toBe(
        '<p>*not bold* &gt; not quoted<br>```not code``` <a href="https://example.com/">link</a> @U1 🎉 &amp;</p>',
      );
    });

    it("shows plain_text as it is, but for emoji unless they're turned off", () => {
      expect(plainTextHtml("*as is* <https://example.com> &amp; :tada:\nnext")).toBe("<p>*as is* &lt;https://example.com&gt; &amp;amp; 🎉<br>next</p>");
      expect(plainTextHtml(":tada:", false)).toBe("<p>:tada:</p>");
      expect(plainTextHtml("\n")).toBe("");
    });

    it("reads a long line of marks that never pair in a moment", () => {
      const started = Date.now();
      expect(mrkdwnHtml("*a_b~c".repeat(15_000))).toHaveLength(6 * 15_000 + "<p></p>".length);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("trims a code block's line breaks and a paragraph's spaces in a moment, however long a run of them it holds", () => {
      const [breaks, spaces] = ["\n".repeat(300_000), " ".repeat(300_000)];
      const started = Date.now();
      expect(mrkdwnHtml(`\`\`\`a${breaks}b\`\`\``)).toBe(`<pre>a${breaks}b</pre>`);
      expect(mrkdwnHtml(`a${spaces}b`)).toBe(`<p>a${spaces}b</p>`);
      // Patterns for the run at the text's end would try to end each run inside it there: some 15 seconds each for these.
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
