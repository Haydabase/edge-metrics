#!/usr/bin/env node
// Tiny local relay for the edge-metrics demo. Serves the static frontend and,
// for every other path, treats the first path segment as a "subdomain key"
// and reverse-proxies the rest to the Envoy Gateway with the matching Host
// header (something a browser's fetch() cannot set itself). For non-mTLS
// routes it also simulates the Cloudflare Logpush push for the same request,
// mirroring production where Cloudflare independently logs every non-mTLS
// request in parallel with Envoy. See ../README.md for the full story.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 8080);
const CLOUDFLARE_HOST = process.env.CLOUDFLARE_HOST || "127.0.0.1";
const CLOUDFLARE_PORT = Number(process.env.CLOUDFLARE_PORT || 8088);
const PORT = Number(process.env.PORT || 4000);

// Allow-list of subdomain keys -> the Host header to forward upstream as.
// Keep in sync with the taxonomy in otel-collector-config.yaml /
// k8s/demo-app/*.yaml.
const SUBDOMAIN_HOSTS = {
  api: "api.paybybank.example",
  "api.mtls": "api.mtls.paybybank.example",
  auth: "auth.paybybank.example",
  "auth.mtls": "auth.mtls.paybybank.example",
};

function isMtls(subdomain) {
  return subdomain.includes(".mtls");
}

function forwardToGateway(req, host, upstreamPath) {
  return new Promise((resolve, reject) => {
    const upstreamReq = http.request(
      {
        host: GATEWAY_HOST,
        port: GATEWAY_PORT,
        method: req.method,
        path: upstreamPath,
        headers: { ...req.headers, host },
      },
      (upstreamRes) => {
        upstreamRes.resume();
        upstreamRes.on("end", () => resolve(upstreamRes.statusCode));
      },
    );
    upstreamReq.on("error", reject);
    req.pipe(upstreamReq);
  });
}

// Builds a realistic Cloudflare Logpush-shaped payload from the *real*
// captured request/response data and POSTs it straight at the collector's
// cloudflarereceiver, exercising the actual filter/cloudflare ->
// attributes/cloudflare -> transform/cloudflare processing chain — see
// receivers.cloudflare and processors.*/cloudflare in otel-collector-config.yaml
// for the exact fields this must match.
function simulateCloudflareLog({ host, method, upstreamPath, status, startMs, endMs }) {
  const rayId = crypto.randomBytes(8).toString("hex");
  const payload = {
    ClientRequestHost: host,
    ClientRequestMethod: method,
    ClientRequestPath: upstreamPath,
    ClientRequestUserAgent: "edge-metrics-demo-ui/1.0",
    ClientRequestSource: "eyeball",
    EdgeResponseStatus: status,
    EdgeStartTimestamp: (BigInt(startMs) * 1_000_000n).toString(),
    EdgeEndTimestamp: (BigInt(endMs) * 1_000_000n).toString(),
    EdgeTimeToFirstByteMs: Math.max(1, endMs - startMs),
    RayID: rayId,
    RequestHeaders: { pbb_client_id: "demo-mobile-app" },
  };
  const body = JSON.stringify(payload) + "\n";

  return new Promise((resolve) => {
    const cfReq = http.request(
      {
        host: CLOUDFLARE_HOST,
        port: CLOUDFLARE_PORT,
        method: "POST",
        path: "/",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (cfRes) => {
        cfRes.resume();
        cfRes.on("end", resolve);
      },
    );
    // Best-effort: a hiccup simulating Cloudflare shouldn't fail the whole demo request.
    cfReq.on("error", () => resolve());
    cfReq.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  const match = req.url.match(/^\/([a-z0-9.-]+)(\/.*)?$/i);
  const subdomain = match?.[1];
  const upstreamPath = match?.[2] || "/";
  const host = subdomain && SUBDOMAIN_HOSTS[subdomain];

  if (!host) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `unknown subdomain '${subdomain}'`,
        known: Object.keys(SUBDOMAIN_HOSTS),
      }),
    );
    return;
  }

  const startMs = Date.now();
  let envoyStatus;
  try {
    envoyStatus = await forwardToGateway(req, host, upstreamPath);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `request to Envoy Gateway failed: ${err.message}` }));
    return;
  }
  const endMs = Date.now();

  // mTLS traffic never passes through Cloudflare in production, so skip the
  // simulation for .mtls routes — matching reality.
  let cloudflareSimulated = false;
  if (!isMtls(subdomain)) {
    await simulateCloudflareLog({
      host,
      method: req.method,
      upstreamPath,
      status: envoyStatus,
      startMs,
      endMs,
    });
    cloudflareSimulated = true;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      envoyStatus,
      envoyDurationMs: endMs - startMs,
      cloudflareSimulated,
    }),
  );
});

server.listen(PORT, () => {
  console.log(`demo-ui relay listening on http://localhost:${PORT}`);
  console.log(`  -> Envoy Gateway at ${GATEWAY_HOST}:${GATEWAY_PORT}`);
  console.log(`  -> Cloudflare receiver at ${CLOUDFLARE_HOST}:${CLOUDFLARE_PORT}`);
});
