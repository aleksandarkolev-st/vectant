// Shared constants for the AI code completion flow.
export const AI_COMPLETION_STOP_SEQUENCE = '<!-- ai-completion-stop -->';
// Keep completions short so the model responds faster.
export const AI_COMPLETION_MAX_OUTPUT_TOKENS = 256;
// Limit context size to reduce latency without losing the local neighborhood.
export const AI_COMPLETION_MAX_INPUT_CHARS = 3500;
export const API_COMPLETION_ROUTE = '/api/completion';
