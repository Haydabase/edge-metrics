#!/usr/bin/env -S npx tsx
// Regenerates otel-collector-config-categorize.yaml (and optionally a CSV)
// from Gateway API HTTPRoutes in whatever cluster your current kubectl
// context points at. Run via `just gen-categorize` (see justfile).
//
// Usage: npx tsx scripts/generate-categorize-rules.ts <output-yaml-path> [output-csv-path]
import { writeFile } from "node:fs/promises";
import { KubeConfig, CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import {
  computeCategorizeRows,
  parseDomains,
  renderCategorizeCsv,
  renderCategorizeYaml,
  type HTTPRouteLike,
  type ServiceLike,
} from "../categorize/src/categorize.js";

const [, , yamlOutput, csvOutput] = process.argv;
if (!yamlOutput) {
  console.error("usage: generate-categorize-rules.ts <output-yaml-path> [output-csv-path]");
  process.exit(1);
}

const domains = parseDomains(process.env.CATEGORIZE_DOMAINS ?? "paybybank.example");

const kc = new KubeConfig();
kc.loadFromDefault();

const coreV1Api = kc.makeApiClient(CoreV1Api);
const customObjectsApi = kc.makeApiClient(CustomObjectsApi);

const [services, httpRoutes] = await Promise.all([
  coreV1Api.listServiceForAllNamespaces().then((r) => r.items as ServiceLike[]),
  customObjectsApi
    .listClusterCustomObject({ group: "gateway.networking.k8s.io", version: "v1", plural: "httproutes" })
    .then((r: any) => r.items as HTTPRouteLike[]),
]);

const { rows, warnings } = computeCategorizeRows(services, httpRoutes, domains);
for (const warning of warnings) {
  console.error(`warning: ${warning}`);
}

await writeFile(yamlOutput, renderCategorizeYaml(rows));
if (csvOutput) {
  await writeFile(csvOutput, renderCategorizeCsv(rows));
}
