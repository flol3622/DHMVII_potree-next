# DHMV Potree Next viewer

Minimal runtime-only Potree viewer for the local 3.3 TB COPC. The cloud is read directly with HTTP byte-range requests; it is not copied or converted.

## Run

```bash
npm start
```

Open <http://localhost:1234>. No `npm install` or build step is needed.

Set a different port when needed:

```bash
PORT=5176 npm start
```

## Data link

`pointclouds/rawpoints_flat_BE.copc.laz` is a relative symbolic link to:

```text
../../copc/rawpoints_flat_BE.copc.laz
```

If the source COPC moves, recreate that link. The server intentionally supports `206 Partial Content`, which is required for efficient COPC streaming.

## Kept runtime

- `examples/dhmv.html`: the complete viewer page and restyled full Potree sidebar
- `build/potree/`: compiled Potree runtime, GUI templates/resources, and COPC worker
- `libs/`: only the browser libraries required by Potree's default GUI and COPC loader
- `server.mjs`: dependency-free static/range server
- `pointclouds/`: only the link to the DHMV COPC

The full Appearance, Tools, Scene, Filters, and About panels remain available. The original Potree source, unrelated demos, sample clouds, build tooling, package dependencies, and Git history were deliberately removed.
