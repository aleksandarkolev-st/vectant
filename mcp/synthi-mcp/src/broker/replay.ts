import type { EventLog } from "../events/log.js";
import type { EventLogEntry } from "../events/types.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";

export interface BrokerReplayRequest {
  from_event_id: number;
  to_event_id?: number;
  limit?: number;
}

export interface BrokerReplayOk {
  ok: true;
  events: EventLogEntry[];
  next_event_id?: number;
  last_event_id: number;
}

export interface BrokerReplayError {
  ok: false;
  error: BrokerErrorPayload;
}

export const MAX_REPLAY_LIMIT = 500;

export function queryBrokerReplay(log: EventLog, request: BrokerReplayRequest): BrokerReplayOk | BrokerReplayError {
  if (!Number.isInteger(request.from_event_id) || request.from_event_id < 0) {
    return { ok: false, error: brokerError("CURSOR_TOO_OLD", { from_event_id: request.from_event_id }) };
  }
  const firstSeq = log.firstSeq();
  if (firstSeq !== null && request.from_event_id < firstSeq - 1) {
    return {
      ok: false,
      error: brokerError("CURSOR_TOO_OLD", {
        from_event_id: request.from_event_id,
        oldest_available_event_id: firstSeq,
      }),
    };
  }
  const boundedLimit = Math.max(1, Math.min(MAX_REPLAY_LIMIT, Math.floor(request.limit ?? MAX_REPLAY_LIMIT)));
  let events = log.query({ since_seq: request.from_event_id, limit: boundedLimit });
  if (request.to_event_id !== undefined) {
    events = events.filter((event) => event.seq <= request.to_event_id!);
  }
  const lastReturned = events[events.length - 1]?.seq ?? request.from_event_id;
  const response: BrokerReplayOk = {
    ok: true,
    events,
    last_event_id: log.lastSeq(),
  };
  if (lastReturned < log.lastSeq() && events.length === boundedLimit) {
    response.next_event_id = lastReturned;
  }
  return response;
}
