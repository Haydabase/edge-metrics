// Turns Gateway API HTTPRoutes into the OTel collector's transform/categorize
// OTTL rules. Pure data transform (no I/O, no Kubernetes client) so it can be
// shared verbatim between the in-cluster watcher (which already has
// Services/HTTPRoutes fetched via @kubernetes/client-node) and the
// scripts/generate-categorize-rules.ts dev CLI.
//
// This is a straight port of the jq pipeline that used to live in
// scripts/generate-categorize-rules.sh - see git history for that file if
// you need to compare behavior.

export interface ServiceLike {
  metadata?: {
    namespace?: string;
    name?: string;
    labels?: Record<string, string>;
  };
}

export interface HTTPRouteMatch {
  path?: { type?: string; value?: string };
  method?: string;
  headers?: unknown[];
  queryParams?: unknown[];
}

export interface HTTPRouteBackendRef {
  kind?: string;
  group?: string;
  namespace?: string;
  name?: string;
  weight?: number;
}

export interface HTTPRouteRule {
  matches?: HTTPRouteMatch[];
  backendRefs?: HTTPRouteBackendRef[];
}

export interface HTTPRouteLike {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    hostnames?: string[];
    rules?: HTTPRouteRule[];
  };
}

export interface CategorizeRow {
  subDomain: string;
  pathType: string;
  pathValue: string;
  app: string;
  product: string;
  owner: string;
}

export interface LogStatementRule {
  conditions: string[];
  statements: string[];
}

const OWNER_ANNOTATION = "github.paybybank.example/owners";
const PRODUCT_ANNOTATION = "sli.paybybank.example/product";
const APP_LABEL = "app.kubernetes.io/name";

export function parseDomains(raw: string): string[] {
  const domains = raw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  if (domains.length === 0) {
    throw new Error("CATEGORIZE_DOMAINS is empty");
  }
  return domains;
}

function pathRank(pathType: string): number {
  switch (pathType) {
    case "Exact":
      return 0;
    case "RegularExpression":
      return 1;
    case "PathPrefix":
      return 2;
    default:
      return 3;
  }
}

type SortKey = (string | number)[];

function compareSortKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) continue;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function bestBackend(rule: HTTPRouteRule): HTTPRouteBackendRef | null {
  const candidates = (rule.backendRefs ?? []).filter(
    (b) => (b.kind ?? "Service") === "Service" && (b.group ?? "") === "",
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((x, y) => (y.weight ?? 1) - (x.weight ?? 1))[0];
}

// Resolves the hostname's sub-domain against the configured domain suffixes,
// stripping a trailing ".mtls" segment - or returns undefined if the
// hostname doesn't end in any of them (the caller should skip the row).
function resolveSubDomain(hostname: string, domains: string[]): string | undefined {
  let rawSubDomain: string | undefined;
  for (const d of domains) {
    if (hostname === d) {
      rawSubDomain = "";
      break;
    }
    if (hostname.endsWith("." + d)) {
      rawSubDomain = hostname.slice(0, -(d.length + 1));
      break;
    }
  }
  if (rawSubDomain === undefined) return undefined;
  if (rawSubDomain === "mtls") return "";
  if (rawSubDomain.endsWith(".mtls")) return rawSubDomain.slice(0, -5);
  return rawSubDomain;
}

interface Entry {
  ok: boolean;
  warning: string | null;
  row: CategorizeRow;
  sortKey: SortKey;
}

export function computeCategorizeRows(
  services: ServiceLike[],
  httpRoutes: HTTPRouteLike[],
  domains: string[],
): { rows: CategorizeRow[]; warnings: string[] } {
  const serviceAppLabels = new Map<string, string>();
  for (const svc of services) {
    const key = `${svc.metadata?.namespace ?? ""}/${svc.metadata?.name ?? ""}`;
    serviceAppLabels.set(key, svc.metadata?.labels?.[APP_LABEL] ?? "");
  }

  const entries: Entry[] = [];

  for (const route of httpRoutes) {
    const routeAppLabel = route.metadata?.labels?.[APP_LABEL] ?? "";
    const routeNs = route.metadata?.namespace ?? "";
    const ownerAnn = route.metadata?.annotations?.[OWNER_ANNOTATION] ?? "";
    const product = route.metadata?.annotations?.[PRODUCT_ANNOTATION] ?? "";
    const created = route.metadata?.creationTimestamp ?? "";
    const nsName = `${routeNs}/${route.metadata?.name ?? ""}`;

    for (const hostname of route.spec?.hostnames ?? []) {
      const rules = route.spec?.rules ?? [];
      for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx++) {
        const rule = rules[ruleIdx];
        const backend = bestBackend(rule);
        const backendKey = backend ? `${backend.namespace ?? routeNs}/${backend.name ?? ""}` : "";
        const serviceAppLabel = serviceAppLabels.get(backendKey) ?? "";
        const appLabel = serviceAppLabel !== "" ? serviceAppLabel : routeAppLabel;

        const matches = rule.matches && rule.matches.length > 0 ? rule.matches : [{}];
        for (const match of matches) {
          const subDomain = resolveSubDomain(hostname, domains);
          if (subDomain === undefined) continue;

          const pathType = match.path?.type ?? "";
          const pathValue = match.path?.value ?? "";
          const ok = appLabel !== "" && appLabel !== "envoy-gateway";
          const warning =
            appLabel === ""
              ? `HTTPRoute ${nsName} (hostname=${hostname}, backend=${backendKey === "" ? "<none>" : backendKey}): could not resolve app.kubernetes.io/name label`
              : null;

          entries.push({
            ok,
            warning,
            row: { subDomain, pathType, pathValue, app: appLabel, product, owner: ownerAnn },
            sortKey: [
              subDomain,
              pathRank(pathType),
              -pathValue.length,
              match.method ? 0 : 1,
              -((match.headers ?? []).length),
              -((match.queryParams ?? []).length),
              created,
              nsName,
              ruleIdx,
            ],
          });
        }
      }
    }
  }

  entries.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));

  const seen = new Set<string>();
  const rows: CategorizeRow[] = [];
  for (const entry of entries) {
    if (!entry.ok) continue;
    const key = JSON.stringify(entry.row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(entry.row);
  }

  const warnings = [...new Set(entries.map((e) => e.warning).filter((w): w is string => w !== null))].sort();

  return { rows, warnings };
}

function pathCondition(row: CategorizeRow): string {
  if (row.pathValue === "") return "";
  if (row.pathType === "Exact") {
    return ` and log.attributes["url.path"] == ${JSON.stringify(row.pathValue)}`;
  }
  if (row.pathType === "RegularExpression") {
    return ` and IsMatch(log.attributes["url.path"], ${JSON.stringify(row.pathValue)})`;
  }
  if (row.pathType === "PathPrefix") {
    if (row.pathValue === "/") return "";
    return ` and IsMatch(log.attributes["url.path"], ${JSON.stringify("^" + row.pathValue)})`;
  }
  return "";
}

export function rowsToLogStatements(rows: CategorizeRow[]): LogStatementRule[] {
  return rows
    .filter((r) => r.subDomain !== "")
    .map((r) => {
      const statements = [`set(log.attributes["pbb.service.name"], ${JSON.stringify(r.app)})`];
      if (r.product !== "") {
        statements.unshift(`set(log.attributes["pbb.product"], ${JSON.stringify(r.product)})`);
      }
      return {
        conditions: [
          `log.attributes["pbb.service.name"] == nil and log.attributes["pbb.sub_domain"] == ${JSON.stringify(r.subDomain)}${pathCondition(r)}`,
        ],
        statements,
      };
    });
}

function renderLogStatement(rule: LogStatementRule): string {
  const conditions = rule.conditions.map((c) => `          - ${c}`).join("\n");
  const statements = rule.statements.map((s) => `          - ${s}`).join("\n");
  return `      - conditions:\n${conditions}\n        statements:\n${statements}`;
}

export function renderCategorizeYaml(rows: CategorizeRow[]): string {
  const rules = rowsToLogStatements(rows);
  const header =
    "processors:\n" +
    "  # This is autogenerated via 'just gen-categorize' - do not manually edit!\n" +
    "  transform/categorize:\n" +
    "    log_statements:\n";
  if (rules.length === 0) {
    return header.replace(/log_statements:\n$/, "log_statements: []\n");
  }
  const border = "################################################################################";
  const section =
    `      ${border}\n` +
    `      # Generated from Gateway API HTTPRoute resources\n` +
    `      ${border}\n` +
    rules.map(renderLogStatement).join("\n");
  return header + section + "\n";
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function renderCategorizeCsv(rows: CategorizeRow[]): string {
  const header = "sub_domain,path_type,path_value,app,product,owner";
  const lines = rows.map((r) =>
    [r.subDomain, r.pathType, r.pathValue, r.app, r.product, r.owner].map(csvCell).join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
