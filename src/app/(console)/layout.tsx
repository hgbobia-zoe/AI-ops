// The back-office console shell: a persistent left-nav of blades beside the active
// feature. Wraps Dashboard / Dispatch / Event Risk / Settings. The tablet (/kiosk,
// /route, /select) and customer (/track) pages live outside this group — no shell.

import { ConsoleNav } from "@/components/ConsoleNav";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <ConsoleNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
