import { flagOn } from "@/lib/flags";
// The switch for WORKER-FACING shift comms. ON by default like every shipped feature (src/lib/flags.ts);
// set SHIFT_COMMS_ENABLED=false to stop it. Honest: a comms step is never marked sent/delivered/confirmed
// unless the underlying API actually reports it.

export function shiftCommsEnabled(): boolean {
  return flagOn("SHIFT_COMMS_ENABLED");
}

// The SEPARATE master switch for the UNATTENDED worker-packet AUTO-TRIGGER (the runtime job that fires
// due/unsent debrief touches on its own). Its own switch on top of SHIFT_COMMS_ENABLED, so an auto-send
// needs both. ON by default (live in prod); set AUTO_PACKET_ENABLED=false to stop auto-debriefs while
// keeping the human "Send packet" button.
export function autoPacketEnabled(): boolean {
  return flagOn("AUTO_PACKET_ENABLED");
}

// The global SMS master switch (same env the sales/passes send paths honor). The auto-trigger respects it
// too, so turning ALL outbound SMS off also silences auto-debriefs even if AUTO_PACKET_ENABLED is on.
export function smsSendEnabled(): boolean {
  return flagOn("SMS_SEND_ENABLED");
}

// The AI CUSTOMER-ATTENTION heads-up on the debrief. DEFAULT ON (the owner wants it): the only way to
// disable it is to set CUSTOMER_ATTENTION_ENABLED="false" explicitly. It degrades silently to no line when
// the LLM is unavailable (customerAttentionNote returns undefined), and it is attempted ONLY on the debrief
// send path (gated by the same switches), so it adds no always-on cost. Never blocks a debrief.
export function customerAttentionEnabled(): boolean {
  return process.env.CUSTOMER_ATTENTION_ENABLED !== "false";
}
