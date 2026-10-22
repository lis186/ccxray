#!/usr/bin/env bash
set -u

# NPM_AUDIT_CMD is a shell command so local checks can substitute a fake npm.
audit_cmd=${NPM_AUDIT_CMD:-npm audit --audit-level=high}
read -r -a waits <<< "${AUDIT_RETRY_WAITS:-30 60}"
output=$(mktemp) || exit 1
trap 'rm -f "$output"' EXIT

for attempt in 1 2 3; do
  echo "npm audit attempt $attempt/3 (240s limit)"
  timeout --kill-after=10s 240s bash -c "$audit_cmd" 2>&1 | tee "$output"
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  # Match HTTP status contexts, not advisory counts such as '503 vulnerabilities'.
  if [ "$status" -ne 124 ] && [ "$status" -ne 137 ] && ! grep -Eiq \
    'HTTP(/[0-9.]+)?[[:space:]]+5[0-9]{2}|audit[[:space:]]+5[0-9]{2}|E5[0-9]{2}|5[0-9]{2}[[:space:]]+(Service Unavailable|Internal Server Error|Bad Gateway|Gateway Timeout)|audit endpoint returned an error|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket[[:space:]]+(timeout|timed out)' "$output"; then
    exit "$status"
  fi

  if [ "$attempt" -eq 3 ]; then
    echo "npm audit service failed after 3 attempts (last exit: $status)." >&2
    exit "$status"
  fi
  wait_seconds=${waits[$((attempt - 1))]}
  echo "npm audit service failure (exit $status); retrying in ${wait_seconds}s." >&2
  sleep "$wait_seconds" || exit 1
done
