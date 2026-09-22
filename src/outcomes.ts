/**
 * The distinct connection outcomes (ported from kosmo-callflow
 * `packages/cli/src/connect/outcomes.ts`).
 *
 * "daemon unavailable", "auth rejected", "SDK not attached", "no events yet" and
 * "disconnected" read differently because each needs a different action: start the
 * daemon, fix the token, attach the SDK, exercise the app, or reconnect. The wording
 * lives here once so the viewer and any machine-readable notice cannot drift.
 */

export type ConnectOutcomeCode = "daemon-unavailable" | "auth-rejected" | "sdk-absent" | "no-events" | "disconnected";

const messages: Record<ConnectOutcomeCode, string> = {
  "daemon-unavailable":
    "connect could not reach the daemon. Start it with `kosmo-callflow daemon --data .kosmo-callflow`, or pass --endpoint <url>.",
  "auth-rejected":
    "connect was refused by the daemon: authentication failed. Check the project token file, or pass --token-file <path>.",
  "sdk-absent":
    "connected to the daemon, but no SDK is attached to the application. Start the instrumented app; connect never starts instrumentation itself.",
  "no-events":
    "connected, SDK attached, but nothing has been recorded yet. Exercise the application; connect never changes capture or recording policy.",
  disconnected: "connect lost the daemon connection while streaming."
};

export function connectOutcomeMessage(code: ConnectOutcomeCode, detail?: string): string {
  const base = messages[code];
  return detail === undefined || detail.length === 0 ? base : `${base} (${detail})`;
}

/**
 * The NDJSON counterpart of an outcome.
 *
 * Wire-contract type defined locally for now: kosmo-callflow declares it in its CLI
 * package, which kosmo-tui must not import. It should move to
 * `@kosmo-callflow/protocol` with the versioned connect frames (task 1.9).
 */
export type ConnectNoticeFrame = {
  type: "notice";
  code: ConnectOutcomeCode;
  message: string;
};

export function noticeFrame(code: ConnectOutcomeCode, detail?: string): ConnectNoticeFrame {
  return { type: "notice", code, message: connectOutcomeMessage(code, detail) };
}
