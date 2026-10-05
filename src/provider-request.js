const REQUEST_TIMEOUT_MS = 10000;

// Bound both connection setup and response reading, so a stalled provider
// returns an actionable error through the existing provider error handler.
export async function fetchProviderText(
  fetchImpl,
  url,
  options,
  { providerName, ErrorClass, timeoutMs = REQUEST_TIMEOUT_MS },
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;

  try {
    const response = await fetchImpl(url, { ...options, signal });
    const text = await response.text();
    return { response, text };
  } catch (cause) {
    const upstreamCode = cause.cause?.code || cause.code;
    const cancelled = options.signal?.aborted;
    const timedOut =
      !cancelled &&
      (deadline.aborted ||
        cause.name === "TimeoutError" ||
        [
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
          "ETIMEDOUT",
        ].includes(upstreamCode));
    const code = cancelled
      ? "provider_request_cancelled"
      : timedOut
        ? "provider_timeout"
        : "provider_unreachable";
    const message = cancelled
      ? `${providerName}请求已取消。`
      : timedOut
        ? `连接${providerName}超时，请稍后重试。`
        : `暂时无法连接${providerName}，请稍后重试。`;
    const error = new ErrorClass(message, {
      code,
      retryable: !cancelled,
      ...(upstreamCode ? { upstreamCode } : {}),
    });
    error.cause = cause;
    throw error;
  }
}
