// The one MCP error-translation adapter. Every tool handler funnels its failures through
// toErrorResult() so the boundary's error taxonomy stays small and consistent -- see
// stack/docs/API_CONTRACT_AUDIT.md and this package's README for the full rationale.
//
// What is ALWAYS preserved, because it's real, useful, and safe: the target service name, the real
// HTTP status (when we got one), the service's own canonical error code (e.g. NOT_FOUND,
// VALIDATION_FAILED -- straight from its ErrorEnvelope, never re-invented), a human-safe message,
// and a request/trace id when the response carried one.
//
// What is NEVER included, under any circumstance: API keys, cookies, Authorization header values,
// stack traces, local filesystem paths, or a raw, unrecognized upstream body dumped verbatim.
import { ServiceUnavailableError } from './registry.mjs';

/** MCP-boundary-only error kinds -- not a new copy of every service's own domain taxonomy. */
export const McpErrorKind = /** @type {const} */ ({
  INVALID_INPUT: 'INVALID_INPUT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR', // a real, well-formed error response from the service -- its own code/message are preserved inside.
  TRANSPORT_ERROR: 'TRANSPORT_ERROR', // network failure, timeout/abort, or a response we could not make sense of.
});

/**
 * @param {string} service
 * @param {{ code: string, message: string }} kind
 * @param {Record<string, unknown>} [extra]
 */
function errorResult(service, kind, extra = {}) {
  const payload = { service, code: kind.code, message: kind.message, ...extra };
  return {
    isError: true,
    content: [{ type: 'text', text: `[${service}] ${kind.code}: ${kind.message}` }],
    structuredContent: payload,
  };
}

/**
 * Translates any failure a tool handler can hit into a safe CallToolResult. `err` may be a thrown
 * Error (config/transport) or the tool may pass a real, already-received `{error, response}` pair
 * from a generated client call (an upstream 4xx/5xx that came back as real, well-formed JSON).
 * @param {string} service
 * @param {unknown} err
 */
export function toErrorResult(service, err) {
  if (err instanceof ServiceUnavailableError) {
    return errorResult(service, { code: McpErrorKind.SERVICE_UNAVAILABLE, message: err.message.replace(`${service} is not available: `, '') });
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return errorResult(service, { code: McpErrorKind.TRANSPORT_ERROR, message: 'request timed out' });
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return errorResult(service, { code: McpErrorKind.TRANSPORT_ERROR, message: 'request was aborted' });
  }
  if (err instanceof TypeError) {
    // fetch's own network-failure shape (DNS, connection refused, TLS, ...) -- never leak err.message
    // verbatim here since it can include the target host/port; a fixed, safe message is enough.
    return errorResult(service, { code: McpErrorKind.TRANSPORT_ERROR, message: 'could not reach the service' });
  }
  if (err && typeof err === 'object' && 'error' in err && 'response' in err) {
    // The real, well-formed openapi-fetch result a tool handler re-throws on a non-2xx: `err.error`
    // is the parsed body, which on this platform is always the shared ErrorEnvelope shape
    // `{ error: { code, message, details? } }` (see stack/docs/API_CONTRACT_AUDIT.md §B.1) --
    // preserved as-is, not reinterpreted, except `details` is dropped (it can carry field-level
    // data we haven't audited for this boundary; code+message is always enough to act on).
    const status = /** @type {{ response?: { status?: number } }} */ (err).response?.status;
    const envelope = /** @type {{ error?: { code?: unknown, message?: unknown } }} */ (err.error)?.error ?? {};
    const code = typeof envelope.code === 'string' ? envelope.code : 'UNKNOWN';
    const message = typeof envelope.message === 'string' ? envelope.message : 'the service returned an error';
    return errorResult(service, { code: McpErrorKind.UPSTREAM_ERROR, message }, { upstreamCode: code, status });
  }
  return errorResult(service, { code: McpErrorKind.TRANSPORT_ERROR, message: 'received an unexpected response from the service' });
}

/**
 * For a tool input that fails its own zod schema -- never even reaches a service call.
 * @param {string} toolName @param {string} message
 */
export function invalidInputResult(toolName, message) {
  return errorResult(toolName, { code: McpErrorKind.INVALID_INPUT, message });
}
