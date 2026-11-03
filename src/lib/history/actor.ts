// Who to record on a History change made from a request. The signed-in person's name, or null when nobody is
// signed in (login off, or an anonymous call), so History says "someone" instead of a made-up name.

import { currentActor } from "@/lib/auth/getSession";

export async function historyActor(): Promise<string | null> {
  try {
    const a = await currentActor();
    return a.id === "anon" ? null : a.label;
  } catch {
    return null;
  }
}
