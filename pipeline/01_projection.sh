#!/bin/bash
#PBS -N projection_tileset
#PBS -l nodes=1:ppn=16
#PBS -l walltime=24:00:00

# Give every tile one byte-identical EPSG:31370 WKT CRS record, so the merge
# step never has to reconcile mixed or missing CRS descriptions.

set -uo pipefail

WORK="${WORK:-$HOME/DHMV_2}"
source "${PIPELINE_DIR:-$WORK/pipeline}/config.sh"

SRC="$WORK/rawpoints_flat"
DST="$WORK/rawpoints_flat_BE"

uv run "$PIPELINE_DIR/process_laz.py" "$SRC" "$DST" --workers "${PBS_NUM_PPN:-16}"
JOB_EXIT=$?

if [ "$JOB_EXIT" -eq 0 ]; then
  notify 3 "Job ${PBS_JOBNAME:-projection_tileset} ended ✅"
else
  notify 5 "Job ${PBS_JOBNAME:-projection_tileset} failed (exit $JOB_EXIT) ❌"
fi

exit "$JOB_EXIT"
