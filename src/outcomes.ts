/**
 * The distinct connection outcomes. The codes, the wording and the NDJSON notice frame
 * are the wire contract owned by `@kosmo-callflow/protocol` (connect frames, task 1.9);
 * kosmo-tui re-exports them so the viewer and the stream reader cannot drift from the
 * producer. "daemon unavailable", "auth rejected", "SDK not attached", "no events yet"
 * and "disconnected" read differently because each needs a different action.
 */

export {
  connectOutcomeCodeValues,
  connectOutcomeMessage,
  noticeFrame,
  type ConnectNoticeFrame,
  type ConnectOutcomeCode
} from "@kosmo-callflow/protocol";
