// Zoe Visual DNA — the centralized house look every image inherits, plus the model-agnostic image-provider
// selection. Owner/admin only (it defines the brand's photography). Server loads the live DNA + a masked
// provider status and renders the editor.

import { redirect } from "next/navigation";
import Link from "next/link";
import { Dna } from "lucide-react";
import { getVisualDNA } from "@/lib/creative/visualDna";
import { providerStatuses } from "@/lib/creative/providers";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { VisualDnaEditor } from "@/components/creative/VisualDnaEditor";

export const dynamic = "force-dynamic";

export default async function VisualDnaPage(): Promise<React.JSX.Element> {
  if (!canManageSettings(await viewerRole())) redirect("/creative");
  const dna = getVisualDNA();
  const providers = providerStatuses();

  return (
    <main className="max-w-[960px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative Engine</Link> / Visual DNA
      </div>
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Dna className="size-5 text-meta" /> Zoe Visual DNA
        </h1>
        <p className="mt-1 text-[12.5px] text-meta">
          The single, reusable definition of the Zoe look. The Art Director composes every brief from this, so all images feel like the same photography team. Never re-typed into individual prompts.
        </p>
      </header>
      <VisualDnaEditor initialDna={dna} initialProviders={providers} />
    </main>
  );
}
