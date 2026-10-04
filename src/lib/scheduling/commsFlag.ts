// The master switch for WORKER-FACING shift comms. Mirrors SMS_SEND_ENABLED / EMAIL_SEND_ENABLED: the
// packet + comms + send path are built, but NOTHING texts a worker until this is explicitly "true".
// Default OFF → preview / record-only. Honest: a comms step is never marked sent/delivered/confirmed
// unless the underlying API actually reports it (and until this is on, no send is even attempted).

export function shiftCommsEnabled(): boolean {
  return process.env.SHIFT_COMMS_ENABLED === "true";
}
