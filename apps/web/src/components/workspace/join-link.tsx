import { EMAIL_SIGN_UP_PATH, SIGN_UP_PATH } from "@ember/protocol";
import type { LinkSharing } from "./link-buttons";

// The join link, which the invite block on workspace settings and the welcome card both hand on with the
// same buttons, as Membership hands on open sign-up's page.

/** The join link for `joinCode`, absolute. */
export const joinUrl = (joinCode: string) => new URL(`/join/${joinCode}`, location.origin).href;

/** What the join link's buttons are called, and what sharing it sends. */
export const JOIN_LINK: LinkSharing = {
  qrCodeLabel: "Show join link QR code",
  copyLabel: "Copy join link",
  shareLabel: "Share join link",
  title: "Link to join Ember",
  text: "Hit this link to join me in Ember and start chatting.",
};

/** Open sign-up's page, absolute, where anyone may create an account while Open is on. */
export const signUpUrl = () => new URL(SIGN_UP_PATH, location.origin).href;

/** What open sign-up's link's buttons are called, and what sharing it sends, as the join link does. */
export const SIGN_UP_LINK: LinkSharing = {
  ...JOIN_LINK,
  qrCodeLabel: "Show sign-up link QR code",
  copyLabel: "Copy sign-up link",
  shareLabel: "Share sign-up link",
};

/** Email domain's page, absolute, where people with an address at the workspace's email domains ask for a link to join. */
export const emailSignUpUrl = () => new URL(EMAIL_SIGN_UP_PATH, location.origin).href;

/** What Email domain's link's buttons are called, and what sharing it sends, as the join link does. */
export const EMAIL_SIGN_UP_LINK: LinkSharing = {
  ...JOIN_LINK,
  qrCodeLabel: "Show email sign-up link QR code",
  copyLabel: "Copy email sign-up link",
  shareLabel: "Share email sign-up link",
  text: "Hit this link to join me in Ember with your email address.",
};
