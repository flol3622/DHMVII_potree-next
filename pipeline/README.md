# How the DHMV COPC was produced

The viewer streams a single file, `rawpoints_flat_BE.copc.laz`, built from the
public **DHMV II** (Digitaal Hoogtemodel Vlaanderen II) LiDAR release. This
directory holds the scripts that produced it, kept in the repository so the
dataset behind the viewer is reproducible rather than a black box.

The work ran on a PBS/Torque HPC cluster. Nothing here is tied to that site:
paths, notification topic, and module names come from
[`config.sh`](config.sh) and can all be overridden from the environment. The
`#PBS` directives are the resources the real run requested and are a useful
indication of the scale involved; on another scheduler they are inert comments.

## Scale

The source release is roughly 42 tile archives covering Flanders, expanding to
hundreds of thousands of LAZ tiles and about 3.3 TB of point data in the merged
COPC. Every stage is written with that in mind: bounded batches, no
whole-collection listings held in memory, atomic publication of outputs, and
resumability after a job hits its walltime.

## Stages

| Stage | Script | What it does |
| --- | --- | --- |
| 0 | [`00_download.sh`](00_download.sh) | Downloads each tile archive from [`tiles.txt`](tiles.txt), verifies the tar, extracts it, flattens all LAS/LAZ into one directory, and deletes the archive immediately so peak disk stays near the extracted size. |
| 1 | [`01_projection.sh`](01_projection.sh) → [`process_laz.py`](process_laz.py) | Normalizes the CRS of every tile to EPSG:31370 (Belgian Lambert 72). |
| 2 | [`02_convert.sh`](02_convert.sh) → `copc_converter` | Merges all tiles into one COPC file. |

Stage 0 submits stage 1 on completion (`CHAIN_NEXT=0` disables that). Stage 2
was submitted by hand after the header check below came back clean.

### Why the CRS stage exists

The merge tool compares CRS payloads byte-for-byte and refuses tiles that
disagree. The source tiles are inconsistent: some carry GeoTIFF projection
keys, some carry WKT, some carry neither, and the LAS 1.4 WKT global-encoding
bit is not reliably set.

`process_laz.py` gives every tile one byte-identical WKT record. The
interesting part is that it does **not** decode and re-encode points. In LAS
1.4 the CRS record may live in an EVLR after the compressed point payload, so
the script copies the original bytes, appends a small WKT EVLR, and patches the
two header fields that describe it. Inserting a *VLR* would shift the internal
LAZ chunk offsets, so LAS 1.0–1.3 files instead take a slower and correct
laspy rewrite path.

Writes are atomic and reruns are cheap: a tile counts as done only when it has
a WKT record *and* the WKT global-encoding bit, so a partially stamped tile
from a killed job is detected and either adopted or redone, never trusted on
the basis of mere file existence.

### Helper scripts

- [`check_laz.py`](check_laz.py) — scans headers of a tile directory and
  reports (optionally quarantines) truncated or malformed files. A handful of
  tiles in the download were corrupt; the merge fails on the first bad file, so
  this ran before stage 2.
- [`recover_failed_laz.py`](recover_failed_laz.py) — re-derives the source URL
  from a quarantined tile's basename, re-downloads it, reads its full
  compressed point stream to prove it is intact, normalizes it, and installs it
  back with hard-link-then-unlink so an existing merge input can never be
  clobbered.
- [`record_job_resources.sh`](record_job_resources.sh) — samples RSS, CPU, and
  the disk and inode fill level of the spill storage every 5 seconds during the
  merge. Inodes, not bytes, were the limit that bit first.

## The merge itself

Stage 2 runs `copc_converter`, an external-memory Rust converter, with a 300 GB
memory limit, 48 threads, packed node storage, and lz4-compressed spill files.
Because it is external-memory, `--temp-dir` must point at storage several times
the size of the input collection — on the real run that was a separate
high-quota filesystem, which is what `BIG_STORAGE` selects.

The output is written under a job-scoped `.partial` name and renamed into place
only after the converter exits cleanly with a non-empty file, so a killed job
can never leave something that looks like a finished point cloud. Signal traps
remove the spill directory and the partial file on any exit path.

## What the merge actually cost

Numbers below come from the resource log of the production run (job 27467852,
50 cores requested, 360 GB vmem, 42 tile archives in), sampled every 5 seconds.

| | |
| --- | --- |
| Wall time | **21.5 h** (of a 48 h walltime request) |
| CPU consumed | **372 core-hours** — 35% of the 1072 core-hours reserved |
| Peak RSS | **26 GiB** — 9% of the 300 GB `--memory-limit` |
| Peak spill usage | **+20 points** of the shared filesystem's capacity |
| Inodes | 83% → 85% of a filesystem already near its inode limit |

The run has three clearly separated phases, and they behave nothing alike:

| Phase | Hours | Cores | RSS | Spill |
| --- | --- | --- | --- | --- |
| Read and chunk tiles | 0–7 | 30–42 | ≤ 10 GiB | 53% → 67%, climbing fast |
| Sort / index | 7–12 | **~2** | 0.9 GiB | 67% → 72%, still climbing |
| Build and write the octree | 12–21.5 | 10–14 | 16–26 GiB | drops to 68% as spill is consumed |

Three things follow from that shape, and they are the reason this log is worth
keeping:

- **The job is not CPU-bound.** Only the first third saturates the node. The
  five-hour middle phase runs at roughly two cores — a quarter of the walltime
  spent using 4% of the reservation — and the long final phase never exceeds
  14. Reserving 50 cores buys nothing after hour 7; the wall time is set by
  storage throughput, not core count.
- **The memory request was an order of magnitude too large.** A 300 GB limit
  and a 360 GB vmem reservation against a 26 GiB peak. The converter is
  external-memory by design, so raising the limit does not speed it up — it
  just makes the job harder to schedule.
- **Storage is the real constraint.** Spill peaks around hour 12, at the
  handover between sorting and writing, when the temp files and the growing
  output coexist. Budget `--temp-dir` for that moment, not for the average. The
  filesystem was also at 83% inodes before the job started: on a shared
  cluster the headroom you have is whatever the other users leave you, which is
  exactly why `record_job_resources.sh` samples `df -i` alongside memory.

Two caveats when reading the raw log. Its `cpu_percent` column comes from
`ps -o %cpu`, which is a **lifetime average**, not an instantaneous rate — the
per-phase core counts above were recovered by differencing cumulative CPU time,
and the raw column looks like a smooth decay if taken at face value. And
`rss_kb` is the converter process only, while the disk columns describe a
filesystem shared with other jobs.

Job stdout/stderr and the resource logs are gitignored; only these distilled
figures are kept in the repository.

## Running it

```bash
export WORK=/path/to/scratch/DHMV_2          # downloads + reprojected tiles
export BIG_STORAGE=/path/to/high-quota/DHMV_2 # spill space + final COPC
export NTFY_TOPIC=my-topic                    # optional job notifications

cd "$WORK/pipeline"
qsub 00_download.sh
```

Requirements are `aria2c`, `tar`, [`uv`](https://docs.astral.sh/uv/) (the
Python scripts declare their own dependencies inline, so no environment setup
is needed), and `copc_converter` on `PATH` for stage 2.

The resulting `copc/rawpoints_flat_BE.copc.laz` is what the viewer points at;
see the main [README](../README.md) for how it is served.

## Data source and licence

Tiles come from the Flemish government's open LiDAR distribution at
`remotesensing.vlaanderen.be`. Check the current terms of that release before
redistributing derived point clouds.
