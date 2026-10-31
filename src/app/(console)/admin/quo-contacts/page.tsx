// Quo contact cleanup — counts the Quo address book and merges duplicate contacts (mostly left behind by
// old Zaps that created a new contact on every run). Owner/admin only (under /admin, gated by the proxy).
// The list loads client-side because paging a large address book takes a while.

import { Contact } from "lucide-react";
import { QuoContactCleanup } from "@/components/QuoContactCleanup";

export const dynamic = "force-dynamic";

export default function QuoContactsPage(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Contact className="size-7" /> Quo Contacts
        </h1>
        <p className="text-sm text-muted-foreground">
          Every contact in Quo, with the duplicates grouped. Merging keeps the most complete contact, copies every
          phone number and email onto it, then removes the extra copies. Call and text history is not affected.
        </p>
      </header>
      <QuoContactCleanup />
    </main>
  );
}
