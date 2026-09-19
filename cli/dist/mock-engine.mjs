import { createRequire as __createRequire } from 'node:module'; const require = /* @__PURE__ */ __createRequire(import.meta.url);

// src/mock-engine.ts
function decodeSegment(segment) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
  }
  return decoded.replaceAll("+", " ");
}
function encodeTitle(title) {
  return title.replaceAll(" ", "+");
}
function restBase(service) {
  return `/rest/${encodeTitle(service.title)}/${service.version}`;
}
function wsPath(service, channel) {
  return `/api/ws/${encodeTitle(service.title)}/${service.version}/${channel.operation}`;
}
var PUBLISH_INTERVAL_MS = 3e3;
function replay(channel) {
  let next = 0;
  return () => {
    if (channel.messages.length === 0) return null;
    return channel.messages[next++ % channel.messages.length];
  };
}
var JSON_HEADERS = { "Content-Type": "application/json" };
var CORS_HEADERS = {
  // The mocks exist to be called from a consumer being built against them,
  // a browser UI included; a mock nothing may call is not a mock.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400"
};
function json(status, body) {
  return {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
    body: JSON.stringify(body, null, 2)
  };
}
function splitPath(pathname) {
  return pathname.split("/").filter((s) => s.length > 0);
}
function matchService(bundle, segments) {
  if (segments.length < 3 || segments[0] !== "rest") return null;
  const title = decodeSegment(segments[1]);
  const version = decodeSegment(segments[2]);
  const service = bundle.services.find(
    (s) => s.kind === "rest" && s.title === title && s.version === version
  );
  if (!service) return null;
  const rest = segments.slice(3).map(decodeSegment);
  return [service, `/${rest.join("/")}`];
}
function matchRoute(service, method, opSegments) {
  for (const route of service.routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== opSegments.length) continue;
    const captured = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const spec = route.segments[i];
      if (spec.startsWith("{") && spec.endsWith("}")) {
        captured[spec.slice(1, -1)] = opSegments[i];
      } else if (spec !== opSegments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return [route, captured];
  }
  return null;
}
function selectCase(route, captured, query) {
  let best = null;
  let bestScore = -1;
  for (const c of route.cases) {
    let score = 0;
    let ok = true;
    for (const [name, want] of Object.entries(c.pathParams)) {
      if (captured[name] !== want) {
        ok = false;
        break;
      }
      score += 1;
    }
    if (!ok) continue;
    for (const [name, want] of Object.entries(c.query)) {
      if (query[name] !== want) {
        ok = false;
        break;
      }
      score += 1;
    }
    if (!ok) continue;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
function caseResponse(c) {
  const headers = { ...CORS_HEADERS };
  if (c.body !== null) headers["Content-Type"] = c.mediaType;
  return { status: c.status, headers, body: c.body ?? "" };
}
function describe(bundle) {
  return {
    name: "sysspec-mocks",
    ...bundle.source ? { source: bundle.source } : {},
    services: bundle.services.map((s) => ({
      service: s.service,
      title: s.title,
      version: s.version,
      ...s.kind === "rest" ? {
        rest: restBase(s),
        operations: s.routes.map((r) => `${r.method} ${r.path}`)
      } : {
        events: s.channels.map((c) => wsPath(s, c))
      }
    }))
  };
}
function dispatch(bundle, method, pathname, query = {}) {
  if (method === "OPTIONS") return { status: 204, headers: { ...CORS_HEADERS }, body: "" };
  const segments = splitPath(pathname);
  if (segments.length === 0) return json(200, describe(bundle));
  if (segments.length === 1 && segments[0] === "health") return json(200, { status: "ok" });
  const matched = matchService(bundle, segments);
  if (!matched) {
    return json(404, {
      error: `No mock service at ${pathname}`,
      mock: "sysspec",
      rest: bundle.services.filter((s) => s.kind === "rest").map(restBase)
    });
  }
  const [service, opPath] = matched;
  const route = matchRoute(service, method, splitPath(opPath));
  if (!route) {
    return json(404, {
      error: `${service.title} ${service.version} has no mocked operation ${method} ${opPath}`,
      mock: "sysspec",
      operations: service.routes.map((r) => `${r.method} ${r.path}`)
    });
  }
  const [matchedRoute, captured] = route;
  const selected = selectCase(matchedRoute, captured, query);
  if (!selected) {
    return json(404, {
      error: `No example of ${method} ${matchedRoute.path} dispatches this request. Mock cases dispatch by URI, so the path and query parameters must match an example exactly.`,
      mock: "sysspec",
      cases: matchedRoute.cases.map((c) => ({
        name: c.name,
        ...c.pathParams,
        ...c.query
      }))
    });
  }
  return caseResponse(selected);
}
function matchChannel(bundle, pathname) {
  const segments = splitPath(pathname);
  if (segments.length !== 5 || segments[0] !== "api" || segments[1] !== "ws") return null;
  const title = decodeSegment(segments[2]);
  const version = decodeSegment(segments[3]);
  const operation = decodeSegment(segments[4]);
  const service = bundle.services.find(
    (s) => s.kind === "events" && s.title === title && s.version === version
  );
  if (!service) return null;
  const channel = service.channels.find((c) => c.operation === operation);
  return channel ? [service, channel] : null;
}
export {
  CORS_HEADERS,
  PUBLISH_INTERVAL_MS,
  decodeSegment,
  describe,
  dispatch,
  encodeTitle,
  matchChannel,
  replay,
  restBase,
  selectCase,
  wsPath
};
