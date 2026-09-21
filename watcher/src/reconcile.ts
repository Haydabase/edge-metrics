// Regenerates the collector's transform/categorize processor from live
// HTTPRoutes/Services (fetched in-process via @kubernetes/client-node - see
// ../../categorize/src/categorize.ts for the actual HTTPRoute -> rule logic)
// and live-patches it into the already-running collector ConfigMap,
// restarting the Deployment to pick it up. The apply side still shells out
// to kubectl (deliberately - see the comment below) but the generation side
// no longer shells out to anything.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { computeCategorizeRows, parseDomains, rowsToLogStatements, type HTTPRouteLike, type ServiceLike } from "../../categorize/src/categorize.js";

const NAMESPACE = process.env.COLLECTOR_NAMESPACE || "edge-metrics";
const CONFIGMAP = process.env.COLLECTOR_CONFIGMAP || "edge-metrics-opentelemetry-collector";
const DEPLOYMENT = process.env.COLLECTOR_DEPLOYMENT || "edge-metrics-opentelemetry-collector";
const RELAY_KEY = "relay";
const RESTART_ANNOTATION = "edge-metrics.dev/restartedAt";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export interface ReconcileClients {
  coreV1Api: CoreV1Api;
  customObjectsApi: CustomObjectsApi;
}

export async function reconcile(log: (msg: string) => void, clients: ReconcileClients): Promise<void> {
  const domains = parseDomains(process.env.CATEGORIZE_DOMAINS ?? "paybybank.example");

  const [services, httpRoutesResult] = await Promise.all([
    clients.coreV1Api.listServiceForAllNamespaces().then((r) => r.items as ServiceLike[]),
    clients.customObjectsApi.listClusterCustomObject({
      group: "gateway.networking.k8s.io",
      version: "v1",
      plural: "httproutes",
    }),
  ]);
  const httpRoutes = (httpRoutesResult as { items: HTTPRouteLike[] }).items;

  const { rows, warnings } = computeCategorizeRows(services, httpRoutes, domains);
  for (const warning of warnings) {
    log(`warning: ${warning}`);
  }
  const categorizeRules = { log_statements: rowsToLogStatements(rows) };

  const dir = await mkdtemp(path.join(tmpdir(), "categorize-"));
  try {
    const currentRelayYaml = await run("kubectl", [
      "get",
      "configmap",
      CONFIGMAP,
      "-n",
      NAMESPACE,
      "-o",
      `jsonpath={.data.${RELAY_KEY}}`,
    ]);
    if (!currentRelayYaml) {
      log(`configmap/${CONFIGMAP} has no data.${RELAY_KEY} key; skipping`);
      return;
    }

    const relay = yaml.load(currentRelayYaml) as Record<string, any>;
    relay.processors ??= {};
    relay.processors["transform/categorize"] = categorizeRules;
    const newRelayYaml = yaml.dump(relay, { lineWidth: -1 });

    if (newRelayYaml === currentRelayYaml) {
      log("transform/categorize unchanged; skipping patch + restart");
      return;
    }

    const patchPath = path.join(dir, "configmap-patch.json");
    await writeFile(patchPath, JSON.stringify({ data: { [RELAY_KEY]: newRelayYaml } }));
    await run("kubectl", [
      "patch",
      "configmap",
      CONFIGMAP,
      "-n",
      NAMESPACE,
      "--type",
      "merge",
      "--patch-file",
      patchPath,
    ]);

    // The apply side deliberately still shells out to kubectl rather than
    // using client-node's patch methods, which default to a JSON-Patch
    // content-type unsuited to a plain merge patch - see the watcher plan
    // notes from when this was first built.
    await run("kubectl", [
      "patch",
      "deployment",
      DEPLOYMENT,
      "-n",
      NAMESPACE,
      "--type",
      "merge",
      "-p",
      JSON.stringify({
        spec: { template: { metadata: { annotations: { [RESTART_ANNOTATION]: new Date().toISOString() } } } },
      }),
    ]);

    log(`patched configmap/${CONFIGMAP} and restarted deployment/${DEPLOYMENT}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
