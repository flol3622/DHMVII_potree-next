#!/bin/bash
#PBS -N merge_laz_BE
#PBS -l nodes=1:ppn=50
#PBS -l vmem=360gb
#PBS -l walltime=48:00:00

# Merge every reprojected tile into the single COPC file the viewer streams.
# The converter is external-memory: it spills to --temp-dir, so that directory
# needs several times the size of the input collection, and the run is watched
# by a resource monitor because disk and inode exhaustion are the usual causes
# of failure at this scale.

set -Eeuo pipefail

WORK="${WORK:-$HOME/DHMV_2}"
source "${PIPELINE_DIR:-$WORK/pipeline}/config.sh"

INPUT_DIR="$WORK/rawpoints_flat_BE"
OUT_DIR="$BIG_STORAGE/copc"
RUN_ID="${PBS_JOBID:-manual_$$}"
JOB_NAME="${PBS_JOBNAME:-merge_laz_BE}"
LOCAL_TMP="$BIG_STORAGE/temp/$RUN_ID"
OUTPUT_FINAL="$OUT_DIR/test.copc.laz"
OUTPUT_PARTIAL="$OUT_DIR/.test.copc.laz.$RUN_ID.partial"
LOG="$PIPELINE_DIR/resource_usage_${RUN_ID}.log"

JOB_PID=""
MONITOR_PID=""

stop_monitor() {
  if [[ -n "$MONITOR_PID" ]]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
    MONITOR_PID=""
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP

  if [[ -n "$JOB_PID" ]] && kill -0 "$JOB_PID" 2>/dev/null; then
    kill "$JOB_PID" 2>/dev/null || true
    wait "$JOB_PID" 2>/dev/null || true
  fi
  stop_monitor

  # These paths are unique to this job, so an interrupted run cannot pollute
  # the next submission or leave a partial file looking like final output.
  rm -rf -- "$LOCAL_TMP" \
    || echo "WARNING: could not remove temporary directory: $LOCAL_TMP" >&2
  rm -f -- "$OUTPUT_PARTIAL" \
    || echo "WARNING: could not remove partial output: $OUTPUT_PARTIAL" >&2

  echo
  echo "Resource log: $LOG"
  if [[ "$status" -eq 0 ]]; then
    notify 5 "Job $JOB_NAME ended ✅ output: $OUTPUT_FINAL log: $LOG"
  else
    notify 5 "Job $JOB_NAME failed (exit $status) ❌ log: $LOG"
  fi

  exit "$status"
}

handle_signal() {
  local signal_name=$1
  local exit_code=$2
  echo "Received $signal_name; stopping converter and cleaning job-scoped files" >&2
  exit "$exit_code"
}

trap cleanup EXIT
trap 'handle_signal HUP 129' HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

mkdir -p "$LOCAL_TMP" "$OUT_DIR"

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "ERROR: input directory does not exist: $INPUT_DIR" >&2
  exit 2
fi

FIRST_INPUT=$(find "$INPUT_DIR" -maxdepth 1 -type f \
  \( -iname '*.laz' -o -iname '*.las' \) -print -quit)
if [[ -z "$FIRST_INPUT" ]]; then
  echo "ERROR: no LAS/LAZ inputs found in: $INPUT_DIR" >&2
  exit 2
fi

cd "$WORK"

# copc_converter is a Rust binary; load the toolchain module if the site
# provides one. Set CONVERTER_MODULE="" when the binary is already on PATH.
CONVERTER_MODULE="${CONVERTER_MODULE-Rust}"
if [[ -n "$CONVERTER_MODULE" ]] && command -v module >/dev/null 2>&1; then
  module load "$CONVERTER_MODULE"
fi

echo "=== copc_converter version ==="
copc_converter --version
echo "copc_converter path: $(command -v copc_converter)"
echo "input: $INPUT_DIR"
echo "partial output: $OUTPUT_PARTIAL"
echo "final output: $OUTPUT_FINAL"
echo "temporary directory: $LOCAL_TMP"
echo "=============================="
echo

# The source files emit one benign EVLR-to-VLR warning per tile. Suppress those
# hundreds of thousands of duplicate lines while retaining converter errors.
export RUST_LOG="${RUST_LOG:-error}"

notify 5 "Job $JOB_NAME started 🚀"

copc_converter "$INPUT_DIR" "$OUTPUT_PARTIAL" \
  --memory-limit "${CONVERTER_MEMORY_LIMIT:-300G}" \
  --threads "${CONVERTER_THREADS:-48}" \
  --temp-dir "$LOCAL_TMP" \
  --node-storage packed \
  --temp-compression lz4 \
  --progress plain &
JOB_PID=$!

bash "$PIPELINE_DIR/record_job_resources.sh" "$JOB_PID" "$LOG" "$BIG_STORAGE" 5 &
MONITOR_PID=$!

# `wait` must be allowed to return non-zero so cleanup and notification still run.
set +e
wait "$JOB_PID"
JOB_EXIT=$?
set -e
JOB_PID=""
stop_monitor

if [[ "$JOB_EXIT" -ne 0 ]]; then
  echo "ERROR: copc_converter exited with status $JOB_EXIT" >&2
  exit "$JOB_EXIT"
fi

if [[ ! -s "$OUTPUT_PARTIAL" ]]; then
  echo "ERROR: converter exited successfully but produced no output" >&2
  exit 1
fi

# Publish only a complete converter output under the final name.
mv -f -- "$OUTPUT_PARTIAL" "$OUTPUT_FINAL"
