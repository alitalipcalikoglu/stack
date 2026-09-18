// The one success-result builder every tool uses, so output shape stays consistent across tools:
// a short, model-readable text summary plus the real, structured data -- never a raw HTTP response
// object dump, never the full header set (only the few that are genuinely useful and safe: a
// request/trace id when present; nothing else, since every other header on this platform is either
// routine plumbing or explicitly documented as internal-only, per the Phase 0 audit's tracing
// section).

/**
 * @param {object} o
 * @param {number} o.status real HTTP status of the call this result represents.
 * @param {unknown} o.data the parsed response body (already typed by the generated client).
 * @param {string} [o.summary] one short, human-readable line; falls back to a generic one.
 * @param {string|null} [o.requestId] x-request-id, if the response carried one -- safe, useful for correlating with service logs.
 */
export function toolResult({ status, data, summary, requestId = null }) {
  const text = summary ?? `status ${status}`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { status, data, ...(requestId ? { requestId } : {}) },
  };
}
