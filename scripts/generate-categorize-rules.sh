#!/usr/bin/env bash
set -euo pipefail

# Generate the transform/categorize processor's rule set from Kubernetes
# Gateway API HTTPRoutes. Each route is flattened into rows of {sub_domain,
# path, app, product, owner} which are then rendered into an OTel processor
# config.
#
# Usage: ./generate-categorize-rules.sh <output-yaml-path> [output-csv-path]
#
# Prerequisites:
#   - kubectl configured against the target cluster (e.g. your local kind
#     demo cluster via `just demo`).
#   - jq on PATH.
#
# Outputs:
#   - YAML file at <output-yaml-path>, shaped as an OTel
#     `processors.transform/categorize.log_statements` block, with one rule per
#     row (sub_domain + path match -> pbb.product, pbb.service.name).
#   - If [output-csv-path] is given, a CSV file is also written there with
#     columns: sub_domain,path_type,path_value,app,product,owner.
#
# Only hostnames ending in one of the suffixes in $CATEGORIZE_DOMAINS
# (comma-separated, default "paybybank.example") are included; sub_domain is
# the prefix before that suffix. Duplicate rows are removed.
#
# HTTPRoute resources are sorted by sub_domain, then according to the precedence
# rules in the Gateway API spec:
# https://gateway-api.sigs.k8s.io/reference/api-spec/main/spec/#httprouterule

YAML_OUTPUT="${1:?usage: $0 <output-yaml-path> [output-csv-path]}"
CSV_OUTPUT="${2:-}"

# The suffix domains this run cares about. Comma-separated; default to
# production only. Override with e.g.
# CATEGORIZE_DOMAINS=paybybank.example,pbb.test to also emit the mTLS alias.
CATEGORIZE_DOMAINS="${CATEGORIZE_DOMAINS:-paybybank.example}"
DOMAINS_JSON=$(jq -nc --arg s "$CATEGORIZE_DOMAINS" '$s | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))')
[[ "$(printf '%s' "$DOMAINS_JSON" | jq 'length')" -gt 0 ]] || {
  echo "error: CATEGORIZE_DOMAINS is empty" >&2
  exit 1
}

SERVICES=$(kubectl get services --all-namespaces -o json \
  | jq -c '
      [ .items[]
        | { key: ((.metadata.namespace // "") + "/" + (.metadata.name // ""))
          , value: (.metadata.labels["app.kubernetes.io/name"] // "")
          }
      ] | from_entries
    ')

HTTPROUTES_RESULT=$(kubectl get httproutes.gateway.networking.k8s.io --all-namespaces -o json \
  | jq --argjson services "$SERVICES" --argjson domains "$DOMAINS_JSON" '
      .items
      | map(
          . as $route
          | ($route.metadata.labels["app.kubernetes.io/name"] // "") as $routeAppLabel
          | ($route.metadata.namespace // "") as $routeNs
          | ($route.metadata.annotations["github.paybybank.example/owners"] // "") as $ownerAnn
          | ($route.metadata.annotations["sli.paybybank.example/product"] // "") as $product
          | ($route.metadata.creationTimestamp // "")   as $created
          | (($route.metadata.namespace // "") + "/" + ($route.metadata.name // "")) as $nsName
          | (($route.spec.hostnames // [])[])           as $hostname
          | (($route.spec.rules // []) | to_entries[]) as $ruleEntry
          | $ruleEntry.key                              as $ruleIdx
          | ( ($ruleEntry.value.backendRefs // [])
              | map(select(((.kind // "Service") == "Service") and ((.group // "") == "")))
              | sort_by(-(.weight // 1))
              | (.[0] // null)
            ) as $bestBackend
          | ( if $bestBackend == null then ""
              else ($bestBackend.namespace // $routeNs) + "/" + ($bestBackend.name // "")
              end
            ) as $backendKey
          | ($services[$backendKey] // "") as $serviceAppLabel
          | (if $serviceAppLabel != "" then $serviceAppLabel else $routeAppLabel end) as $appLabel
          | (($ruleEntry.value.matches // [{}])[])      as $match
          | [ $domains[] as $d
              | if $hostname == $d then ""
                elif ($hostname | endswith("." + $d)) then $hostname[:-(($d|length)+1)]
                else empty
                end
            ][0] as $rawSubDomain
          | select($rawSubDomain != null)
          | ( if   $rawSubDomain == "mtls"           then ""
              elif ($rawSubDomain | endswith(".mtls")) then $rawSubDomain[:-5]
              else $rawSubDomain
              end
            ) as $subDomain
          | ($match.path.type  // "") as $pathType
          | ($match.path.value // "") as $pathValue
          | ( if   $pathType == "Exact"             then 0
              elif $pathType == "RegularExpression" then 1
              elif $pathType == "PathPrefix"        then 2
              else 3 end
            ) as $pathRank
          | {
              ok: ($appLabel != "" and $appLabel != "envoy-gateway"),
              warning: (
                if $appLabel == "" then
                  "HTTPRoute " + $nsName + " (hostname=" + $hostname
                    + ", backend=" + (if $backendKey == "" then "<none>" else $backendKey end)
                    + "): could not resolve app.kubernetes.io/name label"
                else null end
              ),
              row: {
                sub_domain: $subDomain,
                path_type:  $pathType,
                path_value: $pathValue,
                app:        $appLabel,
                product:    $product,
                owner:      $ownerAnn
              },
              sort: [
                $subDomain,
                $pathRank,
                -($pathValue | length),
                (if $match.method then 0 else 1 end),
                -(($match.headers // []) | length),
                -(($match.queryParams // []) | length),
                $created,
                $nsName,
                $ruleIdx
              ]
            }
        )
      | sort_by(.sort)
      | {
          rows: (
            map(select(.ok) | .row)
            | reduce .[] as $r ({seen: {}, rows: []};
                ($r | tojson) as $k
                | if .seen[$k] then . else .seen[$k] = true | .rows += [$r] end
              )
            | .rows
          ),
          warnings: (map(.warning) | map(select(. != null)) | unique)
        }
    ')

printf "%s" "$HTTPROUTES_RESULT" | jq -r ".warnings[]" | while IFS= read -r line; do
  printf "warning: %s\n" "$line" >&2
done

ROWS=$(printf "%s" "$HTTPROUTES_RESULT" | jq ".rows")

if [[ -n "$CSV_OUTPUT" ]]; then
  printf '%s' "$ROWS" | jq -r '
    ["sub_domain","path_type","path_value","app","product","owner"],
    (.[] | [.sub_domain, .path_type, .path_value, .app, .product, .owner])
    | @csv
  ' > "$CSV_OUTPUT"
fi

jq -n -r \
  --argjson http "$HTTPROUTES_RESULT" '
  def render_row:
    . as $r
    | ( if   $r.path_value == "" then ""
        elif $r.path_type == "Exact" then
          " and log.attributes[\"url.path\"] == " + ($r.path_value | tojson)
        elif $r.path_type == "RegularExpression" then
          " and IsMatch(log.attributes[\"url.path\"], " + ($r.path_value | tojson) + ")"
        elif $r.path_type == "PathPrefix" then
          ( if $r.path_value == "/" then ""
            else " and IsMatch(log.attributes[\"url.path\"], " + (("^" + $r.path_value) | tojson) + ")"
            end )
        else "" end
      ) as $pathCond
    | "      - conditions:\n"
      + "          - log.attributes[\"pbb.service.name\"] == nil"
      + " and log.attributes[\"pbb.sub_domain\"] == " + ($r.sub_domain | tojson) + $pathCond + "\n"
      + "        statements:\n"
      + ( if $r.product != "" then
            "          - set(log.attributes[\"pbb.product\"], " + ($r.product | tojson) + ")\n"
          else "" end )
      + "          - set(log.attributes[\"pbb.service.name\"], " + ($r.app | tojson) + ")";

  def section(rows; comment):
    (rows | map(select(.sub_domain != ""))) as $filtered
    | ("################################################################################") as $border
    | if ($filtered | length) > 0 then
          "      " + $border + "\n"
        + "      # " + comment + "\n"
        + "      " + $border + "\n"
        + ($filtered | map(render_row) | join("\n"))
      else empty end;

  "processors:\n  # This is autogenerated via '\''just gen-categorize'\'' - do not manually edit!\n  transform/categorize:\n    log_statements:\n"
  + section($http.rows; "Generated from Gateway API HTTPRoute resources")
' > "$YAML_OUTPUT"
