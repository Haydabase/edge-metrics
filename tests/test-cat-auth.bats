#!/usr/bin/env bats

PORT_OFFSET=40
load helpers/setup
load helpers/common

# The new taxonomy sets pbb.product="Auth" unconditionally for any POST to
# auth.<domain>/connect/token, regardless of pbb.operation_subtype - there is
# no more subtype-based split between "Auth" and "DataAuth".

@test "cloudflare-cat-auth" {
  run_cloudflare_test
}

@test "envoy-cat-auth" {
  run_envoy_test
}
