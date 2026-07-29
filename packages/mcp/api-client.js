const DEFAULT_API_BASE = "http://localhost:3000";

/**
 * Read MCP client config from the environment. The API key is OPTIONAL: in
 * local mode (default) the server runs keyless, so no key is needed. In hosted
 * mode the operator sets NSECT_API_KEY. The key, when present, is sent as the
 * x-api-key header; when absent the header is omitted and the server decides
 * whether to admit the request based on its own mode.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function readMcpConfig(env = process.env) {
  const apiBase = (
    env.NSECT_API_URL
    || DEFAULT_API_BASE
  ).trim();
  const apiKey = (env.NSECT_API_KEY || "").trim();
  return { apiBase, apiKey };
}

export const MCP_CONFIG_EXAMPLE = {
  mcpServers: {
    nsect: {
      command: "node",
      args: ["./packages/mcp/index.js"],
      env: {
        // Optional in local mode; required when the server runs hosted.
        NSECT_API_KEY: "sk_your_key_here",
        NSECT_API_URL: "http://localhost:3000",
      },
    },
  },
};

/**
 * Create an API client. The apiKey is optional — omitted entirely when the
 * target server runs in local (keyless) mode.
 *
 * @param {{ apiBase: string, apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createApiClient({
  apiBase,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  if (!apiBase) {
    throw new Error("apiBase is required");
  }

  async function postJson(endpoint, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let responseText = "";

    try {
      /** @type {Record<string, string>} */
      const headers = { "Content-Type": "application/json" };
      // Only attach the key when one is configured (local mode = keyless).
      if (apiKey) {
        headers["x-api-key"] = apiKey;
      }
      response = await fetchImpl(`${apiBase}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      responseText = await response.text();
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      // Use String() fallback for non-Error throws (e.g., string/null rejections
      // in network partition scenarios). Node 18+ fetch wraps underlying errors
      // like ECONNREFUSED in .cause with a generic "fetch failed" message —
      // prefer the more specific cause when available.
      const rawMessage = err?.message;
      const isGenericFetchFailed = rawMessage === "fetch failed" || rawMessage === "Failed to fetch";
      const detail = (isGenericFetchFailed && err?.cause?.message)
        || rawMessage
        || err?.cause?.message
        || err?.code
        || String(err);
      return {
        ok: false,
        errorMessage: isAbort
          ? `API request timed out after ${Math.floor(timeoutMs / 1000)}s`
          : `API request failed: ${detail}`,
      };
    } finally {
      clearTimeout(timeoutId);
    }

    let payload;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = { raw: responseText };
      }
    } else {
      payload = {};
    }

    if (!response.ok) {
      const message = typeof payload.error === "string"
        ? payload.error
        : (payload.raw || JSON.stringify(payload));
      return {
        ok: false,
        errorMessage: `API Error ${response.status}: ${message}`,
      };
    }

    return { ok: true, payload };
  }

  return { postJson };
}

export function toMcpError(errorMessage) {
  return {
    content: [{ type: "text", text: errorMessage }],
    isError: true,
  };
}
