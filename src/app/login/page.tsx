// Login page for the site-wide password gate. Minimal, on-brand. Posts to /api/auth/login which
// sets the session cookie, then returns to wherever the user was headed.

import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const next = typeof sp?.next === "string" && sp.next.startsWith("/") ? sp.next : "/";
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Zoe Ops</div>
          <div className="text-sm text-muted-foreground">AI Operations Platform</div>
        </div>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
