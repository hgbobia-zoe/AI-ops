// Public SOP read + sign page (/ack/<token>). No login: the token is the credential. Shows the role SOP
// and a sign form; once signed it shows the record instead.

import { ackView } from "@/lib/people/sopAck";
import { SopSignForm } from "@/components/people/SopSignForm";

export const dynamic = "force-dynamic";

export default async function AckPage({ params }: { params: Promise<{ token: string }> }): Promise<React.JSX.Element> {
  const { token } = await params;
  const view = ackView(token);

  if (view.state === "invalid") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="surface max-w-sm rounded-2xl p-5 text-sm">This link is not valid. Ask your manager for a new one.</div>
      </main>
    );
  }

  const sop = view.sop;
  return (
    <main className="mx-auto max-w-2xl p-4 pb-16 sm:p-8">
      <div className="mb-1 text-sm text-muted-foreground">Zoe Event Rentals</div>
      <h1 className="text-xl font-semibold">{sop.title}</h1>
      <div className="mb-6 text-xs text-muted-foreground">Version {sop.version}</div>
      <p className="mb-6 text-sm">{sop.objective}</p>

      {sop.sections.map((s) => (
        <section key={s.heading} className="mb-6">
          <h2 className="mb-2 text-base font-semibold">{s.heading}</h2>
          {s.intro && <p className="mb-2 text-sm">{s.intro}</p>}
          <ul className="flex flex-col gap-2 text-sm">
            {(s.items ?? []).map((it, i) => (
              <li key={i}>
                {it.title && <span className="font-medium">{it.title}: </span>}
                {it.text}
                {it.sub && (
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {it.sub.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="surface rounded-2xl p-5">
        {view.state === "signed" ? (
          <p className="text-sm">
            Signed by <span className="font-medium">{view.name}</span> on {new Date(view.signedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}. Thank you!
          </p>
        ) : (
          <SopSignForm token={token} name={view.employeeName} statement={sop.signOff} />
        )}
      </div>
    </main>
  );
}
