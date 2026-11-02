// Feature switches that are ON by default. A shipped, working feature should not need an env var to be
// armed (owner, 2026-11-02: the welcome email sat dormant because WEB_INTAKE_ACK_EMAIL was never set).
// Each switch stays as a kill switch: set it to "false" (or 0 / off / no) to turn that feature off.
// Pure + client-safe.

const OFF = new Set(["false", "0", "off", "no"]);

/** On unless the env var is explicitly set to false / 0 / off / no. */
export function flagOn(name: string): boolean {
  return !OFF.has((process.env[name] ?? "").trim().toLowerCase());
}
