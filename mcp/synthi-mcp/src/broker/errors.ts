export const BROKER_ERROR_CODES = [
  "SESSION_DISCONNECTED",
  "UPSTREAM_NO_FRAMES",
  "BROKER_RECOVERING",
  "FRAME_STALE",
  "INPUT_ACK_TIMEOUT",
  "EFFECT_NOT_VERIFIED",
  "UNSUPPORTED_POSTCONDITION_TYPE",
  "LEASE_REQUIRED",
  "LEASE_DENIED",
  "LEASE_PREEMPTED",
  "LEASE_EXPIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CURSOR_TOO_OLD",
  "SUBSCRIPTION_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_PRODUCER_REJECTED",
  "SUBSCRIBER_LAGGING",
] as const;

export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

export type BrokerErrorCategory =
  | "session"
  | "input"
  | "lease"
  | "auth"
  | "replay"
  | "producer"
  | "subscriber";

export interface BrokerErrorPayload {
  error: BrokerErrorCode;
  error_code: BrokerErrorCode;
  category: BrokerErrorCategory;
  retryable: boolean;
  legacy_error?: string;
  detail?: Record<string, unknown>;
}

const BROKER_ERROR_SET = new Set<string>(BROKER_ERROR_CODES);

const CATEGORIES: Record<BrokerErrorCode, BrokerErrorCategory> = {
  SESSION_DISCONNECTED: "session",
  UPSTREAM_NO_FRAMES: "session",
  BROKER_RECOVERING: "session",
  FRAME_STALE: "input",
  INPUT_ACK_TIMEOUT: "input",
  EFFECT_NOT_VERIFIED: "input",
  UNSUPPORTED_POSTCONDITION_TYPE: "input",
  LEASE_REQUIRED: "lease",
  LEASE_DENIED: "lease",
  LEASE_PREEMPTED: "lease",
  LEASE_EXPIRED: "lease",
  UNAUTHORIZED: "auth",
  FORBIDDEN: "auth",
  CURSOR_TOO_OLD: "replay",
  SUBSCRIPTION_NOT_FOUND: "replay",
  IDEMPOTENCY_CONFLICT: "replay",
  DUPLICATE_PRODUCER_REJECTED: "producer",
  SUBSCRIBER_LAGGING: "subscriber",
};

const RETRYABLE = new Set<BrokerErrorCode>([
  "SESSION_DISCONNECTED",
  "UPSTREAM_NO_FRAMES",
  "BROKER_RECOVERING",
  "FRAME_STALE",
  "INPUT_ACK_TIMEOUT",
  "EFFECT_NOT_VERIFIED",
  "LEASE_PREEMPTED",
  "LEASE_EXPIRED",
  "CURSOR_TOO_OLD",
  "SUBSCRIBER_LAGGING",
]);

const LEGACY_TO_BROKER: Record<string, BrokerErrorCode> = {
  not_attached: "SESSION_DISCONNECTED",
  session_terminated: "SESSION_DISCONNECTED",
  no_frame_yet: "UPSTREAM_NO_FRAMES",
  screenshot_failed: "UPSTREAM_NO_FRAMES",
  frame_stale: "FRAME_STALE",
  input_ack_timeout: "INPUT_ACK_TIMEOUT",
  input_rejected_by_worker: "INPUT_ACK_TIMEOUT",
  confirm_timeout_after_action: "EFFECT_NOT_VERIFIED",
  wait_timeout_before_action: "EFFECT_NOT_VERIFIED",
  unsupported_postcondition_type: "UNSUPPORTED_POSTCONDITION_TYPE",
  input_lease_held_by_other: "LEASE_REQUIRED",
  lease_not_found: "LEASE_EXPIRED",
  lease_already_held: "LEASE_DENIED",
  unsafe_signaling: "UNAUTHORIZED",
};

export function isBrokerErrorCode(code: string): code is BrokerErrorCode {
  return BROKER_ERROR_SET.has(code);
}

export function brokerErrorCategory(code: BrokerErrorCode): BrokerErrorCategory {
  return CATEGORIES[code];
}

export function normalizeBrokerErrorCode(code: string): BrokerErrorCode | null {
  if (isBrokerErrorCode(code)) return code;
  return LEGACY_TO_BROKER[code] ?? null;
}

export function brokerError(
  code: BrokerErrorCode,
  detail?: Record<string, unknown> & { legacy_error?: string }
): BrokerErrorPayload {
  const legacy = detail?.legacy_error;
  const cleanDetail = { ...(detail ?? {}) };
  delete cleanDetail["legacy_error"];
  const payload: BrokerErrorPayload = {
    error: code,
    error_code: code,
    category: brokerErrorCategory(code),
    retryable: RETRYABLE.has(code),
  };
  if (legacy !== undefined) payload.legacy_error = legacy;
  if (Object.keys(cleanDetail).length > 0) payload.detail = cleanDetail;
  return payload;
}

export function brokerErrorFromLegacy(
  legacyError: string,
  detail?: Record<string, unknown>
): BrokerErrorPayload {
  const code = normalizeBrokerErrorCode(legacyError) ?? "SESSION_DISCONNECTED";
  return brokerError(code, { ...(detail ?? {}), legacy_error: legacyError });
}
