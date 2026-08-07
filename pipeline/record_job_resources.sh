#!/bin/bash

# Usage:
#   record_job_resources.sh <pid> <logfile> [scratch_path] [interval_seconds]
#
# Samples memory, CPU, and the disk/inode fill level of the storage the
# converter spills into, which is what actually runs out during a large merge.
#
# Example:
#   record_job_resources.sh 12345 /path/to/resource_usage.log /path/to/scratch 5

PID="$1"
LOG="$2"
SCRATCH="${3:-$PWD}"
INTERVAL="${4:-5}"

if [ -z "$PID" ] || [ -z "$LOG" ]; then
  echo "Usage: $0 <pid> <logfile> [scratch_path] [interval_seconds]"
  exit 1
fi

mkdir -p "$(dirname "$LOG")"

# Note: cpu_percent comes from `ps -o %cpu`, which reports the process
# lifetime average, not an instantaneous rate. To recover per-phase CPU use,
# difference cumulative CPU time (cpu_percent/100 * elapsed) between samples.
echo "timestamp,rss_kb,vsz_kb,cpu_percent,inodes_used_percent,disk_used_percent" > "$LOG"

while kill -0 "$PID" 2>/dev/null; do
  TS=$(date +%s)

  LINE=$(ps -p "$PID" -o rss=,vsz=,%cpu= 2>/dev/null | awk '{print $1","$2","$3}')
  if [ -z "$LINE" ]; then
    break
  fi

  RSS=$(echo "$LINE" | cut -d, -f1)
  VSZ=$(echo "$LINE" | cut -d, -f2)
  CPU=$(echo "$LINE" | cut -d, -f3)

  INODES=$(df -i "$SCRATCH" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
  DISK=$(df "$SCRATCH" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')

  [ -z "$INODES" ] && INODES="NaN"
  [ -z "$DISK" ] && DISK="NaN"

  echo "$TS,$RSS,$VSZ,$CPU,$INODES,$DISK" >> "$LOG"

  sleep "$INTERVAL"
done
