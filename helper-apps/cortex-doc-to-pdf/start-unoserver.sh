#!/bin/bash
set -euo pipefail

RPC_PORT=${UNOSERVER_RPC_PORT:-2003}
UNO_PORT=${UNOSERVER_UNO_PORT:-2002}
PROFILE_DIR=${UNO_PROFILE_DIR:-/tmp/uno-profile}
HOST=${UNOSERVER_HOST:-127.0.0.1}

log() { echo "[start-unoserver] $*"; }

# Ensure Python can locate LibreOffice UNO bindings
export PYTHONPATH="/usr/lib/python3/dist-packages:${PYTHONPATH:-}"
export UNO_PROFILE_DIR="${PROFILE_DIR}"

log "Preparing LibreOffice profile at ${PROFILE_DIR}"
rm -rf "${PROFILE_DIR}"
mkdir -p "${PROFILE_DIR}"
chmod -R 777 "${PROFILE_DIR}" || true

cleanup() {
  if [[ -n "${UNO_PID:-}" ]]; then
    kill "${UNO_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Starting unoserver (RPC:${RPC_PORT}, UNO:${UNO_PORT})"
unoserver \
  --interface "${HOST}" \
  --port "${RPC_PORT}" \
  --uno-interface "${HOST}" \
  --uno-port "${UNO_PORT}" \
  --user-installation "${PROFILE_DIR}" \
  --conversion-timeout 120 &
UNO_PID=$!

for _ in {1..80}; do
  status=$(python3 - <<PY 2>/dev/null
import socket
s=socket.socket(); s.settimeout(0.25)
print('OK' if s.connect_ex(('${HOST}', ${RPC_PORT}))==0 else 'WAIT')
PY
)
  if [[ "$status" == "OK" ]]; then
    log "unoserver is ready"
    break
  fi
  if ! kill -0 "${UNO_PID}" 2>/dev/null; then
    log "unoserver exited unexpectedly"; exit 1
  fi
  sleep 0.1
done

TMP_DIR=$(mktemp -d)
log "Warm-up conversions"
cat >"${TMP_DIR}/warmup.txt" <<'EOF'
Warmup text
EOF
printf "1,2\n3,4\n" > "${TMP_DIR}/warmup.csv"
printf "<html><body>Warmup</body></html>" > "${TMP_DIR}/warmup.html"
set +e
unoconvert --host-location local --port "${RPC_PORT}" "${TMP_DIR}/warmup.txt" "${TMP_DIR}/warmup.txt.pdf" >/dev/null 2>&1
unoconvert --host-location local --port "${RPC_PORT}" "${TMP_DIR}/warmup.csv" "${TMP_DIR}/warmup.csv.pdf" >/dev/null 2>&1
unoconvert --host-location local --port "${RPC_PORT}" "${TMP_DIR}/warmup.html" "${TMP_DIR}/warmup.html.pdf" >/dev/null 2>&1
set -e
rm -rf "${TMP_DIR}"
log "Warm-up complete"

export PORT=${PORT:-8080}
log "Starting function_app.py on port ${PORT}"
exec python function_app.py
