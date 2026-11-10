// Whether an address is this computer's, which nobody on the Internet can reach: where `wrangler dev`
// serves, and the browser tests' stand-ins for other sites.

/** localhost, its subdomains and the loopback addresses, which browsers count as secure over plain HTTP. */
const LOOPBACK_HOST = /^(?:(?:.+\.)?localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** Whether `url` is at localhost or a loopback address. */
export const isLoopback = (url: URL) => LOOPBACK_HOST.test(url.hostname);
