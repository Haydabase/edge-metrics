// Regenerates the collector's transform/categorize processor from live
// HTTPRoutes and live-patches it into the already-running collector
// ConfigMap, restarting the Deployment to pick it up. This intentionally
// reuses scripts/generate-categorize-rules.sh rather than reimplementing its
// HTTPRoute -> rule logic here, and shells out to kubectl (already required
// for that script) for all reads/writes rather than fighting client-node's
// generated patch-content-type negotiation.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const NAMESPACE = process.env.COLLECTOR_NAMESPACE || "edge-metrics";
const CONFIGMAP = process.env.COLLECTOR_CONFIGMAP || "edge-metrics-opentelemetry-collector";
const DEPLOYMENT = process.env.COLLECTOR_DEPLOYMENT || "edge-metrics-opentelemetry-collector";
const RELAY_KEY = "relay";
const RESTART_ANNOTATION = "edge-metrics.dev/restartedAt";

function run(cmd, args) {
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

export async function reconcile(log) {
  const dir = await mkdtemp(path.join(tmpdir(), "categorize-"));
  try {
    const fragmentPath = path.join(dir, "categorize.yaml");
    await run("generate-categorize-rules.sh", [fragmentPath]);
    const fragment = yaml.load(await readFile(fragmentPath, "utf8"));
    const categorizeRules = fragment?.processors?.["transform/categorize"];
    if (!categorizeRules) {
      log("generate-categorize-rules.sh produced no transform/categorize block; skipping");
      return;
    }

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

    const relay = yaml.load(currentRelayYaml);
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
