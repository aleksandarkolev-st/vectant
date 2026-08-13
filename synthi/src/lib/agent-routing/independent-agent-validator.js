function compactReason(value, fallback) {
  const reason = String(value || '').trim();
  return reason ? reason.slice(0, 240) : fallback;
}

function toolIds(toolCalls) {
  return [...new Set((Array.isArray(toolCalls) ? toolCalls : [])
    .map((call) => String(call?.tool || '').trim().toLowerCase())
    .filter(Boolean))];
}

/**
 * A small server-owned validator for an independently routed agent result.
 * It is deliberately separate from execution: it receives the completed
 * result and can reject tool calls which did not belong to the route.
 */
export async function validateIndependentAgentResult({ result, routing } = {}) {
  const permittedToolIds = new Set(
    (Array.isArray(routing?.tools) ? routing.tools : [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const usedToolIds = toolIds(result?.toolCalls);
  const rejectedToolIds = usedToolIds.filter((id) => !permittedToolIds.has(id));

  if (!result || typeof result.output !== 'string' || !Array.isArray(result.toolCalls)) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'Agent result has an invalid shape.',
      toolCallCount: Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0,
      rejectedToolIds,
    };
  }

  if (rejectedToolIds.length > 0) {
    return {
      ok: false,
      status: 'rejected',
      reason: compactReason(
        `Agent used tools outside its routed selection: ${rejectedToolIds.join(', ')}.`,
        'Agent used tools outside its routed selection.',
      ),
      toolCallCount: result.toolCalls.length,
      rejectedToolIds,
    };
  }

  return {
    ok: true,
    status: 'validated',
    reason: 'Independent server policy validation passed.',
    toolCallCount: result.toolCalls.length,
    rejectedToolIds: [],
  };
}
