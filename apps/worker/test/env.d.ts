// `wrangler types` would generate this; the tests only need the default export's fetch.
declare namespace Cloudflare {
  interface Exports {
    default: Fetcher;
  }
}
