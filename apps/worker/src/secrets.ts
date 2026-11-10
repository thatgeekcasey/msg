// The secrets a person hands Ember from outside, each 32 random bytes as hex (`openssl rand -hex 32`):
// EMBER_SETUP_TOKEN, which the deploy's setup link carries (setup.ts), and EMBER_RECOVERY_TOKEN, which
// apps/worker/scripts/reset-password.ts sends (recovery.ts). Each arrives as a request's bearer token
// and is compared in constant time, as the setup password a person makes up is (setup.ts).

/** The shape of a token: 64 lowercase hex characters. */
export const SECRET_TOKEN = /^[0-9a-f]{64}$/;

/** Whether `value` is set, and shaped like a token. */
export const isSecretToken = (value: string | undefined): value is string => value !== undefined && SECRET_TOKEN.test(value);

/**
 * A secret as the Worker was given it, without the spaces and line breaks that pasting it into the
 * dashboard, or a terminal's copy, can bring along: unset where that leaves nothing.
 */
export const secretOf = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** The request's bearer token, or "" without one. */
export const bearerTokenOf = (request: Request) => request.headers.get("Authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";

const encoder = new TextEncoder();
const sha256 = (text: string) => crypto.subtle.digest("SHA-256", encoder.encode(text));

/** Whether `given` is `token`, compared by SHA-256 so the comparison takes the same time whatever `given` is. */
export async function isToken(given: string, token: string): Promise<boolean> {
  const [expected, actual] = await Promise.all([sha256(token), sha256(given)]);
  return crypto.subtle.timingSafeEqual(expected, actual);
}
