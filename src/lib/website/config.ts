// Website Studio — the two environments the embedded browser + the runner target. The marketer browses the
// live PRODUCTION site or the LOCAL/STAGING render (DevKinsta), and whichever page they're looking at is the
// edit context. Both origins are env-overridable so there's no hardcoded magic URL inline in the UI or the
// runner. Pure (reads process.env only) — safe to import from a server component that passes the values to
// the client blade.

export type WebsiteEnvironment = "production" | "local";

export const WEBSITE_ENVIRONMENTS: WebsiteEnvironment[] = ["production", "local"];

/** Out-of-the-box production origin: the live company website. Overridable via WEBSITE_PROD_URL. */
export const DEFAULT_WEBSITE_PROD_URL = "https://zoeeventsdmv.com";
/** Out-of-the-box local/staging origin: the DevKinsta local render (see the website-devkinsta-local note).
 *  Overridable via WEBSITE_LOCAL_URL; also honors the runner's WEBSITE_PREVIEW_URL when LOCAL is unset so a
 *  single configured preview origin drives both the browser and the screenshots. */
export const DEFAULT_WEBSITE_LOCAL_URL = "http://zoeeventsdmv.local";

export interface WebsiteEnvUrls {
  production: string;
  local: string;
}

function clean(raw: string | undefined, fallback: string): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return v || fallback;
}

/** The configured origins for the two environments. Trailing slashes are stripped so a page path can be
 *  appended directly. Never throws. */
export function websiteEnvUrls(): WebsiteEnvUrls {
  return {
    production: clean(process.env.WEBSITE_PROD_URL, DEFAULT_WEBSITE_PROD_URL),
    local: clean(process.env.WEBSITE_LOCAL_URL || process.env.WEBSITE_PREVIEW_URL, DEFAULT_WEBSITE_LOCAL_URL),
  };
}

/** Coerce an arbitrary value to a valid WebsiteEnvironment, defaulting to "production" (the safe, always-
 *  reachable default). Used to validate the POST body + the runner payload. */
export function coerceEnvironment(v: unknown): WebsiteEnvironment {
  return v === "local" ? "local" : "production";
}

/** Resolve the base origin for an environment. */
export function originForEnvironment(env: WebsiteEnvironment, urls: WebsiteEnvUrls = websiteEnvUrls()): string {
  return env === "local" ? urls.local : urls.production;
}
