// Public privacy policy for the "Zoe Auto-Pull + Opportunity Radar" Chrome extension. The Chrome Web
// Store requires a publicly reachable privacy-policy URL for an extension that reads data. This page is
// listed in proxy.ts PUBLIC so it renders without a session. Keep it in sync with the policy text in
// extension/STORE_SUBMISSION.md.

export const metadata = {
  title: "Zoe Auto-Pull — Privacy Policy",
  description: "How the Zoe Auto-Pull + Opportunity Radar browser extension handles data.",
};

export default function PrivacyPolicyPage(): React.JSX.Element {
  const updated = "October 8, 2026";
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px", lineHeight: 1.6, fontFamily: "system-ui, -apple-system, sans-serif", color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, marginBottom: 4 }}>Zoe Auto-Pull — Privacy Policy</h1>
      <p style={{ color: "#666", fontSize: 14, marginTop: 0 }}>Last updated: {updated}</p>

      <p>
        Zoe Auto-Pull (the “Zoe Auto-Pull + Opportunity Radar” browser extension) runs in the browser of an
        authorized operator at a rental company that uses Zoe Ops. Using the operator’s own signed-in
        sessions, it reads that company’s operational data from Goodshuffle (routes, bookings) and Instawork
        (temp-labor shifts) and transmits it only to that company’s own Zoe Ops instance to keep its
        dispatch, scheduling, risk and finance views current.
      </p>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 28 }}>What the extension accesses</h2>
      <ul>
        <li>The company’s own routes and bookings on <strong>pro.goodshuffle.com</strong>.</li>
        <li>The company’s own temp-labor shifts on <strong>app.instawork.com</strong>.</li>
        <li>
          Using the operator’s own signed-in Zonar Ignition session, it creates Zonar’s own live-tracking
          ETA links on <strong>ignition.zonarsystems.com</strong> for the company’s deliveries, reading that
          session’s auth token from that page only.
        </li>
      </ul>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 28 }}>Where the data goes</h2>
      <p>
        The data it reads is sent only to the company’s own Zoe Ops instance (for example,
        <code> zoe-dispatch.fly.dev</code>) to keep that company’s operational views current. It is not sent
        anywhere else.
      </p>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 28 }}>What it does not do</h2>
      <ul>
        <li>It does not collect your personal browsing history.</li>
        <li>It does not track individuals.</li>
        <li>It does not sell or share any data with third parties.</li>
      </ul>

      <p style={{ marginTop: 28 }}>
        Data handling within Zoe Ops is governed by Zoe Ops’ own agreement with the company. Questions:{" "}
        <a href="mailto:hello@zoeeventsdmv.com">hello@zoeeventsdmv.com</a>.
      </p>
    </main>
  );
}
