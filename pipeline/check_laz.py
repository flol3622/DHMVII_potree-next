#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tqdm"]
# ///
"""
Scan LAZ/LAS files and report incomplete or malformed headers.

Use --quarantine to move bad files out of the input directory without
overwriting any existing quarantined file.
"""

import argparse
import os
import shutil
import struct
import sys
from concurrent.futures import ThreadPoolExecutor
from itertools import islice
from pathlib import Path

from tqdm import tqdm

MIN_HEADER_SIZE = {
    (1, 0): 227,
    (1, 1): 227,
    (1, 2): 227,
    (1, 3): 235,
    (1, 4): 375,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="directory of LAS/LAZ tiles to scan")
    parser.add_argument(
        "--quarantine",
        type=Path,
        help="move malformed files to this directory after scanning",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(64, os.cpu_count() or 1),
        help="parallel header reads (default: up to 64)",
    )
    return parser.parse_args()


def header_error(path: Path) -> str | None:
    try:
        with path.open("rb") as stream:
            header = stream.read(375)
            size = os.fstat(stream.fileno()).st_size
    except OSError as exc:
        return f"read error: {exc}"

    if len(header) < 100:
        return f"file too small ({len(header)} bytes)"
    if header[:4] != b"LASF":
        return f"bad signature {header[:4]!r}"

    version = (header[24], header[25])
    minimum = MIN_HEADER_SIZE.get(version)
    if minimum is None:
        return f"unsupported LAS version {version[0]}.{version[1]}"

    header_size = struct.unpack_from("<H", header, 94)[0]
    point_data_offset = struct.unpack_from("<I", header, 96)[0]
    if header_size < minimum:
        return f"header size {header_size} is smaller than {minimum}"
    if point_data_offset < header_size:
        return (
            f"point-data offset {point_data_offset} is smaller than "
            f"header size {header_size}"
        )
    if point_data_offset > size:
        return f"point-data offset {point_data_offset} exceeds file size {size}"

    return None


def main() -> int:
    args = parse_args()
    scan_dir = args.directory

    if not scan_dir.is_dir():
        print(f"ERROR: not a directory: {scan_dir}", file=sys.stderr)
        return 2
    if args.workers < 1:
        print("ERROR: --workers must be at least 1", file=sys.stderr)
        return 2

    if args.quarantine:
        args.quarantine.mkdir(parents=True, exist_ok=True)

    failed: list[tuple[Path, str]] = []
    quarantine_failures = 0
    total = 0
    entries = (
        path
        for path in scan_dir.iterdir()
        if path.suffix.lower() in {".las", ".laz"}
    )

    # Submit bounded batches: parallel reads hide filesystem latency without
    # allocating one Future for every file in very large tile collections.
    batch_size = args.workers * 8
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        with tqdm(unit="file", desc="Checking LAS/LAZ headers") as progress:
            while batch := list(islice(entries, batch_size)):
                for laz, reason in zip(batch, executor.map(header_error, batch)):
                    total += 1
                    progress.update()
                    if reason:
                        failed.append((laz, reason))
                        tqdm.write(f"FAIL  {laz.name}: {reason}")
                        if args.quarantine:
                            destination = args.quarantine / laz.name
                            if destination.exists():
                                quarantine_failures += 1
                                tqdm.write(
                                    f"      not moved: destination exists: {destination}"
                                )
                            else:
                                try:
                                    shutil.move(laz, destination)
                                    tqdm.write(f"      moved to: {destination}")
                                except OSError as exc:
                                    quarantine_failures += 1
                                    tqdm.write(f"      move failed: {exc}")

    print(f"\nCorrupt files: {len(failed):,} / {total:,}")

    return 1 if failed and (not args.quarantine or quarantine_failures) else 0


if __name__ == "__main__":
    sys.exit(main())
