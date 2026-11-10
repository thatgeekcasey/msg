import type { Platform } from "@ember/protocol";
import { strip } from "@ember/richtext";

/**
 * Whether Campfire turns a browser away as too old, whether a request is Apple Messages fetching a link
 * preview, the platform the notification setup help is for, and how the push subscriptions page names a
 * browser. Ports Rails' `allow_browser` (`ActionController::AllowBrowser::BrowserBlocker`) with
 * Campfire's `AllowBrowser::VERSIONS`, Campfire's `ApplicationPlatform` and its push subscriptions page,
 * and the useragent gem 0.16.11, which reads the header for all of them.
 *
 * The gem splits the header into products ("Chrome/120.0.0.0"), each with an optional comment
 * ("(Windows NT 10.0; Win64; x64)"), and the first of its browsers to recognize them decides the
 * browser's name, its version and whether it's a bot. Ruby's `\s` is ASCII-only, so the patterns here
 * spell it out, and Ruby folds Unicode case in case-insensitive patterns, as JavaScript does with the
 * `u` flag. Ruby's `^` and `$` also match at line breaks, which a header can't contain.
 */

/**
 * Campfire's `AllowBrowser::VERSIONS`: the oldest version it allows of each browser, by lowercase name.
 * Internet Explorer's `false` turns every version away.
 */
const MINIMUM_VERSIONS = new Map<string, string | false>([
  ["safari", "17.2"],
  ["chrome", "120"],
  ["firefox", "121"],
  ["opera", "104"],
  ["ie", false],
]);

/**
 * Whether Campfire answers "Upgrade to a supported web browser" (`BrowserBlocker#blocked?`). No user
 * agent, a blank one and one that reports no version get through, as do bots and browsers without a
 * minimum version. So does an agent Rails raises on, such as one with a version the gem names no
 * browser for, which Rails answers with an error page.
 */
export function isUnsupportedBrowser(userAgent: string | null): boolean {
  if (userAgent === null || isBlank(userAgent)) return false;
  const agent = parse(userAgent);
  // Rails reads the version, then the browser. Reading the browser first answers the same, since a
  // step that fails or raises lets the agent through either way, and only browsers with a minimum
  // then need their version read.
  const browser = browserOf(agent);
  const minimum = browser === null ? undefined : MINIMUM_VERSIONS.get(normalizedBrowserName(browser));
  if (minimum === undefined) return false;
  const version = versionOf(agent);
  if (version === null || isBlank(version)) return false;
  return (minimum === false || compareVersions(version, minimum) < 0) && !isBot(agent);
}

/**
 * `BrowserBlocker#normalized_browser_name`. Rails looks the minimum up by this name, so an agent that
 * calls itself "IE" is turned away like Internet Explorer.
 */
function normalizedBrowserName(browser: string): string {
  const name = browser.toLowerCase();
  return name === "internet explorer" ? "ie" : name;
}

/**
 * Whether this is Apple Messages fetching a link preview, which claims to be both Facebook's and
 * Twitter's crawlers (`ApplicationPlatform#apple_messages?`).
 */
export function isAppleMessages(userAgent: string | null): boolean {
  const text = userAgent ?? "";
  return /facebookexternalhit/iu.test(text) && /Twitterbot/iu.test(text);
}

/**
 * The browser and system the notification setup help gives steps for (`ApplicationPlatform#to_view`).
 * Where Ruby raises on an agent, as `chrome?` does on one with no browser, the answer is false or "".
 */
export function platformOf(userAgent: string | null): Platform {
  const text = userAgent ?? "";
  const agent = parse(text);
  const browser = browserOf(agent) ?? "";
  const operatingSystem = operatingSystemOf(agent) ?? "";
  const ios = text.includes("iPhone") || text.includes("iPad");
  const android = text.includes("Android");
  const browserIs = (...names: string[]) => names.some((name) => browser.includes(name));
  return {
    ios,
    android,
    desktop: !ios && !android,
    windows: operatingSystem === "Windows",
    chrome: browserIs("Chrome"),
    firefox: browserIs("Firefox", "FxiOS"),
    safari: browserIs("Safari"),
    edge: browserIs("Edg"),
    browser,
    operatingSystem,
  };
}

/** A browser as the push subscriptions page names it. */
export interface BrowserNames {
  browser: string;
  version: string;
  platform: string;
}

/**
 * The browser a push subscription was saved from: each of its name, version and platform is "" where the
 * gem reads none or raises. One saved without a user agent reads as the gem's "Mozilla/4.0 (compatible)".
 */
export function browserNamesOf(userAgent: string | null): BrowserNames {
  const agent = parse(userAgent ?? "");
  return { browser: browserOf(agent) ?? "", version: versionOf(agent) ?? "", platform: platformNameOrNull(agent) ?? "" };
}

/** What `operating_system` calls the system each of these names in the gem's `platform`, in this order. */
const OPERATING_SYSTEMS = [
  ["Android", "Android"],
  ["iPad", "iPad"],
  ["iPhone", "iPhone"],
  ["Macintosh", "macOS"],
  ["Windows", "Windows"],
  ["CrOS", "ChromeOS"],
] as const;

/** The gem raising, which leaves the system unnamed. */
class NoMethodError extends Error {}

/** `platform`, or null where the gem raises. */
function platformNameOrNull(agent: Agent): string | null {
  try {
    return platformNameOf(agent);
  } catch (error) {
    if (error instanceof NoMethodError) return null;
    throw error;
  }
}

/**
 * `ApplicationPlatform#operating_system`: the system the gem's `platform` names, else its `os`, with any
 * Linux called just that. Null when it reads none, or raises.
 */
function operatingSystemOf(agent: Agent): string | null {
  try {
    const platform = platformNameOf(agent) ?? "";
    const named = OPERATING_SYSTEMS.find(([needle]) => platform.includes(needle));
    if (named) return named[1];
    const os = osOf(agent);
    return os?.includes("Linux") ? "Linux" : os;
  } catch (error) {
    if (error instanceof NoMethodError) return null;
    throw error;
  }
}

/** `platform`: the device or system, mostly the first part of the application's comment. */
function platformNameOf(agent: Agent): string | null {
  const application = applicationOf(agent);
  const comment = application?.comment ?? null;
  const first = comment?.[0];
  const mentions = (needle: string) => comment?.some((part) => part.includes(needle)) === true;
  switch (agent.kind) {
    case "Base":
    case "Libavformat":
      return null;
    case "Edge":
    case "InternetExplorer":
    case "WindowsMediaPlayer":
      return "Windows";
    case "Opera":
    case "AppleCoreMedia":
      return first?.includes("Windows") ? "Windows" : (first ?? null);
    case "WechatBrowser":
      if (first?.includes("iPhone")) return "iPhone";
      return mentions("Android") ? "Android" : (first ?? null);
    case "Chrome":
    case "Vivaldi":
      if (first?.includes("Windows")) return "Windows";
      if (mentions("CrOS")) return "ChromeOS";
      return mentions("Android") ? "Android" : (first ?? null);
    case "Webkit":
    case "ITunes":
      return webkitPlatform(application);
    case "PlayStation":
      return playStationPlatform(comment);
    case "PodcastAddict": {
      const os = podcastAddictOs(agent.products);
      if (os === null) throw new NoMethodError();
      return os.includes("Android") ? "Android" : null;
    }
    case "Gecko":
      if (first === "compatible" || first === "Mobile") return null;
      return first?.startsWith("Windows ") ? "Windows" : (first ?? null);
  }
}

/**
 * `os`, which is read only when the platform names no system. Edge's, Internet Explorer's and Windows
 * Media Player's platform is always Windows, and so is iTunes' whenever its `os` would read a Windows
 * version, so neither of those readings is ported.
 */
function osOf(agent: Agent): string | null {
  const application = applicationOf(agent);
  const comment = application?.comment ?? null;
  switch (agent.kind) {
    case "Opera":
      if (comment === null) return null;
      return comment[0]?.includes("Windows") ? normalizeOs(comment[0]) : (comment[1] ?? null);
    case "WechatBrowser":
    case "Chrome":
    case "Vivaldi":
    case "AppleCoreMedia":
      return comment === null ? null : chromeOs(comment);
    case "Webkit":
    case "ITunes":
      return webkitOs(application);
    case "PlayStation":
      return comment === null ? null : comment.join(" ");
    case "PodcastAddict":
      return podcastAddictOs(agent.products);
    case "Gecko":
      return comment === null ? null : geckoOs(comment);
    default:
      return null;
  }
}

/** `PlayStation#platform`. */
function playStationPlatform(comment: string[] | null): string | null {
  const os = comment?.join(" ") ?? "";
  if (os.includes("PLAYSTATION 3")) return "PlayStation 3";
  if (os.includes("PlayStation 4")) return "PlayStation 4";
  if (os.includes("PlayStation Vita")) return "PlayStation Vita";
  return null;
}

/** `PodcastAddict#os`, from its fourth product, which raises when that's a Dalvik or Mozilla without a comment. */
function podcastAddictOs(products: Product[]): string | null {
  const device = products[3];
  if (device === undefined || (device.product !== "Dalvik" && device.product !== "Mozilla")) return null;
  if (device.comment === null) throw new NoMethodError();
  if (device.comment.length > 3) return device.comment[2]!;
  return device.comment.length === 3 ? "Android" : null;
}

/** `Chrome#os`, which WeChat's browser, Vivaldi and AppleCoreMedia share. */
function chromeOs(comment: string[]): string | null {
  const [first = "", second, third] = comment;
  const os = first.includes("Windows NT") ? first : third === undefined || second?.includes("Android") ? second : third;
  return os === undefined ? null : normalizeOs(os);
}

/** `Gecko#os`: the second part of the comment, or the third after a "U", or the first when it's Windows or Android. */
function geckoOs(comment: string[]): string | null {
  const [first, second] = comment;
  let index = 1;
  if (second === "U") index = 2;
  else if (first?.startsWith("Windows ") || first?.startsWith("Android")) index = 0;
  else if (first === "Mobile") return null;
  const os = comment[index];
  return os === undefined ? null : normalizeOs(os);
}

/** A product of the header, such as `Mozilla/5.0 (Windows NT 10.0; Win64; x64)`. */
interface Product {
  product: string;
  version: string;
  /** The comment, split at "; ". */
  comment: string[] | null;
}

/** The gem's browsers (`UserAgent::Browsers`); an agent none of them recognizes is read as "Base". */
type Kind =
  | "Base"
  | "Edge"
  | "InternetExplorer"
  | "Opera"
  | "WechatBrowser"
  | "Vivaldi"
  | "Chrome"
  | "ITunes"
  | "PlayStation"
  | "PodcastAddict"
  | "Webkit"
  | "Gecko"
  | "WindowsMediaPlayer"
  | "AppleCoreMedia"
  | "Libavformat";

interface Agent {
  kind: Kind;
  products: Product[];
}

const DEFAULT_USER_AGENT = "Mozilla/4.0 (compatible)";

/** `UserAgent::MATCHER`: a product, its version, and its comment or a ",gzip(gfe)". */
const PRODUCT = /^['"]*([^/ \t\n\v\f\r]+)\/?([^ \t\n\v\f\r,]*)([ \t\n\v\f\r]\(([^)]*)\)|,gzip\(gfe\))?/;
/** `PRODUCT` without the comment and the ",gzip(gfe)", neither of which can match without a ")". */
const PRODUCT_WITHOUT_COMMENT = /^['"]*([^/ \t\n\v\f\r]+)\/?([^ \t\n\v\f\r,]*)/;

/** `UserAgent.parse`, which reads a header that strips to nothing as "Mozilla/4.0 (compatible)". */
function parse(userAgent: string): Agent {
  let rest = strip(userAgent) === "" ? DEFAULT_USER_AGENT : userAgent;
  // A comment's "(" sends `PRODUCT` looking for its ")" as far as the end of the header, which takes
  // quadratic time on a header of many "(" and no ")". Once no ")" is left, no comment is looked for.
  let closers = countOf(rest, ")");
  const products: Product[] = [];
  for (let match = matchProduct(rest, closers); match !== null; match = matchProduct(rest, closers)) {
    const [matched, product = "", version = "", , comment] = match;
    products.push({ product, version, comment: comment === undefined ? null : rubySplit(comment, "; ") });
    closers -= countOf(matched, ")");
    rest = strip(rest.slice(matched.length));
  }
  const kind = BROWSERS.find(([, recognizes]) => recognizes(products))?.[0] ?? "Base";
  return { kind, products };
}

/** `UserAgent::MATCHER` at the start of `text`, which holds `closers` ")". */
function matchProduct(text: string, closers: number): RegExpExecArray | null {
  return (closers > 0 ? PRODUCT : PRODUCT_WITHOUT_COMMENT).exec(text);
}

/** `/MicroMessenger/i`. Ruby's folding also matches "ß" to "ss", where JavaScript's doesn't. */
const MICRO_MESSENGER = /MicroMe(?:ss|ß)enger/iu;
const WEBKIT_PRODUCT = /^AppleWebKit$/iu;
const WEBKIT_COMMENT = /^AppleWebKit\/([\d.]+)/iu;
const WINDOWS_MEDIA_PLAYERS = ["NSPlayer", "Windows-Media-Player", "WMFSDK"];
/** libavformat's version of NSPlayer, and the two VLC sends. */
const NOT_WINDOWS_MEDIA_PLAYER = ["4.1.0.3856", "7.10.0.3059", "7.0.0.1956"];

/** `UserAgent::Browsers::ALL` with each one's `extend?`, in the order the gem tries them. */
const BROWSERS: [Kind, (products: Product[]) => boolean][] = [
  ["Edge", (products) => products.at(-1)?.product === "Edge"],
  ["InternetExplorer", ([first]) => isInternetExplorer(first?.comment)],
  ["Opera", (products) => products[0]?.product === "Opera" || products.at(-1)?.product === "OPR"],
  ["WechatBrowser", (products) => products.some(({ product }) => MICRO_MESSENGER.test(product))],
  ["Vivaldi", (products) => products.some(({ product }) => product === "Vivaldi")],
  ["Chrome", (products) => products.some(({ product }) => product === "Chrome" || product === "CriOS")],
  ["ITunes", (products) => products.some(({ product }) => product === "iTunes")],
  ["PlayStation", ([first]) => isPlayStation(first?.comment?.[0])],
  [
    "PodcastAddict",
    ([podcast, addict, dash]) => podcast?.product === "Podcast" && addict?.product === "Addict" && dash?.product === "-",
  ],
  ["Webkit", (products) => products.some(isWebKit)],
  ["Gecko", ([first]) => first?.product === "Mozilla"],
  [
    "WindowsMediaPlayer",
    (products) =>
      products.some(({ product }) => WINDOWS_MEDIA_PLAYERS.includes(product)) &&
      !NOT_WINDOWS_MEDIA_PLAYER.includes(products[0]!.version),
  ],
  ["AppleCoreMedia", (products) => products.some(({ product }) => product === "AppleCoreMedia")],
  [
    "Libavformat",
    (products) =>
      products.some(({ product }) => product === "Lavf" || (product === "NSPlayer" && products[0]!.version === "4.1.0.3856")),
  ],
];

/** `InternetExplorer.extend?`, on the first product's comment. */
function isInternetExplorer(comment: string[] | null | undefined): boolean {
  if (!comment) return false;
  return comment[1]?.includes("MSIE") || hasTridentThenRv(comment.join("; "));
}

/**
 * `/Trident.+rv:/`: whether a line has an "rv:" at least a character after a "Trident". Checking each
 * line's first "Trident" against its last "rv:" is enough, where the regular expression tries every
 * "Trident", which takes quadratic time on a comment of many.
 */
function hasTridentThenRv(text: string): boolean {
  // Ruby's `.` matches anything but "\n".
  return text.split("\n").some((line) => {
    const trident = line.indexOf("Trident");
    return trident !== -1 && line.lastIndexOf("rv:") > trident + "Trident".length;
  });
}

/** `PlayStation.extend?`, on the first part of the first product's comment. */
function isPlayStation(system: string | undefined): boolean {
  if (system === undefined) return false;
  return system.includes("PLAYSTATION 3") || system.includes("PlayStation Vita") || system.includes("PlayStation 4");
}

/** `Webkit.extend?`, on one product: an AppleWebKit product, or a comment part naming an AppleWebKit build. */
function isWebKit({ product, comment }: Product): boolean {
  return WEBKIT_PRODUCT.test(product) || (comment ?? []).some((part) => WEBKIT_COMMENT.test(part));
}

/** The browsers whose `application` is their first product with a comment, where the others' is their first. */
const READ_FROM_FIRST_COMMENT = new Set<Kind>(["Chrome", "Vivaldi", "Webkit", "ITunes", "AppleCoreMedia"]);

/** `application`: the product the browser is read from. */
function applicationOf({ kind, products }: Agent): Product | undefined {
  if (!READ_FROM_FIRST_COMMENT.has(kind)) return products[0];
  return products.find(({ comment }) => comment !== null && comment.length > 0);
}

/** `browser`, which is null for a PlayStation Vita without Silk and for a header that has no products. */
function browserOf(agent: Agent): string | null {
  const { products } = agent;
  switch (agent.kind) {
    case "Base":
      return applicationOf(agent)?.product ?? null;
    case "Edge":
      return "Edge";
    case "InternetExplorer":
      return "Internet Explorer";
    case "Opera":
      return "Opera";
    case "WechatBrowser":
      return "Wechat Browser";
    case "Vivaldi":
      return "Vivaldi";
    case "Chrome":
      return detectProduct(products, "Iron") ? "Iron" : "Chrome";
    case "ITunes":
      return "iTunes";
    case "PlayStation":
      return playStationBrowser(products);
    case "PodcastAddict":
      return "Podcast Addict";
    case "Webkit":
      return webkitBrowser(applicationOf(agent));
    case "Gecko":
      return geckoBrowser(products);
    case "WindowsMediaPlayer":
      return "Windows Media Player";
    case "AppleCoreMedia":
      return "AppleCoreMedia";
    case "Libavformat":
      return "libavformat";
  }
}

/** `version`, or null where the gem reads none, or raises, as WeChat's browser does without a MicroMessenger product. */
function versionOf(agent: Agent): string | null {
  const { products } = agent;
  const application = applicationOf(agent);
  switch (agent.kind) {
    case "Base":
    case "WindowsMediaPlayer":
    case "AppleCoreMedia":
      return application?.version ?? null;
    case "Edge":
    case "Vivaldi":
      return products.at(-1)?.version ?? null;
    case "InternetExplorer":
      return /(MSIE[ \t\n\v\f\r]|rv:)([\d.]+)/.exec(application!.comment!.join("; "))?.[2] ?? "";
    case "Opera":
      return operaVersion(products);
    case "WechatBrowser":
      return detectProduct(products, "MicroMessenger")?.version ?? null;
    case "Chrome":
      return (detectProduct(products, "CriOS") ?? detectProduct(products, "Chrome"))!.version;
    case "ITunes":
      return detectProduct(products, "iTunes")!.version;
    case "PlayStation":
      return playStationVersion(products);
    case "PodcastAddict":
      return null;
    case "Webkit":
      return webkitVersion(products, application);
    case "Gecko": {
      const version = detectProduct(products, geckoBrowser(products))!.version;
      return isNilVersion(version) ? application!.version : version;
    }
    case "Libavformat":
      return detectProduct(products, "NSPlayer") === undefined ? (application?.version ?? null) : null;
  }
}

/** `bot?`: an agent with no application, a comment that mentions a bot, Lighthouse, or a "bot" application. */
function isBot(agent: Agent): boolean {
  const application = applicationOf(agent);
  if (application === undefined) return true;
  return (
    agent.products.some(({ comment }) => comment?.some((part) => /bot/iu.test(part))) ||
    detectProduct(agent.products, "Chrome-Lighthouse") !== undefined ||
    application.product.includes("bot")
  );
}

/** `Opera#version`: Opera Mini's from its comment, else the Version or OPR product's, else its own. */
function operaVersion(products: Product[]): string {
  const application = products[0]!;
  // `mini?` looks for "Opera Mini" in the application's text, where only its comment can hold a space.
  const mini = application.comment?.find((part) => part.includes("Opera Mini"));
  if (mini !== undefined) return /Opera Mini\/([\d.]+)/.exec(mini)?.[1] ?? "";
  return (detectProduct(products, "Version") ?? detectProduct(products, "OPR") ?? application).version;
}

/** The consoles `PlayStation#platform` names, as their browsers' comments name them, in the order it looks for them. */
const PLAYSTATIONS = ["PLAYSTATION 3", "PlayStation 4", "PlayStation Vita"];

/** `PlayStation#version`: Silk's own, else what follows the console's name in the first product's comment. */
function playStationVersion(products: Product[]): string | null {
  if (playStationBrowser(products) === "Silk") return products.at(-1)!.version;
  const os = products[0]!.comment!.join(" ");
  const model = PLAYSTATIONS.find((name) => os.includes(name));
  return model === undefined ? null : (rubySplit(os, `${model} `).at(-1) ?? "");
}

/** `PlayStation#browser`. */
function playStationBrowser(products: Product[]): string | null {
  const system = products[0]!.comment![0]!;
  if (system.includes("PLAYSTATION 3")) return "PS3 Internet Browser";
  if (products.at(-1)!.product === "Silk") return "Silk";
  if (system.includes("PlayStation 4")) return "PS4 Internet Browser";
  return null;
}

const GECKO_BROWSERS = ["PaleMoon", "Firefox", "Camino", "Iceweasel", "Seamonkey"];

/** `Gecko#browser`: the first of `GECKO_BROWSERS` the agent has, else its first product, "Mozilla". */
function geckoBrowser(products: Product[]): string {
  return GECKO_BROWSERS.find((name) => detectProduct(products, name) !== undefined) ?? products[0]!.product;
}

/** `Webkit#browser`: Safari, unless its operating system is Android or it's a BlackBerry. */
function webkitBrowser(application: Product | undefined): string {
  if (webkitOs(application)?.includes("Android")) return "Android";
  if (webkitPlatform(application) === "BlackBerry") return "BlackBerry";
  return "Safari";
}

/** `Webkit#os`: the operating system named in the application's comment. */
function webkitOs(application: Product | undefined): string | null {
  const comment = application?.comment;
  if (!comment) return null;
  const [first = "", second, third] = comment;
  if (first.includes("Windows NT")) return normalizeOs(first);
  if (third === undefined) return second === undefined ? null : normalizeOs(second);
  if (second?.includes("Android")) return normalizeOs(second);
  return normalizeOs(comment.find((part) => IOS_VERSION.test(part)) ?? third);
}

/** `Webkit#platform`. */
function webkitPlatform(application: Product | undefined): string | null {
  const comment = application?.comment;
  if (!comment) return null;
  const [first = ""] = comment;
  if (first.includes("Windows")) return "Windows";
  if (first === "BB10") return "BlackBerry";
  if (comment.some((part) => part.includes("Android"))) return "Android";
  return first;
}

/**
 * `Webkit#version`: its Version product's, else Safari's iOS version, else the Safari version of its
 * WebKit build, which is all Safari reported before Safari 3.
 */
function webkitVersion(products: Product[], application: Product | undefined): string {
  const product = detectProduct(products, "Version");
  if (product !== undefined) return product.version;
  const ios = /iOS ([\d.]+)/.exec(webkitOs(application) ?? "");
  if (ios !== null && webkitBrowser(application) === "Safari") return ios[1]!;
  return SAFARI_BUILDS.get(webkitBuild(products)) ?? "";
}

/** `Webkit#build`: the version of the AppleWebKit product, or of the first comment part naming one. */
function webkitBuild(products: Product[]): string {
  const product = products.find(({ product }) => WEBKIT_PRODUCT.test(product));
  if (product !== undefined) return product.version;
  for (const part of products.flatMap(({ comment }) => comment ?? [])) {
    const build = WEBKIT_COMMENT.exec(part)?.[1];
    if (build !== undefined) return build;
  }
  return "";
}

/** `Webkit::BuildVersions`: the Safari version of each WebKit build, from before Safari 3. */
const SAFARI_BUILDS = new Map([
  ["85.7", "1.0"],
  ["85.8.5", "1.0.3"], ["85.8.2", "1.0.3"],
  ["124", "1.2"],
  ["125.2", "1.2.2"],
  ["125.4", "1.2.3"],
  ["125.5.5", "1.2.4"], ["125.5.6", "1.2.4"], ["125.5.7", "1.2.4"],
  ["312.1.1", "1.3"], ["312.1", "1.3"],
  ["312.5", "1.3.1"], ["312.5.1", "1.3.1"], ["312.5.2", "1.3.1"],
  ["312.8", "1.3.2"], ["312.8.1", "1.3.2"],
  ["412", "2.0"], ["412.6", "2.0"], ["412.6.2", "2.0"],
  ["412.7", "2.0.1"],
  ["416.11", "2.0.2"], ["416.12", "2.0.2"],
  ["417.9", "2.0.3"], ["418", "2.0.3"],
  ["418.8", "2.0.4"], ["418.9", "2.0.4"], ["418.9.1", "2.0.4"], ["419", "2.0.4"],
  ["425.13", "2.2"],
  ["534.52.7", "5.1.2"],
]);

/** `OperatingSystems::IOS_VERSION_REGEX`. */
const IOS_VERSION = /CPU (?:iPhone |iPod )?OS ([\d_]+) like Mac OS X/;

/** `OperatingSystems::Windows`: the names of Windows versions, by what they call themselves. */
const WINDOWS_VERSIONS = new Map([
  ["Windows NT 10.0", "Windows 10"],
  ["Windows NT 6.3", "Windows 8.1"],
  ["Windows NT 6.2", "Windows 8"],
  ["Windows NT 6.1", "Windows 7"],
  ["Windows NT 6.0", "Windows Vista"],
  ["Windows NT 5.2", "Windows XP x64 Edition"],
  ["Windows NT 5.1", "Windows XP"],
  ["Windows NT 5.01", "Windows 2000, Service Pack 1 (SP1)"],
  ["Windows NT 5.0", "Windows 2000"],
  ["Windows NT 4.0", "Windows NT 4.0"],
  ["Windows 98", "Windows 98"],
  ["Windows 95", "Windows 95"],
  ["Windows CE", "Windows CE"],
]);

/** `OperatingSystems.normalize_os`. */
function normalizeOs(os: string): string {
  const windows = WINDOWS_VERSIONS.get(os);
  if (windows !== undefined) return windows;
  const macOsX = /(?:Intel|PPC) Mac OS X[ \t\n\v\f\r]*([\d_.]+)?/.exec(os);
  if (macOsX !== null) return macOsX[1] === undefined ? "OS X" : `OS X ${macOsX[1].replaceAll("_", ".")}`;
  const ios = IOS_VERSION.exec(os);
  if (ios !== null) return `iOS ${ios[1]!.replaceAll("_", ".")}`;
  const chromeOs = /CrOS[ \t\n\v\f\r][^ \t\n\v\f\r]+[ \t\n\v\f\r](\d+(?:\.\d+)*)/.exec(os);
  if (chromeOs !== null) return `ChromeOS ${chromeOs[1]}`;
  return os;
}

/**
 * `UserAgent::Version#<=>`. A version that starts with a number is compared part by part, its first six
 * parts only, with a missing part as 0 and letters below any number; any other version is below every
 * version but itself.
 */
function compareVersions(version: string, other: string): number {
  if (!isNumbered(version)) return version === other ? 0 : -1;
  const [ours, theirs] = [versionParts(version), versionParts(other)];
  for (let i = 0; i < 6; i++) {
    const [a, b] = [ours[i] ?? 0n, theirs[i] ?? 0n];
    if (typeof a === "string" && typeof b === "bigint") return -1;
    if (typeof a === "bigint" && typeof b === "string") return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * `Version#to_a`: a numbered version's numbers and its trailing letters, or any other version whole.
 * The gem scans for `/\d+|[A-Za-z][0-9A-Za-z-]*$/`, whose letters can only start in the run of letters,
 * digits and dashes the version ends with. Trying them anywhere else takes quadratic time on a long
 * run of letters that ends before the version does, so this reads numbers up to that run's first
 * letter, and letters from there.
 */
function versionParts(version: string): (bigint | string)[] {
  if (isNilVersion(version)) return [];
  if (!isNumbered(version)) return [version];
  const lastRun = version.split(/[^0-9A-Za-z-]/).at(-1)!;
  const letter = lastRun.search(/[A-Za-z]/);
  const numbers = letter === -1 ? version : version.slice(0, version.length - lastRun.length + letter);
  const parts: (bigint | string)[] = (numbers.match(/\d+/g) ?? []).map((digits) => BigInt(digits));
  return letter === -1 ? parts : [...parts, lastRun.slice(letter)];
}

/** Whether `Version.new` makes a version comparable: it's a number, or a number and a dot first. */
const isNumbered = (version: string) => /^\d+(?:\.|$)/.test(version);

/** `Version#nil?`. */
const isNilVersion = (version: string) => /^[ \t\n\v\f\r]*$/.test(version);

/** `detect_product`: the first product of this name, ignoring case. */
function detectProduct(products: Product[], name: string): Product | undefined {
  const lowercase = name.toLowerCase();
  return products.find(({ product }) => product.toLowerCase() === lowercase);
}

/** ActiveSupport's `blank?`: nothing but Unicode whitespace. */
const isBlank = (text: string) => /^\p{White_Space}*$/u.test(text);

/** How many times `character` appears in `text`. */
function countOf(text: string, character: string): number {
  let count = 0;
  for (let i = text.indexOf(character); i !== -1; i = text.indexOf(character, i + 1)) count++;
  return count;
}

/** `String#split`, which drops trailing empty strings. */
function rubySplit(text: string, separator: string): string[] {
  const parts = text.split(separator);
  while (parts.at(-1) === "") parts.pop();
  return parts;
}
