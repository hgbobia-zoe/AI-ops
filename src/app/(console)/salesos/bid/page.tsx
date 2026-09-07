// Competitive Bid Review — is this quote priced to win? Grounded in Zoe's own comparable won/lost
// history (real DMV-market behavior), never invented industry numbers. Financial tool → Owner/Admin.

import Link from "next/link";
import { ArrowLeft, Scale } from "lucide-react";
import { BidReviewTool } from "@/components/BidReviewTool";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function BidReviewPage(): Promise<React.JSX.Element> {
  const allowed = canSeeFinancials(await viewerRole());

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <Link href="/salesos" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Sales OS
      </Link>

      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Scale className="size-7" /> Bid Review
        </h1>
        <p className="text-sm text-muted-foreground">
          Is this quote priced to win? Checked against how your comparable-sized quotes have actually closed in the DMV.
        </p>
      </header>

      {allowed ? (
        <BidReviewTool />
      ) : (
        <div className="surface border border-white/10 p-8 text-center text-sm text-muted-foreground">
          Bid Review uses revenue data — visible to Owner and Admin roles.
        </div>
      )}
    </main>
  );
}
