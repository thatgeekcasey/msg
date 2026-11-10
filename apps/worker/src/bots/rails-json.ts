/** `value` as `ActiveSupport::JSON` writes it: with `<`, `>` and `&` escaped, as `\u003c`, `\u003e` and `\u0026`. */
export const railsJson = (value: unknown) => JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
