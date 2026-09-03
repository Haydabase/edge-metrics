#!/usr/bin/env bash

# Shared test helpers for all .bats files.
# Requires setup.bash to have been loaded first (provides CF_PORT, ENVOY_PORT, PROM_PORT, OUTPUT_DIR).

run_test() {
  if [ -z "$1" ]; then
    echo "No receiver port"
    exit 1
  fi
  receiver_port=$1
  test_folder="$TEST_DIR/$BATS_TEST_DESCRIPTION"

  # Use the test name as the unique ray ID for matching output lines
  RAY_ID="$BATS_TEST_DESCRIPTION"

  # Capture metrics before test for comparison
  curl -s http://localhost:$PROM_PORT/metrics > $BATS_TEST_TMPDIR/metrics-before.txt

  echo "Sending test log to port $receiver_port..." >&3

  # Send OTLP log to collector and capture response
  HTTP_RESPONSE=$(mktemp)
  HTTP_CODE=$(curl -X POST \
    -H "Content-Type: application/json" \
    -d @${test_folder}/input.json \
    http://localhost:$receiver_port/v1/logs \
    -s -w "%{http_code}" \
    -o "$HTTP_RESPONSE")

  echo "HTTP Status: $HTTP_CODE" >&3
  HTTP_BODY=$(cat "$HTTP_RESPONSE")
  rm -f "$HTTP_RESPONSE"

  # Assert HTTP 200 response
  if [ "$HTTP_CODE" != "200" ]; then
    echo "ERROR: Expected HTTP 200, got $HTTP_CODE" >&3
    echo "Response body: $HTTP_BODY" >&3
    return 1
  fi

  # Check if we expect output
  if [[ -f "${test_folder}/expected-edge.json" ]]; then
    echo "Validating edge log output..." >&3

    # Poll for our output line (identified by unique ray ID) instead of fixed sleep
    RETRIES=0
    MAX_RETRIES=10
    while ! grep -q "$RAY_ID" $OUTPUT_DIR/edge.jsonl 2>/dev/null; do
      RETRIES=$((RETRIES + 1))
      if [ $RETRIES -ge $MAX_RETRIES ]; then
        echo "ERROR: Output line with ray ID '$RAY_ID' not found after ${MAX_RETRIES}s" >&3
        echo "edge.jsonl contents:" >&3
        cat $OUTPUT_DIR/edge.jsonl >&3
        return 1
      fi
      sleep 1
    done
    echo "Found output after ${RETRIES}s" >&3

    # Extract our specific line by ray ID
    grep "$RAY_ID" $OUTPUT_DIR/edge.jsonl > ${test_folder}/actual-edge.json

    # Verify exactly one matching line
    MATCH_COUNT=$(wc -l < ${test_folder}/actual-edge.json)
    if [ $MATCH_COUNT -ne 1 ]; then
      echo "ERROR: Expected 1 matching line for ray ID '$RAY_ID', got $MATCH_COUNT" >&3
      return 1
    fi

    # Compare with expected (use -setkeys to treat attribute arrays as sets by "key" field)
    jd -setkeys key ${test_folder}/expected-edge.json ${test_folder}/actual-edge.json
  else
    echo "No edge log expected (filtered test)" >&3

    # Wait briefly then verify our ray ID does NOT appear in output
    sleep 3
    if grep -q "$RAY_ID" $OUTPUT_DIR/edge.jsonl 2>/dev/null; then
      echo "ERROR: Found unexpected output for ray ID '$RAY_ID' (should have been filtered)" >&3
      grep "$RAY_ID" $OUTPUT_DIR/edge.jsonl >&3
      return 1
    fi

    echo "Correctly filtered (no output)" >&3
  fi

  # Validate metrics if expected file exists
  if [[ -f "${test_folder}/expected-metrics.txt" ]]; then
    echo "Validating Prometheus metrics..." >&3

    # Fetch metrics
    curl -s http://localhost:$PROM_PORT/metrics > $BATS_TEST_TMPDIR/actual-metrics.txt

    # Check each expected metric line has incremented by exactly 1
    while IFS= read -r expected_metric; do
      # Skip empty lines and comments
      [[ -z "$expected_metric" || "$expected_metric" =~ ^# ]] && continue

      echo "Looking for: $expected_metric" >&3
      BEFORE_VAL=$(grep -F "$expected_metric" $BATS_TEST_TMPDIR/metrics-before.txt | awk '{print $NF+0}' || echo 0)
      AFTER_VAL=$(grep -F "$expected_metric" $BATS_TEST_TMPDIR/actual-metrics.txt | awk '{print $NF+0}')

      if [ -z "$AFTER_VAL" ]; then
        echo "ERROR: Expected metric not found: $expected_metric" >&3
        echo "Available metrics:" >&3
        grep "http_edge" $BATS_TEST_TMPDIR/actual-metrics.txt | head -20 >&3
        return 1
      fi

      echo "  Before: $BEFORE_VAL, After: $AFTER_VAL" >&3
      INCREMENT=$((AFTER_VAL - BEFORE_VAL))
      if [ "$INCREMENT" -ne 1 ]; then
        echo "ERROR: Expected metric to increment by 1, but got $INCREMENT (before=$BEFORE_VAL, after=$AFTER_VAL): $expected_metric" >&3
        return 1
      fi
    done < ${test_folder}/expected-metrics.txt

    echo "All metrics validated successfully" >&3
  else
    echo "Verifying no metrics changes..." >&3

    curl -s http://localhost:$PROM_PORT/metrics > $BATS_TEST_TMPDIR/actual-metrics.txt

    BEFORE_HTTP_EDGE=$(grep "^http_edge_" $BATS_TEST_TMPDIR/metrics-before.txt | sort || true)
    AFTER_HTTP_EDGE=$(grep "^http_edge_" $BATS_TEST_TMPDIR/actual-metrics.txt | sort || true)

    if [ "$BEFORE_HTTP_EDGE" != "$AFTER_HTTP_EDGE" ]; then
      echo "ERROR: Unexpected metrics changes detected" >&3
      diff <(echo "$BEFORE_HTTP_EDGE") <(echo "$AFTER_HTTP_EDGE") >&3
      return 1
    fi

    echo "No metrics changes (as expected)" >&3
  fi
}

run_cloudflare_test() {
  run_test $CF_PORT
}

run_envoy_test() {
  run_test $ENVOY_PORT
}
