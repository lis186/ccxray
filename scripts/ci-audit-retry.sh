#!/usr/bin/env bash
set -u

# NPM_AUDIT_CMD is a shell command so local checks can substitute a fake npm.
audit_cmd=${NPM_AUDIT_CMD:-npm audit --audit-level=high --fetch-timeout=60000 --fetch-retries=1}
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

  # Retry only npm service errors, never a completed advisory report.
  service_re='^npm (warn|WARN|error|ERR!) (audit 5[0-9]{2} |audit endpoint returned an error|code (E5[0-9]{2}|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$|errno (ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$|network )'
  report_re='^# npm audit report|^[0-9]+ (low|moderate|high|critical) severity vulnerabilit|^[0-9]+ vulnerabilities \('
  if [ "$status" -ne 124 ] && [ "$status" -ne 137 ] &&
     { grep -Eq "$report_re" "$output" || ! grep -Eq "$service_re" "$output"; }; then
    exit "$status"
  fi

  if [ "$attempt" -eq 3 ]; then
    echo "npm audit service failed after 3 attempts (last exit: $status)." >&2
    exit "$status"
  fi
  wait_seconds=${waits[$((attempt - 1))]:-60}
  echo "npm audit service failure (exit $status); retrying in ${wait_seconds}s." >&2
  sleep "$wait_seconds" || exit 1
done
