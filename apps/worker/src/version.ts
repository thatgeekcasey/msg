import { version } from "../package.json";
import type { Env } from "./env";

/** The version this Ember was released as, apps/worker/package.json's, such as "0.1.0", or "0.5.0-beta.1" for a beta of 0.5.0. */
export const VERSION = version;

/** Whether a version is a beta's, which comes before its release and is offered only to whoever asks for one. */
export const isBeta = (version: string) => /^\d+\.\d+\.\d+-beta\.\d+$/.test(version);

/** A release, named: its version without a trailing ".0", and a beta's as "0.5 beta 1". */
export const releaseNameOf = (version: string) => version.replace(/^(\d+\.\d+)\.0\b/, "$1").replace(/-beta\.(\d+)$/, " beta $1");

/** A setting's value, unless it's blank, which counts as unset. */
const present = (value: string | undefined) => (value?.trim() ? value : undefined);

/** This deployment's version: APP_VERSION, else GIT_REVISION, else the release. */
export const versionOf = (env: Env) => present(env.APP_VERSION) ?? present(env.GIT_REVISION) ?? releaseNameOf(VERSION);
