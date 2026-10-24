// Website Studio (Phase 1) — the marketing team describes a website change in plain English and gets back a
// PR. This page is a thin server shell; the worklist + prompt box live in the client component, which polls
// /api/website/jobs. The blade is role-gated in the proxy (canUseWebsiteStudio); the actual edit happens on
// the office machine (tools/website-studio-runner) and nothing goes live until a human merges the PR.

import { WebsiteStudio } from "@/components/website/WebsiteStudio";
import { currentActor } from "@/lib/auth/getSession";
import { listJobs } from "@/lib/website/jobs";
import { websiteEnvUrls } from "@/lib/website/config";

export const dynamic = "force-dynamic";

export default async function WebsiteStudioPage(): Promise<React.JSX.Element> {
  const actor = await currentActor();
  const initialJobs = listJobs({ requester: actor.label });
  // The two environments the embedded browser can load (env-overridable, see lib/website/config). Resolved on
  // the server and handed to the client blade so there's no hardcoded origin in the component.
  const envUrls = websiteEnvUrls();
  return <WebsiteStudio initialJobs={initialJobs} envUrls={envUrls} />;
}
