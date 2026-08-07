#!/bin/bash
#PBS -N download_unzip_flatten_tileset
#PBS -l nodes=1:ppn=1
#PBS -l walltime=70:00:00

# Download every DHMV II tile archive listed in tiles.txt, verify it, extract
# it, and flatten all LAS/LAZ files into a single directory. Each archive is
# deleted right after extraction so peak disk usage stays close to the size of
# the extracted point data rather than twice that.

set -uo pipefail

WORK="${WORK:-$HOME/DHMV_2}"
source "${PIPELINE_DIR:-$WORK/pipeline}/config.sh"

TILES="$PIPELINE_DIR/tiles.txt"
RAWPOINTS="$WORK/rawpoints"
FLAT="$WORK/rawpoints_flat"
FAILED="$WORK/failed_downloads.txt"

mkdir -p "$RAWPOINTS" "$FLAT"
: > "$FAILED"

while IFS= read -r url || [[ -n "$url" ]]; do
    [[ -z "$url" || "$url" == \#* ]] && continue

    tarname=$(basename "$url")
    tarpath="$RAWPOINTS/$tarname"

    echo "==> Downloading $tarname"
    if ! aria2c --dir="$RAWPOINTS" --out="$tarname" "$url"; then
        echo "FAILED download: $tarname" | tee -a "$FAILED"
        continue
    fi

    echo "==> Testing $tarname"
    if ! tar -tf "$tarpath" > /dev/null; then
        echo "FAILED corrupt tar: $tarname" | tee -a "$FAILED"
        rm -f "$tarpath"
        continue
    fi

    echo "==> Extracting $tarname"
    if ! tar -xf "$tarpath" -C "$RAWPOINTS"; then
        echo "FAILED extraction: $tarname" | tee -a "$FAILED"
        continue
    fi

    echo "==> Flattening extracted files"
    find "$RAWPOINTS" -type f \( -iname "*.laz" -o -iname "*.las" \) -exec mv -t "$FLAT" {} +

    rm "$tarpath"
    find "$RAWPOINTS" -type d -empty -delete

    echo "Files in flat so far: $(find "$FLAT" -type f | wc -l)"
done < "$TILES"

echo "==> Done"
echo "Failed files:"
cat "$FAILED"

# Chain the next stage. Set CHAIN_NEXT=0 to submit it by hand instead.
if [[ "${CHAIN_NEXT:-1}" == "1" ]]; then
    cd "$PIPELINE_DIR" && qsub 01_projection.sh
fi

notify 3 "Job ${PBS_JOBNAME:-download_unzip_flatten_tileset} ended ✅"

