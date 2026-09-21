#!/usr/bin/env node
// Watches Gateway API HTTPRoutes cluster-wide and reconciles the collector's
// transform/categorize processor whenever they change. See reconcile.ts for
// what a reconcile actually does, and ../../README.md for the full story.
import * as k8s from "@kubernetes/client-node";
import { reconcile, type ReconcileClients } from "./reconcile.js";

const GROUP = "gateway.networking.k8s.io";
const VERSION = "v1";
const PLURAL = "httproutes";
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 3000);

function log(msg: string): void {
  console.log(`[watcher] ${new Date().toISOString()} ${msg}`);
}

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
const clients: ReconcileClients = { coreV1Api, customObjectsApi };

const listHttpRoutes = () =>
  customObjectsApi.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL }) as Promise<
    k8s.KubernetesListObject<k8s.KubernetesObject>
  >;

const informer = k8s.makeInformer(kc, `/apis/${GROUP}/${VERSION}/${PLURAL}`, listHttpRoutes);

// HTTPRoute changes often arrive in bursts (e.g. `kubectl apply -f k8s/demo-app/`
// touching several routes at once, or Gateway API implementations writing
// route status back shortly after) - coalesce them into a single reconcile.
// A reconcile can take a little while (multiple kubectl calls for the apply
// side), so also guard against two overlapping in-flight runs: if a change
// arrives while one is running, queue exactly one follow-up rather than
// starting a second reconcile concurrently.
let debounceTimer: NodeJS.Timeout | undefined;
let reconciling = false;
let pendingReason: string | null = null;

function scheduleReconcile(reason: string): void {
  log(`change detected (${reason}), reconciling in ${DEBOUNCE_MS}ms`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runReconcile(reason), DEBOUNCE_MS);
}

async function runReconcile(reason: string): Promise<void> {
  if (reconciling) {
    pendingReason = reason;
    return;
  }
  reconciling = true;
  try {
    await reconcile(log, clients);
  } catch (err) {
    log(`reconcile failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  } finally {
    reconciling = false;
    if (pendingReason) {
      const next = pendingReason;
      pendingReason = null;
      scheduleReconcile(`follow-up after ${next}`);
    }
  }
}

informer.on("add", (obj) => scheduleReconcile(`add ${obj.metadata?.namespace}/${obj.metadata?.name}`));
informer.on("update", (obj) => scheduleReconcile(`update ${obj.metadata?.namespace}/${obj.metadata?.name}`));
informer.on("delete", (obj) => scheduleReconcile(`delete ${obj.metadata?.namespace}/${obj.metadata?.name}`));

// The informer does not auto-restart on non-410 watch errors, only on a
// clean stream close or a 410 Gone - so reconnect ourselves on 'error'.
informer.on("error", (err) => {
  log(`informer error: ${err instanceof Error ? (err.stack ?? err.message) : err}; reconnecting in 5s`);
  setTimeout(() => {
    informer.start().catch((startErr) => log(`informer restart failed: ${startErr.stack ?? startErr}`));
  }, 5000);
});

await runReconcile("startup");
await informer.start();
log(`watching ${GROUP}/${VERSION} ${PLURAL} across all namespaces`);
