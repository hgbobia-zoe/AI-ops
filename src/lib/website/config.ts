// Website Studio — the two environments the embedded browser + the runner target. The marketer browses the
// live PRODUCTION site or the LOCAL/STAGING render (DevKinsta), and whichever page they're looking at is the
// edit context. Both origins are env-overridable so there's no hardcoded magic URL inline in the UI or the
// runner. Pure (reads process.env only) — safe to import from a server component that passes the values to
// the client blade.

export type WebsiteEnvironment = "production" | "local";

export const WEBSITE_ENVIRONMENTS: WebsiteEnvironment[] = ["production", "local"];

/** Out-of-the-box production origin: the live company website (served from `master`). Overridable via
 *  WEBSITE_PROD_URL. */
export const DEFAULT_WEBSITE_PROD_URL = "https://zoeeventsdmv.com";
/** Out-of-the-box local/staging origin: the DevKinsta render of the WORKING BRANCH (see the
 *  website-devkinsta-local note). This "local" environment is the preview of the non-master feature branch a
 *  job lands on — NOT master/production. Overridable via WEBSITE_LOCAL_URL; also honors the runner's
 *  WEBSITE_PREVIEW_URL when LOCAL is unset so a single configured preview origin drives both the browser and
 *  the screenshots. */
export const DEFAULT_WEBSITE_LOCAL_URL = "http://zoeeventsdmv.local";

// ── Target repository + branch model ────────────────────────────────────────────
// Website Studio orchestrates changes to the SEPARATE website repo. These constants make the target repo and
// the branch/merge model explicit and deterministic (rather than implicit in whatever the office checkout's
// `origin` happens to be), and are shared so the app can DISPLAY the working branch while the office runner
// uses the same convention. All are env-overridable.

/** The GitHub repo the Website Studio targets. `master` on this repo auto-deploys to Kinsta (GitHub Actions
 *  on push to master), so master = production/live. Overridable via WEBSITE_REPO_SLUG. */
export const DEFAULT_WEBSITE_REPO_SLUG = "hgbobia-zoe/zoe-event-rentals";
/** The deploy target / PR base branch — the branch whose pushes deploy to Kinsta. Overridable via
 *  WEBSITE_DEPLOY_BRANCH. */
export const DEFAULT_WEBSITE_DEPLOY_BRANCH = "master";
/** Prefix for the deterministic, clearly-non-master working branch each job lands on. The full branch name is
 *  `${prefix}${jobId}` (e.g. "website-studio/WJ-…"). Overridable via WEBSITE_WORKING_BRANCH_PREFIX (keep it
 *  non-empty and distinct from the deploy branch). */
export const DEFAULT_WORKING_BRANCH_PREFIX = "website-studio/";

/** Default merge behavior on approval. In-app approval is the ONLY gate, so the approved change merges to the
 *  deploy branch IMMEDIATELY (false = do NOT prefer GitHub native auto-merge). Opt into the checks-gated
 *  auto-merge with WEBSITE_AUTO_MERGE=1 (see websiteAutoMerge). */
export const DEFAULT_WEBSITE_AUTO_MERGE = false;

/** The configured target repo slug (owner/name). Never throws. */
export function websiteRepoSlug(): string {
  return (process.env.WEBSITE_REPO_SLUG ?? "").trim() || DEFAULT_WEBSITE_REPO_SLUG;
}

/** The configured deploy target / PR base branch (what deploys to Kinsta on push). Never throws. */
export function websiteDeployBranch(): string {
  return (process.env.WEBSITE_DEPLOY_BRANCH ?? "").trim() || DEFAULT_WEBSITE_DEPLOY_BRANCH;
}

/** Whether the runner should prefer GitHub NATIVE auto-merge (the PR merges itself once required checks pass)
 *  instead of merging immediately on approval. DEFAULT (env unset) = false: in-app approval is the only gate,
 *  so the approved change squash-merges to the deploy branch immediately. Opt IN to the checks-gated native
 *  auto-merge by setting WEBSITE_AUTO_MERGE to a truthy value (1/true/yes/on); 0/false/no/off (or unset) =
 *  immediate. Parsing is intentionally opt-in-truthy so "unset" NEVER means auto-merge. The office runner
 *  (tools/website-studio-runner/runner.js) mirrors this exact rule. Never throws. */
export function websiteAutoMerge(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.WEBSITE_AUTO_MERGE ?? "").trim());
}

/** The working-branch prefix, normalized to end with a single "/". Never throws; falls back to the default if
 *  the env value is blank. */
export function workingBranchPrefix(): string {
  const raw = (process.env.WEBSITE_WORKING_BRANCH_PREFIX ?? "").trim();
  if (!raw) return DEFAULT_WORKING_BRANCH_PREFIX;
  return raw.replace(/\/+$/, "") + "/";
}

/** The deterministic working branch a given job lands on — clearly non-master (e.g.
 *  "website-studio/WJ-1234"). The office runner derives the SAME name from the same convention, so the app can
 *  display the branch the change lives on before it is merged to the deploy branch. Never throws. */
export function workingBranchForJob(jobId: string): string {
  return `${workingBranchPrefix()}${(jobId ?? "").trim()}`;
}

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
