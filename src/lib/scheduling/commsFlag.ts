// The master switch for WORKER-FACING shift comms. Mirrors SMS_SEND_ENABLED / EMAIL_SEND_ENABLED: the
// packet + comms + send path are built, but NOTHING texts a worker until this is explicitly "true".
// Default OFF → preview / record-only. Honest: a comms step is never marked sent/delivered/confirmed
// unless the underlying API actually reports it (and until this is on, no send is even attempted).

export function shiftCommsEnabled(): boolean {
  return process.env.SHIFT_COMMS_ENABLED === "true";
}

// The SEPARATE master switch for the UNATTENDED worker-packet AUTO-TRIGGER (the runtime job that fires
// due/unsent debrief touches on its own). Deliberately its OWN flag, DEFAULT OFF, on top of
// SHIFT_COMMS_ENABLED. Rationale: SHIFT_COMMS_ENABLED is already ON in prod to allow the human "Send
// packet" button; turning the automatic fan-out on is a SEPARATE, deliberate decision — so an auto-send
// requires BOTH flags. With AUTO_PACKET_ENABLED off (the default) the job is a healthy no-op: it builds
// and sends nothing. The owner flips it on when they want workers auto-debriefed.
export function autoPacketEnabled(): boolean {
  return process.env.AUTO_PACKET_ENABLED === "true";
}

// The global SMS master switch (same env the sales/passes send paths honor). The auto-trigger respects it
// too, so turning ALL outbound SMS off also silences auto-debriefs even if AUTO_PACKET_ENABLED is on.
export function smsSendEnabled(): boolean {
  return process.env.SMS_SEND_ENABLED === "true";
}
