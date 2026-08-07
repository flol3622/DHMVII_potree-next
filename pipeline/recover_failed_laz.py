#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["laspy[lazrs]", "pyproj"]
# ///
"""Redownload, validate, normalize, and atomically restore quarantined LAZ tiles.

The Vlaanderen Open LiDAR tile URL is derived from the exact basename.  Files
are downloaded to staging and their complete compressed point streams are read
before any installation begins.  Installation uses hard-link-then-unlink so an
existing merge-input basename can never be overwritten, even in a race.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import struct
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

import laspy
import pyproj

from process_laz import build_wkt_evlr, process_file


DEFAULT_BASE_URL = (
    "https://remotesensing.vlaanderen.be/download/openlidar/"
    "LiDAR_DHMV_2_V2"
)
TILE_NAME = re.compile(
    r"^(?P<strip>LiDAR_DHMV_2_(?P<phase>P\d+)_(?P<atlas>ATL\d+)_.+)"
    r"_-?\d+_-?\d+\.laz$",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("failed_dir", type=Path)
    parser.add_argument("stage_dir", type=Path)
    parser.add_argument("target_dir", type=Path)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--epsg", type=int, default=31370)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    return parser.parse_args()


def tile_url(name: str, base_url: str) -> str:
    match = TILE_NAME.fullmatch(name)
    if not match:
        raise ValueError(f"cannot derive Vlaanderen tile URL from {name!r}")
    return "/".join(
        (
            base_url.rstrip("/"),
            quote(match.group("phase")),
            quote(match.group("atlas")),
            quote(match.group("strip")),
            "Tiles",
            quote(name),
        )
    )


def download_one(name: str, url: str, download_dir: Path) -> tuple[str, str]:
    destination = download_dir / name
    if destination.exists() and destination.stat().st_size:
        return name, "already-downloaded"

    partial = destination.with_name(f".{destination.name}.part")
    command = [
        "curl",
        "--fail",
        "--location",
        "--retry",
        "5",
        "--retry-delay",
        "2",
        "--retry-all-errors",
        "--connect-timeout",
        "30",
        "--max-time",
        "1800",
        "--silent",
        "--show-error",
        "--output",
        str(partial),
        url,
    ]
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode:
        detail = result.stderr.strip() or f"curl exit {result.returncode}"
        raise RuntimeError(f"{name}: {detail}")
    if not partial.exists() or not partial.stat().st_size:
        raise RuntimeError(f"{name}: server returned an empty file")
    os.replace(partial, destination)
    return name, "downloaded"


def wkt_payloads(header: laspy.LasHeader) -> list[bytes]:
    records = list(header.vlrs) + list(header.evlrs or [])
    return [
        record.record_data_bytes()
        for record in records
        if record.user_id.rstrip("\0") == "LASF_Projection"
        and record.record_id == 2112
    ]


def validate_full_laz(
    path: Path,
    *,
    expected_crs: pyproj.CRS | None = None,
    expected_wkt: bytes | None = None,
) -> int:
    with laspy.open(path) as reader:
        expected_points = int(reader.header.point_count)
        actual_points = 0
        for points in reader.chunk_iterator(1_000_000):
            actual_points += len(points)
        if actual_points != expected_points:
            raise ValueError(
                f"point-count mismatch: header={expected_points:,}, "
                f"decoded={actual_points:,}"
            )

        if expected_crs is not None:
            parsed = reader.header.parse_crs()
            if parsed is None or not parsed.equals(expected_crs):
                raise ValueError(f"CRS is not {expected_crs.to_string()}")
        if expected_wkt is not None:
            payloads = wkt_payloads(reader.header)
            if not payloads:
                raise ValueError("canonical WKT record is missing")
            if any(payload != expected_wkt for payload in payloads):
                raise ValueError("WKT payload is not canonical")
            if not int(reader.header.global_encoding.value) & (1 << 4):
                raise ValueError("LAS WKT global-encoding bit is not set")
    return actual_points


def validate_many(
    paths: list[Path],
    workers: int,
    *,
    expected_crs: pyproj.CRS | None = None,
    expected_wkt: bytes | None = None,
) -> tuple[int, int]:
    failures: list[str] = []
    total_points = 0
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                validate_full_laz,
                path,
                expected_crs=expected_crs,
                expected_wkt=expected_wkt,
            ): path
            for path in paths
        }
        for future in as_completed(futures):
            path = futures[future]
            done += 1
            try:
                total_points += future.result()
            except Exception as exc:
                failures.append(f"{path.name}: {exc}")
            if done % 20 == 0 or done == len(paths):
                print(f"  {done}/{len(paths)} validated", flush=True)
    if failures:
        for failure in failures:
            print(f"FAILED: {failure}", file=sys.stderr)
        raise RuntimeError(f"{len(failures)} file(s) failed full validation")
    return len(paths), total_points


def repair_las14_counts(source: Path, destination: Path) -> tuple[int, int]:
    """Repair a producer bug that copied a strip-wide count into each tile.

    The affected files retain correct legacy point/return counts and complete
    compressed point streams.  Only LAS 1.4's extended count fields are
    changed; bytes from the end of the 375-byte header onward remain identical.
    """
    temporary = destination.with_name(f".{destination.name}.part")
    temporary.unlink(missing_ok=True)
    shutil.copyfile(source, temporary)
    try:
        with temporary.open("r+b") as stream:
            header = stream.read(375)
            if len(header) < 375 or header[:4] != b"LASF":
                raise ValueError("not a complete LAS 1.4 header")
            if (header[24], header[25]) != (1, 4):
                raise ValueError("count repair is restricted to LAS 1.4")
            point_format = header[104] & 0x3F
            if point_format > 5:
                raise ValueError(
                    "legacy count repair is restricted to point formats 0-5"
                )

            legacy_count = struct.unpack_from("<I", header, 107)[0]
            legacy_returns = struct.unpack_from("<5I", header, 111)
            extended_count = struct.unpack_from("<Q", header, 247)[0]
            if not legacy_count:
                raise ValueError("legacy point count is zero")
            if sum(legacy_returns) != legacy_count:
                raise ValueError(
                    "legacy return counts do not sum to legacy point count"
                )
            if extended_count == legacy_count:
                raise ValueError("extended count already matches legacy count")

            stream.seek(247)
            stream.write(struct.pack("<Q", legacy_count))
            stream.write(struct.pack("<15Q", *legacy_returns, *([0] * 10)))
            stream.flush()
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return extended_count, legacy_count


def prepare_source(
    downloaded: Path, repaired_dir: Path
) -> tuple[Path, int, str]:
    """Fully validate a download, repairing the known count bug if needed."""
    try:
        points = validate_full_laz(downloaded)
        return downloaded, points, "valid"
    except Exception as original_error:
        repaired = repaired_dir / downloaded.name
        try:
            old_count, new_count = repair_las14_counts(downloaded, repaired)
            points = validate_full_laz(repaired)
        except Exception as repair_error:
            raise RuntimeError(
                f"decode failed ({original_error}); count repair failed "
                f"({repair_error})"
            ) from repair_error
        if points != new_count:
            raise RuntimeError(
                f"repaired header declares {new_count:,} points but decoded "
                f"{points:,}"
            )
        return repaired, points, f"repaired-count:{old_count}->{new_count}"


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        print("ERROR: --workers must be at least 1", file=sys.stderr)
        return 2
    if not args.failed_dir.is_dir():
        print(f"ERROR: failed directory does not exist: {args.failed_dir}", file=sys.stderr)
        return 2
    if not args.target_dir.is_dir():
        print(f"ERROR: target directory does not exist: {args.target_dir}", file=sys.stderr)
        return 2

    names = sorted(
        path.name
        for path in args.failed_dir.iterdir()
        if path.suffix.lower() == ".laz"
    )
    if not names:
        print("ERROR: no quarantined LAZ files found", file=sys.stderr)
        return 2
    urls = {name: tile_url(name, args.base_url) for name in names}

    download_dir = args.stage_dir / "downloaded"
    repaired_dir = args.stage_dir / "repaired_sources"
    normalized_dir = args.stage_dir / "normalized"
    download_dir.mkdir(parents=True, exist_ok=True)
    repaired_dir.mkdir(parents=True, exist_ok=True)
    normalized_dir.mkdir(parents=True, exist_ok=True)

    # A valid pre-existing target is treated as an already completed recovery;
    # it is never overwritten.  An invalid conflict stops the entire run.
    crs = pyproj.CRS.from_epsg(args.epsg)
    expected_wkt = crs.to_wkt("WKT1_GDAL").encode("utf-8") + b"\0"
    outstanding: list[str] = []
    preexisting: list[str] = []
    for name in names:
        target = args.target_dir / name
        if target.exists():
            try:
                validate_full_laz(
                    target, expected_crs=crs, expected_wkt=expected_wkt
                )
            except Exception as exc:
                raise RuntimeError(
                    f"refusing to overwrite invalid existing target {name}: {exc}"
                ) from exc
            preexisting.append(name)
        else:
            outstanding.append(name)

    print(
        f"Recovery manifest: {len(names)} tile(s); "
        f"{len(preexisting)} already installed; {len(outstanding)} outstanding"
    )

    print(f"Downloading {len(outstanding)} tile(s) with {args.workers} workers")
    download_failures: list[str] = []
    completed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(download_one, name, urls[name], download_dir): name
            for name in outstanding
        }
        for future in as_completed(futures):
            completed += 1
            try:
                name, status = future.result()
                print(f"  [{completed}/{len(outstanding)}] {status}: {name}")
            except Exception as exc:
                download_failures.append(str(exc))
                print(f"  [{completed}/{len(outstanding)}] FAILED: {exc}", file=sys.stderr)
    if download_failures:
        raise RuntimeError(f"{len(download_failures)} download(s) failed")

    print("Fully decoding downloaded point streams")
    source_paths: dict[str, Path] = {}
    source_points = 0
    source_status: Counter[str] = Counter()
    source_failures: list[str] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                prepare_source, download_dir / name, repaired_dir
            ): name
            for name in outstanding
        }
        completed = 0
        for future in as_completed(futures):
            name = futures[future]
            completed += 1
            try:
                source, points, status = future.result()
                source_paths[name] = source
                source_points += points
                source_status[status.split(":", 1)[0]] += 1
                if status != "valid":
                    print(f"  repaired {name}: {status}")
            except Exception as exc:
                source_failures.append(f"{name}: {exc}")
            if completed % 20 == 0 or completed == len(outstanding):
                print(f"  {completed}/{len(outstanding)} decoded", flush=True)
    if source_failures:
        for failure in source_failures:
            print(f"FAILED: {failure}", file=sys.stderr)
        raise RuntimeError(f"{len(source_failures)} source file(s) unrecoverable")
    print(
        f"Downloaded sources valid: {source_points:,} points; "
        f"status={dict(source_status)}"
    )

    print("Adding canonical CRS metadata without recompressing point data")
    wkt_evlr = build_wkt_evlr(crs)
    normalize_failures: list[str] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                process_file,
                source_paths[name],
                normalized_dir / name,
                crs,
                wkt_evlr,
            ): name
            for name in outstanding
        }
        for future in as_completed(futures):
            name = futures[future]
            try:
                future.result()
            except Exception as exc:
                normalize_failures.append(f"{name}: {exc}")
    if normalize_failures:
        for failure in normalize_failures:
            print(f"FAILED: {failure}", file=sys.stderr)
        raise RuntimeError(f"{len(normalize_failures)} normalization(s) failed")

    normalized = [normalized_dir / name for name in outstanding]
    print("Fully validating normalized recovery set before installation")
    _, normalized_points = validate_many(
        normalized,
        args.workers,
        expected_crs=crs,
        expected_wkt=expected_wkt,
    )
    if normalized_points != source_points:
        raise RuntimeError(
            f"normalization changed point count: {source_points:,} -> "
            f"{normalized_points:,}"
        )

    # All-or-nothing prevalidation is complete.  link() is atomic and refuses
    # to replace an existing basename; unlinking staging leaves one directory
    # entry for the recovered inode in the merge input.
    print(f"Atomically installing {len(outstanding)} validated tile(s)")
    installed: list[Path] = []
    try:
        for name in outstanding:
            source = normalized_dir / name
            target = args.target_dir / name
            os.link(source, target)
            source.unlink()
            installed.append(target)
    except Exception:
        print(
            f"Installation stopped after {len(installed)} file(s); rerunning is safe",
            file=sys.stderr,
        )
        raise

    print("Verifying installed files")
    _, installed_points = validate_many(
        installed,
        args.workers,
        expected_crs=crs,
        expected_wkt=expected_wkt,
    )
    if installed_points != source_points:
        raise RuntimeError("installed point total differs from downloaded sources")

    target_count = sum(
        1
        for path in args.target_dir.iterdir()
        if path.suffix.lower() in {".las", ".laz"}
    )
    print(
        f"RECOVERY COMPLETE: {len(outstanding)} installed, "
        f"{len(preexisting)} already present, {installed_points:,} points verified; "
        f"target contains {target_count:,} LAS/LAZ files"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
