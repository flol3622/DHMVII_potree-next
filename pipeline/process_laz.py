#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["laspy[lazrs]", "pyproj"]
# ///
"""
Normalize the CRS of LAS/LAZ tiles without recompressing LAS 1.4 point data.

LAS 1.4 stores CRS WKT in a record that may live after the compressed point
payload. This script therefore copies the original bytes and appends a small
EVLR instead of decoding and re-encoding every point. LAS 1.0-1.3 files use a
safe laspy rewrite fallback because inserting a VLR shifts internal LAZ offsets.

Destination writes are atomic and reruns require a WKT CRS record and the LAS
1.4 WKT global-encoding bit instead of treating any legacy GeoTIFF CRS record,
or mere file existence, as success.  This gives strict merge tools one
byte-identical CRS payload in every tile.

Copying usage:
    uv run process_laz.py <src_dir> <dst_dir> --workers 16

Optional in-place usage (fastest and uses no second full-size copy):
    uv run process_laz.py --in-place --workers 16 <src_dir>
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from itertools import islice
from pathlib import Path

import pyproj

GLOBAL_ENCODING = 6
VERSION = 24
HEADER_SIZE = 94
POINT_DATA_OFFSET = 96
NUM_VLRS = 100
START_FIRST_EVLR = 235
NUM_EVLRS = 243

VLR_HEADER_SIZE = 54
EVLR_HEADER_SIZE = 60
WKT_BIT = 1 << 4
PROJECTION_USER_ID = b"LASF_Projection"
GEOKEY_DIRECTORY_ID = 34735
OGC_WKT_ID = 2112

MIN_HEADER_SIZE = {
    (1, 0): 227,
    (1, 1): 227,
    (1, 2): 227,
    (1, 3): 235,
    (1, 4): 375,
}


@dataclass(frozen=True)
class LasInfo:
    minor: int
    global_encoding: int
    header_size: int
    point_data_offset: int
    file_size: int
    evlr_start: int
    evlr_count: int
    evlr_end: int
    crs_kind: str | None


def read_exact(stream, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ValueError(f"unexpected end of file (wanted {size} bytes)")
    return data


def inspect_las(path: Path) -> LasInfo:
    """Validate the LAS container and locate standard CRS records."""
    with path.open("rb") as stream:
        file_size = os.fstat(stream.fileno()).st_size
        # Read through the 4-byte number-of-VLRs field at byte offset 100.
        header_prefix = read_exact(stream, 104)
        if header_prefix[:4] != b"LASF":
            raise ValueError("not a LAS/LAZ file")

        major, minor = struct.unpack_from("<BB", header_prefix, VERSION)
        minimum = MIN_HEADER_SIZE.get((major, minor))
        if minimum is None:
            raise ValueError(f"unsupported LAS version {major}.{minor}")

        global_encoding = struct.unpack_from("<H", header_prefix, GLOBAL_ENCODING)[0]
        header_size = struct.unpack_from("<H", header_prefix, HEADER_SIZE)[0]
        point_data_offset = struct.unpack_from(
            "<I", header_prefix, POINT_DATA_OFFSET
        )[0]
        number_of_vlrs = struct.unpack_from("<I", header_prefix, NUM_VLRS)[0]

        if header_size < minimum:
            raise ValueError(
                f"header size {header_size} is smaller than {minimum}"
            )
        if not header_size <= point_data_offset <= file_size:
            raise ValueError(
                f"invalid point-data offset {point_data_offset} "
                f"for header {header_size} and file size {file_size}"
            )

        stream.seek(header_size)
        crs_kind = None
        for _ in range(number_of_vlrs):
            record_header = read_exact(stream, VLR_HEADER_SIZE)
            user_id = record_header[2:18].rstrip(b"\0")
            record_id, record_length = struct.unpack_from("<HH", record_header, 18)
            if user_id == PROJECTION_USER_ID:
                if record_id == OGC_WKT_ID:
                    crs_kind = "wkt"
                elif record_id == GEOKEY_DIRECTORY_ID and crs_kind is None:
                    crs_kind = "geotiff"
            stream.seek(record_length, os.SEEK_CUR)
            if stream.tell() > point_data_offset:
                raise ValueError("VLR block extends into point data")

        evlr_start = 0
        evlr_count = 0
        evlr_end = 0
        if minor >= 4:
            stream.seek(START_FIRST_EVLR)
            evlr_start, evlr_count = struct.unpack("<QI", read_exact(stream, 12))
            if evlr_count and not point_data_offset <= evlr_start < file_size:
                raise ValueError(
                    f"invalid first-EVLR offset {evlr_start} for {file_size}-byte file"
                )

            position = evlr_start
            for _ in range(evlr_count):
                stream.seek(position)
                record_header = read_exact(stream, EVLR_HEADER_SIZE)
                user_id = record_header[2:18].rstrip(b"\0")
                record_id = struct.unpack_from("<H", record_header, 18)[0]
                record_length = struct.unpack_from("<Q", record_header, 20)[0]
                position += EVLR_HEADER_SIZE + record_length
                if position > file_size:
                    raise ValueError("EVLR extends beyond end of file")
                if user_id == PROJECTION_USER_ID:
                    if record_id == OGC_WKT_ID:
                        crs_kind = "wkt"
                    elif record_id == GEOKEY_DIRECTORY_ID and crs_kind is None:
                        crs_kind = "geotiff"
            evlr_end = position

    return LasInfo(
        minor=minor,
        global_encoding=global_encoding,
        header_size=header_size,
        point_data_offset=point_data_offset,
        file_size=file_size,
        evlr_start=evlr_start,
        evlr_count=evlr_count,
        evlr_end=evlr_end,
        crs_kind=crs_kind,
    )


def has_complete_crs(path: Path) -> bool:
    try:
        info = inspect_las(path)
    except (OSError, ValueError, struct.error):
        return False
    # GeoTIFF keys can identify the same CRS, but copc_converter compares WKT
    # payloads byte-for-byte and its mixed WKT/GeoTIFF fallback is not robust
    # to every valid NUL-terminated WKT record.  Require canonical WKT on all
    # output tiles so the merge never depends on that fallback.
    return info.crs_kind == "wkt" and bool(info.global_encoding & WKT_BIT)


def build_wkt_evlr(crs: pyproj.CRS) -> bytes:
    payload = crs.to_wkt("WKT1_GDAL").encode("utf-8") + b"\0"
    return b"".join(
        (
            struct.pack("<H", 0),
            PROJECTION_USER_ID.ljust(16, b"\0"),
            struct.pack("<H", OGC_WKT_ID),
            struct.pack("<Q", len(payload)),
            b"OGC Coordinate System WKT".ljust(32, b"\0"),
            payload,
        )
    )


def flush_output(stream, durable: bool) -> None:
    stream.flush()
    if durable:
        os.fsync(stream.fileno())


def set_wkt_bit(stream, encoding: int, durable: bool) -> None:
    stream.seek(GLOBAL_ENCODING)
    stream.write(struct.pack("<H", encoding | WKT_BIT))
    flush_output(stream, durable)


def stamp_las14(path: Path, evlr: bytes, *, durable: bool) -> str:
    """Append or recover a WKT EVLR without touching compressed point bytes."""
    info = inspect_las(path)
    if info.minor < 4:
        raise ValueError("fast EVLR stamping requires LAS 1.4")

    with path.open("r+b") as stream:
        if info.crs_kind == "wkt":
            if not info.global_encoding & WKT_BIT:
                set_wkt_bit(stream, info.global_encoding, durable)
                return "repaired-wkt-bit"
            return "already-stamped"

        tail_start = info.file_size - len(evlr)
        orphan_at_tail = False
        if tail_start >= info.point_data_offset:
            stream.seek(tail_start)
            orphan_at_tail = stream.read(len(evlr)) == evlr

        if orphan_at_tail and (
            info.evlr_count == 0 or info.evlr_end == tail_start
        ):
            # A previous run made the payload durable but was killed before it
            # registered the EVLR in the header. Adopt it instead of appending.
            new_record_start = tail_start
            result = "recovered-orphan"
        else:
            if info.evlr_count and info.evlr_end != info.file_size:
                raise ValueError("cannot append after non-contiguous EVLR data")
            stream.seek(0, os.SEEK_END)
            new_record_start = stream.tell()
            stream.write(evlr)
            flush_output(stream, durable)
            result = "stamped-evlr"

        first_evlr = info.evlr_start if info.evlr_count else new_record_start
        stream.seek(START_FIRST_EVLR)
        stream.write(struct.pack("<QI", first_evlr, info.evlr_count + 1))
        flush_output(stream, durable)
        set_wkt_bit(stream, info.global_encoding, durable)
        return result


def rewrite_legacy_las(src: Path, temp_path: Path, crs: pyproj.CRS) -> str:
    """Correct fallback for LAS 1.0-1.3, where adding a VLR shifts payload."""
    import laspy

    with laspy.open(src) as reader:
        header = reader.header
        header.add_crs(crs)
        with laspy.open(temp_path, mode="w", header=header) as writer:
            for chunk in reader.chunk_iterator(100_000):
                writer.write_points(chunk)
    if not has_complete_crs(temp_path):
        raise RuntimeError("legacy LAS rewrite did not produce a complete CRS header")
    return "rewritten-legacy"


def temp_path_for(target: Path) -> Path:
    # Preserve .laz as the final suffix for the laspy legacy fallback.
    return target.with_name(f".{target.stem}.part{target.suffix}")


def process_file(
    src: Path, dst: Path | None, crs: pyproj.CRS, wkt_evlr: bytes
) -> str:
    target = src if dst is None else dst
    if dst is not None and target.exists() and has_complete_crs(target):
        return "already-stamped"

    source_info = inspect_las(src)
    if (
        dst is None
        and source_info.crs_kind == "wkt"
        and source_info.global_encoding & WKT_BIT
    ):
        return "already-stamped"
    if dst is None and source_info.minor >= 4:
        return stamp_las14(src, wkt_evlr, durable=True)

    temp_path = temp_path_for(target)
    try:
        temp_path.unlink(missing_ok=True)
        if source_info.minor >= 4:
            shutil.copyfile(src, temp_path)
            # The final name is still untouched, so fsync-per-header would only
            # add metadata latency without improving process-kill safety.
            result = stamp_las14(temp_path, wkt_evlr, durable=False)
            if result == "already-stamped":
                result = "copied-existing-crs"
        else:
            result = rewrite_legacy_las(src, temp_path, crs)

        if not has_complete_crs(temp_path):
            raise RuntimeError("output validation failed")
        os.replace(temp_path, target)
        return result
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src_dir", type=Path)
    parser.add_argument("dst_dir", type=Path, nargs="?")
    parser.add_argument("--epsg", type=int, default=31370)
    parser.add_argument("--in-place", action="store_true")
    parser.add_argument("--workers", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.in_place == bool(args.dst_dir):
        print(
            "ERROR: give either dst_dir or --in-place, but not both or neither",
            file=sys.stderr,
        )
        return 2

    workers = args.workers or min(16, os.cpu_count() or 1)
    if workers < 1:
        print("ERROR: workers must be at least 1", file=sys.stderr)
        return 2
    if not args.src_dir.is_dir():
        print(f"ERROR: source is not a directory: {args.src_dir}", file=sys.stderr)
        return 2

    if args.dst_dir:
        if args.src_dir.resolve() == args.dst_dir.resolve():
            print("ERROR: use --in-place when source and destination match", file=sys.stderr)
            return 2
        args.dst_dir.mkdir(parents=True, exist_ok=True)

    crs = pyproj.CRS.from_epsg(args.epsg)
    wkt_evlr = build_wkt_evlr(crs)
    entries = (
        path
        for path in args.src_dir.iterdir()
        if path.suffix.lower() in {".las", ".laz"}
    )
    tally: Counter[str] = Counter()
    failures: list[str] = []
    processed = 0
    batch_size = workers * 4

    with ThreadPoolExecutor(max_workers=workers) as executor:
        while batch := list(islice(entries, batch_size)):
            futures = {
                executor.submit(
                    process_file,
                    src,
                    None if args.in_place else args.dst_dir / src.name,
                    crs,
                    wkt_evlr,
                ): src
                for src in batch
            }
            for future in as_completed(futures):
                src = futures[future]
                processed += 1
                try:
                    tally[future.result()] += 1
                except Exception as exc:
                    failures.append(src.name)
                    print(f"FAILED: {src.name}: {exc}", file=sys.stderr)
                if processed % 1_000 == 0:
                    print(f"{processed:,} files processed", flush=True)

    print(f"{processed:,} files processed")
    for status, count in sorted(tally.items()):
        print(f"  {status}: {count:,}")
    if failures:
        print(f"{len(failures):,} file(s) FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
