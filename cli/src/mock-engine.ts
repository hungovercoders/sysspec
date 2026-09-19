/** The spec-derived mock engine: pure dispatch over a baked bundle.
 *
 * Everything here is runtime-agnostic - no fs, no node builtins, no
 * dependencies - so the same dispatch serves a `node:http` server
 * (`mocks serve`) and a Cloudflare Worker (`mocks bundle` plus a fetch
 * handler). The bundle is built once, from the specs and the example
 * artifacts, by the Node half in mocks-serve.ts.
 *
 * The URL shapes are Microcks' own, deliberately: `/rest/<Title>/<version>`
 * and `/api/ws/<Title>/<version>/<operation>`. That is what lets the
 * existing smoke suite (`sysspec mocks test --microcks-url ...`) run
 * unchanged against a served bundle, so agreement between this engine and
 * the Microcks stack is something CI proves rather than something a README
 * claims.
 */

export interface MockCase {
  name: string;
  /** Path-template parameters this case dispatches on, by name. */
  pathParams: Record<string, string>;
  /** Query parameters this case dispatches on, by name. */
  query: Record<string, string>;
  status: number;
  mediaType: string;
  body: string | null;
}

export interface MockRoute {
  method: string;
  /** The operation's path template, e.g. /orders/{order_id}. */
  path: string;
  segments: string[];
  cases: MockCase[];
}

export interface MockChannel {
  /** The AsyncAPI send operation's name, as it appears in the WS path. */
  operation: string;
  /** Example payloads, replayed in order. */
  messages: string[];
}

/** One spec document's mock surface. REST and event mocks are separate
 * Microcks services with their own titles and versions (Orders API 3.2.0
 * and Orders 3.0.0 are different services), so each spec doc is one entry. */
export interface MockService {
  title: string;
  version: string;
  kind: "rest" | "events";
  /** The service directory the spec came from, for the index page. */
  service: string;
  routes: MockRoute[];
  channels: MockChannel[];
}

export interface MockBundle {
  version: 1;
  /** The commit the bundle was built from, when the builder knows it. */
  source?: string;
  services: MockService[];
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Microcks encodes spaces in a title as '+', and a browser or client may
 * percent-encode them instead; both must reach the same service. */
export function decodeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape is not a match for any title; compare it raw.
  }
  return decoded.replaceAll("+", " ");
}

export function encodeTitle(title: string): string {
  return title.replaceAll(" ", "+");
}

/** The base path a REST service's operations hang off. */
export function restBase(service: MockService): string {
  return `/rest/${encodeTitle(service.title)}/${service.version}`;
}

export function wsPath(service: MockService, channel: MockChannel): string {
  return `/api/ws/${encodeTitle(service.title)}/${service.version}/${channel.operation}`;
}

/** Microcks' own default: the minion republishes every example on this
 * cadence, and a consumer built against the mocks is written to expect it.
 * Both runtimes drive `replay` with their own timer at this interval. */
export const PUBLISH_INTERVAL_MS = 3000;

/** A channel's examples in order, cycling - the payload sequence a
 * subscriber sees, independent of whatever timer drives it. */
export function replay(channel: MockChannel): () => string | null {
  let next = 0;
  return () => {
    if (channel.messages.length === 0) return null;
    return channel.messages[next++ % channel.messages.length];
  };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export const CORS_HEADERS: Record<string, string> = {
  // The mocks exist to be called from a consumer being built against them,
  // a browser UI included; a mock nothing may call is not a mock.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): MockResponse {
  return {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
    body: JSON.stringify(body, null, 2),
  };
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

/** The service a `/rest/<title>/<version>/...` path addresses, with the
 * operation path that follows it. */
function matchService(
  bundle: MockBundle,
  segments: string[],
): [MockService, string] | null {
  if (segments.length < 3 || segments[0] !== "rest") return null;
  const title = decodeSegment(segments[1]);
  const version = decodeSegment(segments[2]);
  const service = bundle.services.find(
    (s) => s.kind === "rest" && s.title === title && s.version === version,
  );
  if (!service) return null;
  const rest = segments.slice(3).map(decodeSegment);
  return [service, `/${rest.join("/")}`];
}

function matchRoute(
  service: MockService,
  method: string,
  opSegments: string[],
): [MockRoute, Record<string, string>] | null {
  for (const route of service.routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== opSegments.length) continue;
    const captured: Record<string, string> = {};
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

/** The case a request dispatches to: the one declaring the most parameters
 * that the request actually carries, and none that it contradicts. The
 * bundle builder refuses examples this cannot tell apart, so a tie here
 * only ever happens between cases that declare nothing. */
export function selectCase(
  route: MockRoute,
  captured: Record<string, string>,
  query: Record<string, string>,
): MockCase | null {
  let best: MockCase | null = null;
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

function caseResponse(c: MockCase): MockResponse {
  const headers: Record<string, string> = { ...CORS_HEADERS };
  if (c.body !== null) headers["Content-Type"] = c.mediaType;
  return { status: c.status, headers, body: c.body ?? "" };
}

/** What the mock knows how to serve, as data - the index page and the
 * `mocks serve` banner render the same thing. */
export function describe(bundle: MockBundle) {
  return {
    name: "sysspec-mocks",
    ...(bundle.source ? { source: bundle.source } : {}),
    services: bundle.services.map((s) => ({
      service: s.service,
      title: s.title,
      version: s.version,
      ...(s.kind === "rest"
        ? {
            rest: restBase(s),
            operations: s.routes.map((r) => `${r.method} ${r.path}`),
          }
        : {
            events: s.channels.map((c) => wsPath(s, c)),
          }),
    })),
  };
}

/** Serve one request. Always answers: a miss is a 404 that says what the
 * mock does know, because the commonest mistake against a mock is a URL
 * the examples never described. */
export function dispatch(
  bundle: MockBundle,
  method: string,
  pathname: string,
  query: Record<string, string> = {},
): MockResponse {
  if (method === "OPTIONS") return { status: 204, headers: { ...CORS_HEADERS }, body: "" };

  const segments = splitPath(pathname);
  if (segments.length === 0) return json(200, describe(bundle));
  if (segments.length === 1 && segments[0] === "health") return json(200, { status: "ok" });

  const matched = matchService(bundle, segments);
  if (!matched) {
    return json(404, {
      error: `No mock service at ${pathname}`,
      mock: "sysspec",
      rest: bundle.services.filter((s) => s.kind === "rest").map(restBase),
    });
  }
  const [service, opPath] = matched;
  const route = matchRoute(service, method, splitPath(opPath));
  if (!route) {
    return json(404, {
      error: `${service.title} ${service.version} has no mocked operation ${method} ${opPath}`,
      mock: "sysspec",
      operations: service.routes.map((r) => `${r.method} ${r.path}`),
    });
  }
  const [matchedRoute, captured] = route;
  const selected = selectCase(matchedRoute, captured, query);
  if (!selected) {
    return json(404, {
      error:
        `No example of ${method} ${matchedRoute.path} dispatches this request. ` +
        "Mock cases dispatch by URI, so the path and query parameters must " +
        "match an example exactly.",
      mock: "sysspec",
      cases: matchedRoute.cases.map((c) => ({
        name: c.name,
        ...c.pathParams,
        ...c.query,
      })),
    });
  }
  return caseResponse(selected);
}

/** The channel a `/api/ws/<title>/<version>/<operation>` path addresses. */
export function matchChannel(
  bundle: MockBundle,
  pathname: string,
): [MockService, MockChannel] | null {
  const segments = splitPath(pathname);
  if (segments.length !== 5 || segments[0] !== "api" || segments[1] !== "ws") return null;
  const title = decodeSegment(segments[2]);
  const version = decodeSegment(segments[3]);
  const operation = decodeSegment(segments[4]);
  const service = bundle.services.find(
    (s) => s.kind === "events" && s.title === title && s.version === version,
  );
  if (!service) return null;
  const channel = service.channels.find((c) => c.operation === operation);
  return channel ? [service, channel] : null;
}
