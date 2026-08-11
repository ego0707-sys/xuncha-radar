const WORKER_ORIGIN = "https://xuncha-radar.ergoo0707.workers.dev";

const allowedOrigins = new Set([
  "https://ego0707-sys.github.io",
  "https://xuncha-radar.handdoranibcu.chatgpt.site",
]);

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function forbidden(origin: string | null) {
  return new Response(JSON.stringify({ error: "Origin not allowed" }), {
    status: 403,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...Object.fromEntries(corsHeaders(origin)),
    },
  });
}

async function forward(request: Request, context: RouteContext) {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) return forbidden(origin);

  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`/${path.join("/")}`, WORKER_ORIGIN);
  upstreamUrl.search = incomingUrl.search;

  const requestHeaders = new Headers(request.headers);
  for (const name of ["authorization", "cookie", "host", "origin", "referer"]) {
    requestHeaders.delete(name);
  }

  const init: RequestInit = {
    method: request.method,
    headers: requestHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(upstreamUrl, init);
    const responseHeaders = new Headers(upstream.headers);
    for (const name of ["connection", "content-length", "set-cookie", "transfer-encoding"]) {
      responseHeaders.delete(name);
    }
    for (const [name, value] of corsHeaders(origin)) responseHeaders.set(name, value);
    responseHeaders.set("Cache-Control", "no-store, no-transform");
    responseHeaders.set("X-Accel-Buffering", "no");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: "调查网关上游连接失败" }), {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...Object.fromEntries(corsHeaders(origin)),
      },
    });
  }
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) return forbidden(origin);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export const GET = forward;
export const POST = forward;
