// Website Studio — office-machine runner (Phase 1).
//
// WHAT IT DOES, one job at a time (single-flight — the local DevKinsta site reflects the current job):
//   1. Claim the next queued job from the app         (GET  <APP_URL>/api/website/runner/next)
//   2. In WEBSITE_REPO_PATH, fetch + hard-reset the default branch, then cut website-studio/<jobId>
//   3. Run the Claude Agent SDK (centralized ANTHROPIC_API_KEY) with the marketer's prompt to edit the repo
//   4. Commit the change on the branch (NEVER on the default branch)
//   5. Apply the branch's working tree to the LOCAL DevKinsta WordPress site (sync.ps1 if present, else
//      docker cp) — LOCAL PREVIEW ONLY, never the live site
//   6. Screenshot the changed page(s) at desktop (1280w) + mobile (390w) with Playwright, upload them +
//      the summary + the changed-file list, and set the job to `preview`  (POST .../runner/artifact, .../runner/update)
//   7. WAIT for the human decision (poll GET .../runner/job?id=<jobId>):
//        approved  → push the branch + `gh pr create` (base = default branch) → set `done` with the PR url
//        discarded → delete the local branch, restore the local site to a clean default branch → (already `discarded`)
//
// GUARDRAILS (this edits real website code driven by non-engineers):
//   • The agent's working directory is confined to WEBSITE_REPO_PATH (cwd). It may read/edit files and run
//     repo-local build/lint, but is instructed NOT to run git/gh/push/deploy or anything outside the repo —
//     the RUNNER owns all git + PR operations.
//   • The runner NEVER merges a PR, NEVER pushes to the default branch, and NEVER deploys. PR-only.
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

function defaultBranch() {
  // origin/HEAD points at the remote default branch; fall back to main/master.
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"]); // refs/remotes/origin/main
    return ref.split("/").pop();
  } catch {
    for (const b of ["main", "master"]) {
      try { git(["rev-parse", "--verify", `origin/${b}`]); return b; } catch { /* try next */ }
    }
    return "main";
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

// ── The Claude Agent SDK edit step ───────────────────────────────────────────
// Returns { summary, changedPaths } or throws. The agent edits files under cwd=REPO only.
async function runAgent(prompt) {
  const system = [
    "You are editing the source of a WordPress/DevKinsta website in the current working directory.",
    "Make ONLY the change the user describes. Keep edits minimal and focused.",
    "You MAY read and edit files and run repo-local build/lint commands.",
    "You MUST NOT run git, gh, push, deploy, or any command that reaches outside this repository — a separate",
    "runner handles commits, branching, and the pull request. Do not commit.",
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
      // Give it the editing + local-inspection toolset; no network/web tools.
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
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

  // Parse the CHANGED_PATHS line out of the final text; the rest is the human-readable summary.
  let changedPaths = ["/"];
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

// ── Process one claimed job end to end ───────────────────────────────────────
async function processJob(job) {
  const branch = `website-studio/${job.id}`;
  const base = defaultBranch();
  log(`job ${job.id}: "${job.prompt.slice(0, 80)}" — base=${base}, branch=${branch}`);

  // 2. fresh branch off the remote default
  git(["fetch", "origin", base]);
  git(["checkout", "-B", branch, `origin/${base}`]);

  // 3. agent edit
  const { summary, changedPaths } = await runAgent(job.prompt);

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
    log(`job ${job.id}: approved — pushing + opening PR`);
    git(["push", "-u", "origin", branch]);
    let prUrl = "";
    try {
      prUrl = execFileSync(
        "gh",
        ["pr", "create", "--base", base, "--head", branch, "--title", `Website Studio: ${job.prompt.slice(0, 72)}`, "--body", `Requested in Website Studio (job ${job.id}).\n\n${summary}\n\nReview the rendered preview in the app before merging. Nothing is live until this PR is merged.`],
        { cwd: REPO, encoding: "utf8" },
      ).trim();
    } catch (e) {
      await markFailed(job.id, `gh pr create failed: ${e.message}`);
      return;
    }
    await postUpdate({ id: job.id, status: "done", summary, prUrl });
    // leave the branch; return the local site to a clean default so the next job starts fresh
    git(["checkout", base]);
    try { deployToDevKinsta([]); } catch { /* best effort */ }
    log(`job ${job.id}: DONE — ${prUrl}`);
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
  log(`started. app=${APP_URL} repo=${REPO} model=${MODEL} poll=${POLL_MS}ms`);
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
        try { git(["checkout", defaultBranch()]); } catch { /* best effort */ }
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
