#!/usr/bin/env bash
# Transcribe Bench - entry point.
#
# Defaults: runs against cached transcripts in TRANSCRIBE_BENCH_CACHE_DIR, or
# the repo-adjacent transcribe-bench-cache directory, with the local Cortex server
# (http://localhost:4000) as the LLM-judge backend.
#
#   ./run.sh                     # all providers, cached, judge=gemini-pro-31-vision
#   ./run.sh --live --audioUrl https://...   # call Cortex live for configured pathways
#   ./run.sh --judge claude-46-opus-vertex   # different judge
#   ./run.sh --reference trint               # pin reference
#   ./run.sh --output myrun.md               # custom output path

set -euo pipefail
cd "$(dirname "$0")"

# Sanity-check the cortex GraphQL endpoint before doing real work.
CORTEX_URL="${CORTEX_URL:-http://localhost:4000/graphql}"
if ! curl -sf -X POST "$CORTEX_URL" -H 'Content-Type: application/json' \
        -d '{"query":"{ __typename }"}' > /dev/null; then
    echo "ERROR Cortex not reachable at $CORTEX_URL - start it and retry." >&2
    exit 1
fi

exec node bench.mjs "$@"
