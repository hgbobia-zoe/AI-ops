// The app's PUBLIC origin (scheme + host) for building absolute links we hand to people. Behind Fly's
// proxy, req.url / nextUrl.origin reflect the INTERNAL listener (localhost:3000), so links built from
// them break. Prefer an explicit PUBLIC_BASE_URL, then the forwarded host headers Fly sets, then the
// request URL as a last resort (correct in local dev).

export function publicOrigin(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") || "https";
    return `${proto}://${host}`;
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}
