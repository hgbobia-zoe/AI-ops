// Shared 404 for every console route — rendered when a blade URL doesn't resolve. Built entirely
// from the shared design-system primitives (BladeMain + PageHeader + EmptyState + Button), so it is
// also the smallest proof that the tokens/primitives render correctly in the real app shell.

import Link from "next/link";
import { Compass, LayoutDashboard } from "lucide-react";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

export default function ConsoleNotFound(): React.JSX.Element {
  return (
    <BladeMain>
      <PageHeader icon={<Compass className="size-5" />} title="Page not found" />
      <EmptyState
        icon={<Compass className="size-5" />}
        title="This page doesn't exist"
        body="The link may be out of date or the blade may have moved. Head back to the dashboard to pick up where you left off."
        action={
          <Button render={<Link href="/dashboard" />}>
            <LayoutDashboard className="size-4" /> Back to dashboard
          </Button>
        }
      />
    </BladeMain>
  );
}
