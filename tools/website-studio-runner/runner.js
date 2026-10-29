// Website Studio — office-machine runner.
//
// BRANCH / MERGE MODEL (see src/lib/website/config.ts — the app shares these constants to DISPLAY the branch):
//   • Target repo:    WEBSITE_REPO_SLUG   (default "hgbobia-zoe/zoe-event-rentals"). All `gh` calls pass
//                     --repo <slug> so the PR + merge always act on THIS repo, not whatever the local
//                     checkout's origin happens to be.
//   • Working branch: WEBSITE_WORKING_BRANCH_PREFIX + <jobId>  (default "website-studio/<jobId>") — the
//                     deterministic, clearly-NON-master branch every change lands on.
//   • Deploy branch:  WEBSITE_DEPLOY_BRANCH  (default "master") — the PR base. A push to master auto-deploys
//                     to Kinsta (GitHub Actions on push to master), so master = production/live.
//
// WHAT IT DOES, one job at a time (single-flight — the local DevKinsta site reflects the current job):
//   1. Claim the next queued job from the app         (GET  <APP_URL>/api/website/runner/next)
//   2. In WEBSITE_REPO_PATH, fetch the deploy branch, then cut the working branch off origin/<deploy branch>
//   3. Run the Claude Agent SDK (centralized ANTHROPIC_API_KEY) with the marketer's prompt to edit the repo
//   4. Commit the change on the WORKING branch (NEVER on the deploy branch)
//   5. Apply the branch's working tree to the LOCAL DevKinsta WordPress site (sync.ps1 if present, else
//      docker cp) — LOCAL PREVIEW ONLY, never the live site
//   6. Screenshot the changed page(s) at desktop (1280w) + mobile (390w) with Playwright, upload them +
//      the summary + the changed-file list, and set the job to `preview`  (POST .../runner/artifact, .../runner/update)
//   7. WAIT for the human decision (poll GET .../runner/job?id=<jobId>):
//        approved  → push the working branch + `gh pr create` (base = deploy branch), then AUTO-MERGE to the
//                    deploy branch: enable GitHub native auto-merge (merge when checks pass) and fall back to
//                    an immediate merge if the repo has no auto-merge/required checks. The merge to master is
//                    what triggers the Kinsta deploy. → set `done` with the PR url.
//        discarded → delete the local branch, restore the local site to a clean deploy branch → (already `discarded`)
//
// GUARDRAILS (this edits real website code driven by non-engineers):
//   • The agent is FILE-OPS ONLY — Read/Write/Edit/Glob/Grep, deliberately NO Bash/shell. Under
//     bypassPermissions nobody approves tool calls and prompts come from non-engineers (possibly with text
//     injected via files the agent reads), so a shell would be arbitrary command execution on this machine
//     (whose env holds ANTHROPIC_API_KEY + WEBSITE_RUNNER_TOKEN). The RUNNER owns git, the build/preview
//     deploy, PRs, and the merge — the agent just edits website source under cwd=WEBSITE_REPO_PATH.
//   • The runner NEVER commits to / pushes the deploy branch directly. The ONLY way a change reaches master is
//     a human APPROVING the preview in the app, which lets the runner open the PR and merge it (preferring
//     GitHub auto-merge so required checks still gate the deploy). Discarded/queued jobs never touch master.
//   • One job at a time. One job failing never crashes the loop — it is marked `failed` and the loop continues.
//   • Secrets (ANTHROPIC_API_KEY, WEBSITE_RUNNER_TOKEN) are read from the environment, never hardcoded.
//
// PHASE-2 TODO: move this to a cloud box + run as a service, and serve a real shareable/interactive staging
// URL instead of screenshots. Phase 1's preview IS the screenshots.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Config from the environment ──────────────────────────────────────────────
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
const RUNNER_TOKEN = process.env.WEBSITE_RUNNER_TOKEN || "";
const REPO = process.env.WEBSITE_REPO_PATH || "";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
// The base URL the local DevKinsta WordPress site is reachable at (e.g. http://zoeeventsdmv.local). Page
// paths from the agent are appended to this to take screenshots.
const PREVIEW_URL = (process.env.WEBSITE_PREVIEW_URL || "").replace(/\/+$/, "");
// How the branch working tree reaches the DevKinsta container. Preferred: a sync.ps1 in the repo (the
// website redesign uses a docker-cp deploy script). Fallback: docker cp into DEVKINSTA_CONTAINER at
// DEVKINSTA_WP_PATH. If neither is configured, preview deploy is skipped with a clear note (screenshots then
// capture whatever the site currently serves — set one of these up for a true preview).
const DEVKINSTA_CONTAINER = process.env.DEVKINSTA_CONTAINER || "";
const DEVKINSTA_WP_PATH = process.env.DEVKINSTA_WP_PATH || "/var/www/html";
const MODEL = process.env.WEBSITE_MODEL || "claude-opus-4-8";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS || 24 * 60 * 60 * 1000); // give humans a day

// ── Branch / merge model (keep in lockstep with src/lib/website/config.ts so the app displays the SAME
//    working branch the runner cuts). ──────────────────────────────────────────
// The target GitHub repo. `master` on this repo auto-deploys to Kinsta, so master = production. All gh calls
// pass --repo <slug> so the PR + merge always act on THIS repo regardless of the local checkout's origin.
const REPO_SLUG = (process.env.WEBSITE_REPO_SLUG || "hgbobia-zoe/zoe-event-rentals").trim();
// The deploy target / PR base (what deploys to Kinsta on push). Empty => auto-detect the checkout's default.
const DEPLOY_BRANCH = (process.env.WEBSITE_DEPLOY_BRANCH || "master").trim();
// The clearly-non-master working-branch prefix; full name = `${prefix}${jobId}`.
const WORKING_BRANCH_PREFIX = ((process.env.WEBSITE_WORKING_BRANCH_PREFIX || "website-studio").trim().replace(/\/+$/, "")) + "/";
// On approval, prefer GitHub native auto-merge (merge when required checks pass); the immediate-merge fallback
// is used only when the repo has no auto-merge/required-check setup. Set WEBSITE_AUTO_MERGE=0 to force the
// immediate merge. WEBSITE_MERGE_METHOD is squash|merge|rebase.
const AUTO_MERGE = !/^(0|false|no)$/i.test(process.env.WEBSITE_AUTO_MERGE || "");
const MERGE_METHOD = (() => {
  const m = (process.env.WEBSITE_MERGE_METHOD || "squash").trim().toLowerCase();
  return ["squash", "merge", "rebase"].includes(m) ? m : "squash";
})();

function requireEnv() {
  const missing = [];
  if (!APP_URL) missing.push("APP_URL");
  if (!RUNNER_TOKEN) missing.push("WEBSITE_RUNNER_TOKEN");
  if (!REPO) missing.push("WEBSITE_REPO_PATH");
  if (!API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    console.error(`[website-studio-runner] Missing required env: ${missing.join(", ")}.`);
    console.error("Set APP_URL, WEBSITE_RUNNER_TOKEN, WEBSITE_REPO_PATH, ANTHROPIC_API_KEY (see README).");
    process.exit(1);
  }
  if (!existsSync(REPO)) {
    console.error(`[website-studio-runner] WEBSITE_REPO_PATH does not exist: ${REPO}`);
    process.exit(1);
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────────
const log = (...a) => console.log(`[website-studio-runner] ${new Date().toISOString()}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

// gh CLI pinned to the configured target repo (so the PR + merge never act on the wrong repo). `capture`
// returns stdout; otherwise stderr/stdout inherit. Throws on non-zero exit (caller decides fallback).
function gh(args, { capture = true } = {}) {
  const full = [...args, "--repo", REPO_SLUG];
  return execFileSync("gh", full, {
    cwd: REPO,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

// The deploy target / PR base. Explicit WEBSITE_DEPLOY_BRANCH wins; otherwise fall back to the checkout's
// default (origin/HEAD → main/master). For the Zoe website repo this resolves to `master`, the Kinsta deploy
// branch.
function resolveDeployBranch() {
  if (DEPLOY_BRANCH) return DEPLOY_BRANCH;
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"]); // refs/remotes/origin/master
    return ref.split("/").pop();
  } catch {
    for (const b of ["master", "main"]) {
      try { git(["rev-parse", "--verify", `origin/${b}`]); return b; } catch { /* try next */ }
    }
    return "master";
  }
}

// Sanity check at startup: the local checkout's `origin` should be the SAME repo we open/merge PRs against
// (git push uses origin, gh uses --repo REPO_SLUG — if they disagree the PR won't find the pushed branch).
// Warn loudly rather than hard-fail, since a valid remote may be an SSH/https variant of the same slug.
function verifyOriginMatchesSlug() {
  let url = "";
  try { url = git(["remote", "get-url", "origin"]); } catch { /* no origin */ }
  const norm = (url || "").replace(/\.git$/, "").toLowerCase();
  if (!norm) {
    log(`WARNING: the checkout at ${REPO} has no 'origin' remote; expected it to be ${REPO_SLUG}.`);
    return;
  }
  if (!norm.includes(REPO_SLUG.toLowerCase())) {
    log(`WARNING: origin (${url}) does not look like WEBSITE_REPO_SLUG (${REPO_SLUG}). The PR + merge target`);
    log(`         ${REPO_SLUG} while 'git push' targets origin — make them the SAME repo or the PR will fail.`);
  }
}

async function appFetch(path, init = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    ...init,
    headers: { "x-website-runner-token": RUNNER_TOKEN, ...(init.headers || {}) },
  });
  return res;
}

async function postUpdate(body) {
  const res = await appFetch("/api/website/runner/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) log(`update ${body.status} returned ${res.status}`);
}

async function markFailed(jobId, reason) {
  log(`job ${jobId} FAILED: ${reason}`);
  try { await postUpdate({ id: jobId, status: "failed", error: String(reason).slice(0, 500) }); } catch { /* best effort */ }
}

// ── Edit context (from the embedded browser) ─────────────────────────────────
// A job now carries contextUrl (the exact page the marketer was viewing when they submitted — the edit
// TARGET) and environment ('production' | 'local'). We derive the site-root-relative PATH from contextUrl and
// hand it to the agent so it edits the RIGHT page, rather than guessing from the prose. This URL→repo-page
// mapping is best-effort: we give the agent the path and tell it to map it to the matching template/content
// and to be explicit in its summary if it cannot — the agent (which can read the repo) does the actual match.
function pathFromContextUrl(contextUrl) {
  if (!contextUrl || typeof contextUrl !== "string") return null;
  try {
    const p = new URL(contextUrl).pathname || "/";
    return p; // e.g. "/", "/about", "/rentals/tents"
  } catch {
    // Not a full URL — accept a bare path too ("/about"); anything else is unmappable.
    const t = contextUrl.trim();
    return t.startsWith("/") ? t : null;
  }
}

// ── The Claude Agent SDK edit step ───────────────────────────────────────────
// Returns { summary, changedPaths } or throws. The agent edits files under cwd=REPO only. `context` carries
// the browser-captured edit target: { contextUrl, environment, pathHint } (pathHint may be null if the URL
// couldn't be mapped to a path).
async function runAgent(prompt, context = {}) {
  const { contextUrl, environment, pathHint } = context;
  // Tell the agent WHICH page to edit. If we have a path, it's the target; if not, be honest about it.
  const contextLines = pathHint
    ? [
        `The marketer was viewing this page when they made the request, and THIS is the page to change:`,
        `  URL: ${contextUrl}`,
        `  Site path: ${pathHint}   (environment: ${environment || "production"})`,
        `Find the repo file(s) that render THIS path (the WordPress template, page, or content for it) and edit`,
        `those. If you cannot confidently map this path to a source file, say so EXPLICITLY in your summary and`,
        `edit the closest match rather than guessing silently.`,
      ]
    : [
        contextUrl
          ? `The marketer's page URL was "${contextUrl}" but it could not be mapped to a site path — infer the target page from the request text, and note in your summary that the page context was unclear.`
          : `No page URL was captured with this request — infer the target page from the request text, and note that in your summary.`,
      ];

  const system = [
    "You are editing the source of a WordPress/DevKinsta website in the current working directory.",
    "Make ONLY the change the user describes. Keep edits minimal and focused.",
    ...contextLines,
    "You can read, search, and edit files ONLY. You have NO shell — you cannot run commands of any kind.",
    "A separate runner handles everything else: branching, commits, the local build/preview deploy, and the",
    "pull request. Do not attempt to run git, gh, npm, build, deploy, or any command, and do not commit.",
    "When you are done, end your final message with a line listing the site URL path(s) your change affects,",
    "exactly in this form (use site-root-relative paths, space-separated):",
    "CHANGED_PATHS: / /about",
    "If you cannot determine the paths, write: CHANGED_PATHS: /",
  ].join("\n");

  let finalText = "";
  const response = query({
    prompt,
    options: {
      cwd: REPO,
      model: MODEL,
      systemPrompt: system,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // SECURITY: file-ops ONLY — deliberately NO Bash. Under bypassPermissions there is no human approving
      // tool calls, and prompts come from non-engineers (and may include injected text in files the agent
      // reads), so a shell here would be arbitrary command execution on the office machine — whose env holds
      // ANTHROPIC_API_KEY + WEBSITE_RUNNER_TOKEN. The agent only needs to edit website source; the RUNNER
      // owns git, the local build/preview deploy, and PRs. If a theme build step (npm/gulp) is ever needed
      // for the preview, run it as a FIXED command in deployToDevKinsta — never by giving the agent Bash.
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
      // Do NOT load the website repo's own CLAUDE.md/settings — keep the run hermetic (settingSources
      // defaults to none when omitted).
    },
  });

  for await (const msg of response) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`agent did not finish cleanly (${msg.subtype})`);
      finalText = typeof msg.result === "string" ? msg.result : "";
    }
  }

  // Parse the CHANGED_PATHS line out of the final text; the rest is the human-readable summary. If the agent
  // emitted none, fall back to the browser-captured path (the page the marketer was on) when we have it.
  let changedPaths = pathHint ? [pathHint] : ["/"];
  const m = /CHANGED_PATHS:\s*(.+)\s*$/m.exec(finalText);
  if (m) {
    const paths = m[1].split(/\s+/).map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
    if (paths.length) changedPaths = [...new Set(paths)];
  }
  const summary = finalText.replace(/CHANGED_PATHS:.*$/m, "").trim() || "The agent reported no summary.";
  return { summary, changedPaths };
}

// ── Local DevKinsta preview deploy (LOCAL ONLY) ──────────────────────────────
// Applies the current working tree to the local DevKinsta WP site. Prefers the repo's sync.ps1 (the
// website redesign's docker-cp deploy). Falls back to docker cp of the changed files. Never touches the
// live site. `changedFiles` is the list to copy for the docker-cp fallback.
function deployToDevKinsta(changedFiles) {
  // TODO(phase-2): if the theme ever needs a build step before preview (e.g. `npm run build` / gulp), run it
  // HERE as a fixed, hardcoded command — never by giving the agent Bash. Keep it a known command this runner
  // controls, not something a marketing prompt can influence.
  const syncPs1 = join(REPO, "sync.ps1");
  if (existsSync(syncPs1)) {
    log("deploying to DevKinsta via sync.ps1");
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", syncPs1], {
      cwd: REPO, stdio: "inherit",
    });
    return;
  }
  if (DEVKINSTA_CONTAINER) {
    log(`deploying to DevKinsta via docker cp into ${DEVKINSTA_CONTAINER}:${DEVKINSTA_WP_PATH}`);
    for (const f of changedFiles) {
      const src = join(REPO, f);
      if (!existsSync(src)) continue;
      const dest = `${DEVKINSTA_CONTAINER}:${DEVKINSTA_WP_PATH}/${f.replace(/\\/g, "/")}`;
      execFileSync("docker", ["cp", src, dest], { stdio: "inherit" });
    }
    return;
  }
  log("WARNING: no sync.ps1 and no DEVKINSTA_CONTAINER — skipping preview deploy. Screenshots will capture the site as it currently stands. Configure one for a true preview (see README).");
}

// ── Screenshots ──────────────────────────────────────────────────────────────
const VIEWPORTS = [
  { vp: "desktop", width: 1280, height: 900 },
  { vp: "mobile", width: 390, height: 844 },
];

function slugForPath(p) {
  const s = p.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  return s || "home";
}

async function captureAndUpload(jobId, changedPaths) {
  if (!PREVIEW_URL) {
    log("WARNING: WEBSITE_PREVIEW_URL is not set — cannot screenshot. The preview will have no images.");
    return;
  }
  const browser = await chromium.launch();
  try {
    for (const path of changedPaths) {
      for (const { vp, width, height } of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await page.goto(`${PREVIEW_URL}${path}`, { waitUntil: "networkidle", timeout: 30000 });
          const buf = await page.screenshot({ fullPage: true });
          const label = `${slugForPath(path)}-${vp}`;
          await uploadArtifact(jobId, label, buf);
          log(`uploaded screenshot ${label}`);
        } catch (e) {
          log(`screenshot failed for ${path} (${vp}): ${e.message}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

async function uploadArtifact(jobId, label, buf) {
  const form = new FormData();
  form.set("jobId", jobId);
  form.set("label", label);
  form.set("file", new Blob([buf], { type: "image/png" }), `${label}.png`);
  const res = await appFetch("/api/website/runner/artifact", { method: "POST", body: form });
  if (!res.ok) log(`artifact upload ${label} returned ${res.status}`);
}

// ── Wait for the human decision ──────────────────────────────────────────────
async function waitForDecision(jobId) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      const res = await appFetch(`/api/website/runner/job?id=${encodeURIComponent(jobId)}`);
      if (!res.ok) continue;
      const { job } = await res.json();
      if (!job) continue;
      if (job.status === "approved" || job.status === "discarded") return job.status;
    } catch {
      /* transient — keep polling */
    }
  }
  return "timeout";
}

// ── Merge the approved PR into the deploy branch (triggers the Kinsta deploy) ─
// Returns a short human-readable note describing what happened (recorded on the job). Never throws — a merge
// that can't be completed now (e.g. checks still pending with branch protection) leaves the PR open with
// auto-merge armed, which is the desired outcome, not a failure.
function mergeToDeployBranch(branch, base) {
  const method = `--${MERGE_METHOD}`;
  if (AUTO_MERGE) {
    try {
      // GitHub native auto-merge: the PR merges itself into `base` once required checks pass. Needs the repo
      // to allow auto-merge (and typically a required status check); gh errors otherwise → fall back below.
      gh(["pr", "merge", branch, "--auto", method], { capture: false });
      log(`job: auto-merge enabled on ${branch} → ${base} (will merge + deploy when checks pass)`);
      return `Auto-merge enabled: this merges into \`${base}\` and deploys to the live site once required checks pass.`;
    } catch (e) {
      log(`auto-merge could not be enabled (${(e.message || "").split("\n")[0]}) — trying an immediate merge`);
    }
  }
  try {
    // Immediate merge (repo has no auto-merge / no required checks, or WEBSITE_AUTO_MERGE=0). This merges to
    // the deploy branch now, which triggers the Kinsta deploy.
    gh(["pr", "merge", branch, method], { capture: false });
    log(`job: merged ${branch} → ${base} immediately (deploy triggered)`);
    return `Merged into \`${base}\` — the live-site (Kinsta) deploy is triggered.`;
  } catch (e) {
    const first = (e.message || "").split("\n")[0];
    log(`merge did not complete (${first}) — PR left open for a human to merge`);
    return `PR opened into \`${base}\` but the automatic merge did not complete (${first}). Merge it manually to deploy.`;
  }
}

// ── Process one claimed job end to end ───────────────────────────────────────
async function processJob(job) {
  const branch = `${WORKING_BRANCH_PREFIX}${job.id}`;
  const base = resolveDeployBranch();
  // Edit context captured from the embedded browser: which page + environment the request targets.
  const pathHint = pathFromContextUrl(job.contextUrl);
  const environment = job.environment || "production";
  log(`job ${job.id}: "${job.prompt.slice(0, 80)}" — base=${base}, branch=${branch}, target=${pathHint || "(none)"} env=${environment}`);

  // 2. fresh branch off the remote default
  git(["fetch", "origin", base]);
  git(["checkout", "-B", branch, `origin/${base}`]);

  // 3. agent edit — pass the browser-captured target so it edits the right page
  const { summary, changedPaths } = await runAgent(job.prompt, { contextUrl: job.contextUrl, environment, pathHint });

  // 4. commit on the branch (guardrail: never the default branch)
  git(["add", "-A"]);
  const status = git(["status", "--porcelain"]);
  if (!status) {
    await markFailed(job.id, "the agent produced no file changes");
    try { git(["checkout", base]); } catch { /* best effort */ }
    return;
  }
  const changedFiles = git(["diff", "--name-only", "--cached"]).split("\n").map((s) => s.trim()).filter(Boolean);
  git(["commit", "-m", `Website Studio: ${job.prompt.slice(0, 72)}`, "-m", `Job ${job.id}\n\n${summary}`]);

  // 5. local DevKinsta preview deploy (LOCAL ONLY)
  try { deployToDevKinsta(changedFiles); } catch (e) { log(`preview deploy failed (continuing to screenshot): ${e.message}`); }

  // 6. screenshots → artifacts, then flip to preview
  await captureAndUpload(job.id, changedPaths);
  await postUpdate({ id: job.id, status: "preview", summary, changedFiles, pagePaths: changedPaths });
  log(`job ${job.id}: preview ready — awaiting human decision`);

  // 7. wait for the decision
  const decision = await waitForDecision(job.id);
  if (decision === "approved") {
    log(`job ${job.id}: approved — pushing ${branch} + opening PR into ${base} on ${REPO_SLUG}`);
    git(["push", "-u", "origin", branch]);
    let prUrl = "";
    try {
      prUrl = gh([
        "pr", "create",
        "--base", base,
        "--head", branch,
        "--title", `Website Studio: ${job.prompt.slice(0, 72)}`,
        "--body", `Requested in Website Studio (job ${job.id}).\n\n${summary}\n\nApproved from the rendered preview in the app. Merging this into \`${base}\` deploys the change to the live site (Kinsta).`,
      ]).trim();
    } catch (e) {
      await markFailed(job.id, `gh pr create failed: ${e.message}`);
      return;
    }

    // Auto-merge into the deploy branch. The human already approved the rendered preview in the app, so the
    // approval IS the go-live decision. Prefer GitHub NATIVE auto-merge (merge when required checks pass) so
    // the repo's branch protection / CI still gates the actual deploy; fall back to an immediate merge only
    // when the repo has no auto-merge or required checks configured (gh errors in that case).
    const mergeNote = mergeToDeployBranch(branch, base);

    await postUpdate({ id: job.id, status: "done", summary: `${summary}\n\n${mergeNote}`.trim(), prUrl });
    // leave the branch (GitHub removes it on merge per repo settings); return the local site to a clean
    // deploy branch so the next job starts fresh.
    git(["checkout", base]);
    try { deployToDevKinsta([]); } catch { /* best effort */ }
    log(`job ${job.id}: DONE — ${prUrl} (${mergeNote})`);
  } else if (decision === "discarded") {
    log(`job ${job.id}: discarded — cleaning up`);
    git(["checkout", base]);
    try { git(["branch", "-D", branch]); } catch { /* may not exist */ }
    git(["reset", "--hard", `origin/${base}`]);
    try { deployToDevKinsta([]); } catch { /* best effort restore */ }
    log(`job ${job.id}: discarded + local site restored`);
    // status is already `discarded` in the app (set by the human decision)
  } else {
    // timeout — leave the job in preview; restore local checkout so we don't block, and let a human re-decide
    log(`job ${job.id}: decision timed out — leaving in preview, restoring local checkout`);
    git(["checkout", base]);
  }
}

// ── Main loop (single-flight) ────────────────────────────────────────────────
async function main() {
  requireEnv();
  verifyOriginMatchesSlug();
  log(`started. app=${APP_URL} repo=${REPO} targetRepo=${REPO_SLUG} deployBranch=${DEPLOY_BRANCH || "(auto)"} branchPrefix=${WORKING_BRANCH_PREFIX} autoMerge=${AUTO_MERGE} mergeMethod=${MERGE_METHOD} model=${MODEL} poll=${POLL_MS}ms`);
  for (;;) {
    let job = null;
    try {
      const res = await appFetch("/api/website/runner/next");
      if (res.status === 503) {
        log("runner endpoints disabled on the app (WEBSITE_RUNNER_TOKEN unset there?) — retrying");
      } else if (res.status === 401) {
        log("unauthorized — WEBSITE_RUNNER_TOKEN mismatch between runner and app");
      } else if (res.ok) {
        ({ job } = await res.json());
      } else {
        log(`next returned ${res.status}`);
      }
    } catch (e) {
      log(`could not reach the app: ${e.message}`);
    }

    if (job) {
      try {
        await processJob(job);
      } catch (e) {
        // One job failing must never crash the loop.
        await markFailed(job.id, e && e.message ? e.message : e);
        try { git(["checkout", resolveDeployBranch()]); } catch { /* best effort */ }
      }
    } else {
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => {
  console.error("[website-studio-runner] fatal:", e);
  process.exit(1);
});
