// Public invite-acceptance page (/join?token=…). Validates the token server-side and either shows the
// account-setup form or a clear reason it can't be used. No auth required — this is how a teammate
// self-onboards from a link.

import { AlertTriangle } from "lucide-react";
import { JoinForm } from "@/components/JoinForm";
import { inviteState } from "@/lib/auth/invites";
import { ROLE_LABEL } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const REASON: Record<string, string> = {
  not_found: "This invite link isn't valid. Ask whoever invited you for a fresh link.",
  expired: "This invite has expired. Ask for a new one — they only last a few days.",
  used: "This invite has already been used. If that wasn't you, ask for a new link.",
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const token = typeof sp?.token === "string" ? sp.token : "";
  const { state, invite } = token ? inviteState(token) : { state: "not_found" as const, invite: null };

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Zoe Ops</div>
          <div className="text-sm text-muted-foreground">
            {state === "valid" ? "You've been invited to the team" : "AI Operations Platform"}
          </div>
        </div>

        {state === "valid" && invite ? (
          <JoinForm token={token} presetName={invite.name ?? ""} role={ROLE_LABEL[invite.role]} />
        ) : (
          <div className="surface flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-5 text-sm text-amber-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{REASON[state] ?? REASON.not_found}</span>
          </div>
        )}
      </div>
    </main>
  );
}
