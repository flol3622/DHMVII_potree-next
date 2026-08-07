# Shared configuration for the DHMV II -> COPC pipeline.
#
# This file is sourced by the job scripts. Every value can be overridden from
# the environment before submission, so the pipeline carries no site-specific
# account names, cluster paths, or notification topics.
#
#   WORK          working area: downloads, reprojected tiles, pipeline scripts
#   BIG_STORAGE   storage with enough quota for conversion scratch and output
#                 (a few times the size of the input collection)
#   PIPELINE_DIR  directory holding these scripts
#   NTFY_TOPIC    ntfy.sh topic for job notifications; empty disables them

WORK="${WORK:-$HOME/DHMV_2}"
BIG_STORAGE="${BIG_STORAGE:-$WORK}"
PIPELINE_DIR="${PIPELINE_DIR:-$WORK/pipeline}"
NTFY_TOPIC="${NTFY_TOPIC:-}"

# Send a job notification if a topic is configured. Never fails the job.
notify() {
  local priority="$1"
  shift
  [[ -n "$NTFY_TOPIC" ]] || return 0
  curl -fsS -H "p:$priority" -d "$*" "ntfy.sh/$NTFY_TOPIC" >/dev/null || true
}
