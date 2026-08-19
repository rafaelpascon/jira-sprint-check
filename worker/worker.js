/**
 * Jira Sprint Check — read-only proxy Worker.
 *
 * Holds the Jira API token as a Worker secret (never sent to the browser),
 * adds Basic Auth server-side, and forwards only a fixed whitelist of Jira
 * REST paths needed by the Sprint Check dashboard. Everything else is
 * rejected with 404. CORS is restricted to an allowed-origin list.
 *
 * Required secrets/vars (see wrangler.toml / `wrangler secret put`):
 *   JIRA_EMAIL      - Atlassian account email used for Basic Auth (secret)
 *   JIRA_API_TOKEN  - Atlassian API token (secret)
 *   JIRA_BASE_URL   - e.g. https://nationalautocare.atlassian.net (plain var)
 *   ALLOWED_ORIGINS - comma-separated extra exact origins, optional (plain var)
 */

// Origins always allowed, in addition to ALLOWED_ORIGINS env var (if set).
const DEFAULT_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.github\.io$/i,
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
];

// Cache successful GET responses for this many seconds to take load off
// Jira on repeated refreshes. Not a real rate limiter — good enough for a
// single-user internal tool.
const CACHE_TTL_SECONDS = 20;

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (DEFAULT_ORIGIN_PATTERNS.some((re) => re.test(origin))) return true;
  const extra = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

// Returns the whitelisted Jira path+search to forward, or null if the
// incoming request doesn't match anything we allow.
function matchWhitelistedPath(pathname, search, method) {
  // GET /rest/agile/1.0/board/{boardId}/sprint  (find active sprint / list sprints)
  if (
    method === "GET" &&
    /^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/.test(pathname)
  ) {
    return pathname + search;
  }

  // GET /rest/greenhopper/1.0/rapid/charts/sprintreport  (velocity history)
  if (
    method === "GET" &&
    pathname === "/rest/greenhopper/1.0/rapid/charts/sprintreport"
  ) {
    return pathname + search;
  }

  // GET /rest/api/3/issue/{key}  (activity feed + aging via changelog)
  if (
    method === "GET" &&
    /^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9]*-\d+$/.test(pathname)
  ) {
    return pathname + search;
  }

  // POST /rest/api/3/search/jql  (issue/status/assignee/priority/links queries)
  if (method === "POST" && pathname === "/rest/api/3/search/jql") {
    return pathname + search;
  }

  return null;
}

async function handleProxyRequest(request, env, ctx, origin) {
  const url = new URL(request.url);
  const forwardPath = matchWhitelistedPath(
    url.pathname,
    url.search,
    request.method
  );

  if (!forwardPath) {
    return jsonResponse({ error: "Not found" }, 404, origin);
  }

  if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
    // Never include any detail that could leak config state.
    return jsonResponse({ error: "Proxy misconfigured" }, 500, origin);
  }

  const targetUrl = env.JIRA_BASE_URL.replace(/\/+$/, "") + forwardPath;
  const cache = caches.default;
  const cacheKey = new Request(targetUrl, { method: "GET" });

  if (request.method === "GET") {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) =>
        resp.headers.set(k, v)
      );
      return resp;
    }
  }

  const auth = "Basic " + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const init = {
    method: request.method,
    headers: {
      Authorization: auth,
      Accept: "application/json",
    },
  };

  if (request.method === "POST") {
    init.headers["Content-Type"] = "application/json";
    init.body = await request.text();
  }

  let jiraResp;
  try {
    jiraResp = await fetch(targetUrl, init);
  } catch (err) {
    return jsonResponse({ error: "Upstream request failed" }, 502, origin);
  }

  const bodyText = await jiraResp.text();
  const response = new Response(bodyText, {
    status: jiraResp.status,
    headers: {
      "Content-Type":
        jiraResp.headers.get("Content-Type") || "application/json",
      ...corsHeaders(origin),
    },
  });

  if (request.method === "GET" && jiraResp.ok) {
    const toCache = new Response(bodyText, {
      status: jiraResp.status,
      headers: {
        "Content-Type":
          jiraResp.headers.get("Content-Type") || "application/json",
        "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const allowed = isAllowedOrigin(origin, env);

    if (request.method === "OPTIONS") {
      if (!allowed) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!allowed) {
      return jsonResponse({ error: "Origin not allowed" }, 403, null);
    }

    try {
      return await handleProxyRequest(request, env, ctx, origin);
    } catch (err) {
      // Deliberately no logging of request details/headers — avoids ever
      // writing the Authorization header or token to Worker logs.
      return jsonResponse({ error: "Internal error" }, 500, origin);
    }
  },
};
