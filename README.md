<div align="center">

# 🇧🇪 Flanders in Points

### The DHMV II LiDAR survey of Flanders, streaming in your browser. No install, no download, no desktop GIS.

**78,809** full-resolution COPC tiles + one overview · hosted by **[Flai](https://hub.flai.ai)** on **Amazon S3** · streamed as **one** model

[![License: AGPL v3](https://img.shields.io/badge/code-AGPL--3.0-blue.svg)](LICENSE)
[![Format: COPC](https://img.shields.io/badge/format-COPC-8a2be2.svg)](https://copc.io/)
[![Data: DHMV II](https://img.shields.io/badge/data-DHMV%20II-0b7285.svg)](https://remotesensing.vlaanderen.be/apps/openlidar/)
[![Hosting: Flai on Amazon S3](https://img.shields.io/badge/hosting-Flai%20%C2%B7%20Amazon%20S3-f59f00.svg)](https://hub.flai.ai/dataset/b729323b-332c-46e7-878d-acac932b1013)
[![Status: live](https://img.shields.io/badge/status-live-2b8a3e.svg)](https://flol3622.github.io/DHMVII_potree-next/)

### [▶ Open the live viewer](https://flol3622.github.io/DHMVII_potree-next/)

<!-- 📸 SCREENSHOT: hero shot. Oblique view over a city (Ghent/Antwerp), elevation colouring, map panel visible in the corner. Wide crop, ~1600px. -->
![The viewer](docs/screenshots/hero.png)

</div>

> 🌿 **You are on the `feat/flai-dhmvii-source` branch**, which is what the
> [live viewer](https://flol3622.github.io/DHMVII_potree-next/) runs. It streams
> the public COPC copy of DHMV II that [Flai](https://hub.flai.ai) publishes. The
> [`main`](https://github.com/flol3622/DHMVII_potree-next/tree/main) branch holds
> the original project: our own single-file conversion of the survey.

## 🌍 What is this?

The Netherlands has had [**ahn2.pointclouds.nl**](http://ahn2.pointclouds.nl/) since 2015 — a web page where anyone can fly through 640 billion LiDAR points of an entire country. No login, no software, no GIS degree. It is still one of the nicest pieces of open-data outreach in the field. 🇳🇱

Flanders has an equally good national LiDAR survey — **DHMV II**, flown 2013–2015 at ≥ 8 points/m² — and it is genuinely open data. What it lacked was a front door: you could download tiles, but you could not simply *look* at it. 🤷

[Flai](https://hub.flai.ai) now publishes the survey as [COPC](https://copc.io/): **78,809 full-resolution tiles** of 500 × 500 m plus a reduced-detail **overview** of all of Flanders. The files are on Amazon S3, with a public catalogue API to find them. This viewer streams that collection straight from S3 into the browser, with no backend of its own. It does so as **one coherent model**: the overview for the big picture, with full-resolution tiles taking over as you zoom in.

> 🎓 **On scope.** Every point here is public DHMV II data from Digitaal Vlaanderen, served as COPC by Flai. This repository contributes the viewer: a condensed Potree-Next build, a navigation map, clipped LAS export and the tile-streaming module described below.

## ✨ What it does

|  | |
| :-- | :-- |
| 🛰️ | **Streams all of Flanders** — HTTP range requests into COPC files on Amazon S3. Files are never copied or unpacked; each view fetches only the octree nodes it needs. |
| 🧩 | **One model from many tiles** — the overview and the full-resolution tiles form a single octree, with one point budget and one entry in the scene tree. |
| 🗺️ | **Navigation map** — an OpenStreetMap panel showing exactly where you are, where you're looking, and roughly how much ground you can see. Click it to fly there. |
| 🔎 | **Address search** — type a street or a town, land on it. Belgian Lambert 72 handled behind the scenes. |
| 🌈 | **Elevation, intensity, classification, RGB** — the full Potree material palette, plus eye-dome lighting so the surface actually reads as a surface. |
| 📏 | **Measure things** — distances, areas, heights, profiles. Potree's standard toolkit, kept intact. |
| ⬇️ | **Download a clipped volume** — the expandable **Download** menu at the bottom right exports a selected clipping box as uncompressed LAS, entirely in your browser. On this branch the export reads the **overview** only. |
| 📊 | **Live streaming stats** — visible points, visible nodes, octree depth, in-flight requests. Useful when you want to see *why* it feels fast. |
| 🗣️ | **Four languages** — English, French, Dutch, German. The Dutch translation is new here; Potree didn't ship one, which is a strange gap for a Flemish dataset. |

<!-- 📸 SCREENSHOT: the map panel, zoomed in, with the view-footprint patch and the heading arrow clearly visible. Crop tight, ~800px. -->
![Navigation map](docs/screenshots/map-panel.png)

<!-- 📸 SCREENSHOT: side-by-side or single shot of elevation colouring vs. classification colouring on the same scene. -->
![Colour modes](docs/screenshots/colour-modes.png)

## 🧩 How it works

Three moving parts, and only the third one is this repository's own code.

```
   DHMV II open LiDAR           Flai · Amazon S3                   this viewer
   Digitaal Vlaanderen          overview.copc.laz                  (browser)
   2013–2015 survey  ──────►    78,809 tile .copc.laz  ──────►     HTTP Range
                                + catalogue API                    one octree
```

### 1️⃣ The data — DHMV II

The Flemish government's second national LiDAR survey, flown 2013–2015, ≥ 8 points/m² per strip with ≥ 50 % strip overlap, published as open data by **Digitaal Vlaanderen** through [OpenLidar](https://remotesensing.vlaanderen.be/apps/openlidar/).

### 2️⃣ The hosting — Flai on Amazon S3 ☁️

[**Flai**](https://hub.flai.ai) publishes DHMV II in its [Lidar Hub](https://hub.flai.ai/dataset/b729323b-332c-46e7-878d-acac932b1013) and hosts the files in the Amazon S3 bucket `open-lidar-data` (region `eu-central-1`):

- [**Overview COPC**](https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/BE/EODaS/LiDAR_DHMV_II-2013-2015/overview/overview.copc.laz) — reduced detail of the whole survey in one file. Loaded first, and the default `VITE_POINT_CLOUD_URL`.
- **Full-resolution tiles** — one COPC file per 500 × 500 m tile, for example [`…_FU_103500_155500.copc.laz`](https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/BE/EODaS/LiDAR_DHMV_II-2013-2015/copc/LiDAR_DHMV_2_P3_ATL12338_FU_103500_155500.copc.laz).
- [**Tile catalogue API**](https://api.flai.ai/public/datasets/b729323b-332c-46e7-878d-acac932b1013/pointclouds) — paginated (`?page=2`, 200 tiles per page), with each tile's Lambert 72 (EPSG:31370) bounds. Joining `datasource_host`, `/` and `path` gives a tile's direct URL. The viewer queries it by area.

S3 serves the files with HTTP 206 byte ranges and `Access-Control-Allow-Origin: *`, which is all a COPC client needs. This deployment depends on that external host staying available.

[**COPC**](https://copc.io/) (Cloud Optimized Point Cloud) is *just a LAZ 1.4 file* — but the points inside are laid out as a clustered octree, with the hierarchy stored in a VLR. A client reads a header and a hierarchy page, then requests exactly the byte ranges for the nodes in view. Any web server or object store that speaks HTTP range requests is a point cloud server.

### 3️⃣ The viewer 👁️

A heavily condensed and re-skinned build of [**m-schuetz/Potree-Next**](https://github.com/m-schuetz/Potree-Next), Markus Schütz's rewrite of Potree — **the piece that made COPC usable inside Potree at all.**

What lives here is not a fork in the git sense. The upstream tree was reduced to the runtime a single deployment needs, and the history did not survive the import (see [Provenance](#-provenance)). On top of that sits a small application layer: DHMV crop and camera, the status panel, the map, clipped LAS export, a Vite build — and the tile-streaming module below.

#### Tiled COPC: `src/tiled-copc/`

A reusable module for any dataset made of an overview COPC plus a catalogue of COPC tiles:

```js
import { createTiledCopc, flaiCatalogue, staticCatalogue } from "./tiled-copc/index.js";

createTiledCopc({
  viewer,
  overview, // A loaded Potree COPC point cloud.
  catalogue: flaiCatalogue({ datasetId, crs: "EPSG:31370" }),
  // or: staticCatalogue([{ url, extent: [minX, minY, minZ, maxX, maxY, maxZ] }, …])
  onStatus: ({ wanted, loaded, drawing, failed }) => {},
});
```

Its design follows [Flai's Lidar Hub viewer](https://hub.flai.ai), which builds a quadtree over tile footprints and hides overview points where a loaded tile covers them. The design was studied; no Flai code is included. This module adds the following:

- **One octree:** each tile is a subtree of the overview. A small patch in `public/vendor/potree/potree.js` (`isSubtree`) gives tile roots the same screen-size test, priority and shared point budget as child nodes. Tiles therefore refine and fade with the model instead of forming a fixed set of the nearest tiles.
- **Overview replacement:** the overview's shader discards its points inside tiles that are drawing (`material.maskBoxes`, a fixed 64-box array that avoids recompiles). Its traversal also skips nodes that such tiles fully replace (`skipNode`), so hidden points do not use the point budget. Elsewhere the overview keeps all of its levels.
- **Streaming:** the catalogue is cached per cell (4 km for Flai). Tiles the point budget would cut are not fetched, and up to 256 tiles stay cached. Catalogue requests back off for 5 s after a failure.
- **Single model:** tiles mirror the overview's material settings and share its single scene-tree entry.

## 🚀 Try it

The [live viewer](https://flol3622.github.io/DHMVII_potree-next/) is this branch, built by [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) on every push.

To run it locally, you need **Node.js** `^20.19.0` or `>=22.12.0` and npm. No point-cloud download is required:

```bash
npm install && npm run dev
```

Open <http://localhost:5173> and you're flying. 🛫 Zoom in anywhere in Flanders and full-resolution tiles stream in.

To view a different COPC instead of Flai's overview, set it in `.env`. Full-resolution tile streaming only runs for the default Flai overview:

```dotenv
VITE_POINT_CLOUD_URL=https://data.example.org/your-cloud.copc.laz
# or the small bundled test file, served with Range support by the dev server:
VITE_POINT_CLOUD_URL=pointclouds/test.copc.laz
```

The host must support `GET`, `HEAD`, and single byte ranges. Cross-origin? It also needs to allow the `Range` request header and expose `Accept-Ranges`, `Content-Length`, and `Content-Range` through CORS.

### Downloading a clipped volume

Open **Download** at the bottom right, choose an existing clipping box or click
**Create clipping box**, and place it on the point cloud. Select the box in the
viewer to move, rotate or resize it, then click **Download clipped volume (.las)**.
The hidden whole-Flanders crop is excluded from the box picker.

On this branch the export reads the **Flai overview**, not the full-resolution
tiles; the download menu says so. For full detail of an area, download its
tiles from the [Flai dataset page](https://hub.flai.ai/dataset/b729323b-332c-46e7-878d-acac932b1013)
or read them directly with any COPC reader.

Export reads every intersecting COPC level, including parent-level points, so the
result contains all source points inside the selected box regardless of the camera,
display filters, clipping display mode or point budget. The selected box's transform
is captured at the start. Other boxes and polygon clips do not affect this export.
Original coordinates, coordinate reference metadata and all point-record attributes
(including extra bytes) are preserved. The output is a regular, uncompressed LAS 1.4
file; COPC indexes and compression metadata are removed and point counts, bounds,
return counts and metadata offsets are updated.

Decoding and clipping run in a dedicated browser worker with progress and a
**Cancel export** button. No export service or uploads are needed. Exports are
limited to 256 MiB to keep browser memory bounded; shrink the box if it exceeds
that limit. **Save LAS again** remains available if the browser blocks the automatic
download. `npm test` checks real COPC extraction, attribute preservation, rotated
boxes, complete hierarchy traversal, metadata, range-request failures and the
tile-streaming helpers.

<details>
<summary>📦 <b>Building the static site</b></summary>

```bash
npm run build && npm run preview
```

Output lands in `dist/`, and that directory is the entire website — the point clouds stay on Amazon S3.

`VITE_BASE_PATH=./` keeps the bundle portable between a domain root and a subdirectory; the Pages workflow sets `/DHMVII_potree-next/`. See [.env.example](.env.example).

</details>

## 🗂️ Repository layout

```text
.
├── index.html            # Vite entry point
├── src/                  # the DHMV-specific layer — main.js, map.js, config.js, styles
│   └── tiled-copc/       # overview + tile catalogue streaming as one model
├── public/vendor/        # retained Potree runtime (with local patches) + browser libraries
├── pointclouds/          # small local test COPC
├── tests/                # node:test suites and fixtures
├── docs/screenshots/     # images used by this README
├── .github/workflows/    # GitHub Pages deployment of this branch
└── vite.config.js        # static build + local Range middleware
```

> ⚠️ Potree resolves its workers, GUI fragments, translations, icons, and textures *relative to `potree.js` at runtime*. Keep the structure inside `public/vendor/potree/` intact.

## 🙏 Credits

This project is mostly other people's excellent work, glued together with intent. In rough order of "how badly would this break without you":

| Who | What | Licence |
| :-- | :-- | :-- |
| 🏛️ **[Digitaal Vlaanderen](https://remotesensing.vlaanderen.be/apps/openlidar/)** | The DHMV II survey itself — flown, processed, and *released openly*. None of this is possible with closed data. | [Gratis Open Data Licentie Vlaanderen](https://assets.vlaanderen.be/image/upload/v1679331485/GratisopendatalicentieVlaanderenv12_bqxu2t.pdf), attribution required |
| ☁️ **[Flai](https://hub.flai.ai)** | The COPC tiles, the overview and the catalogue API used here, hosted on Amazon S3. Their Lidar Hub viewer inspired the design of `src/tiled-copc/`. | Service of Flai; see their terms at [hub.flai.ai](https://hub.flai.ai) |
| 📐 **[Hobu, Inc.](https://copc.io/)** — Andrew Bell, Howard Butler, Connor Manning | The COPC specification. Range requests into plain files, no special server. | Open specification |
| 🌲 **[Markus Schütz](https://github.com/m-schuetz/Potree-Next)** | Potree and Potree-Next — over a decade of making massive point clouds render in a browser, and the COPC support this viewer is built on. | AGPL-3.0 |
| 🇳🇱 **[NLeSC / TU Delft](https://github.com/NLeSC/ahn-pointcloud-viewer)** | ahn2.pointclouds.nl, the thing we're trying to match. Proof that this is worth doing. | — |

Also quietly essential: 🗺️ **OpenStreetMap** contributors (base map, ODbL), 🔍 **Photon**/Komoot (geocoding), and the browser libraries under `public/vendor/libs/` — OpenLayers, proj4js, jQuery, jQuery UI, jsTree, d3, spectrum, tween.js, i18next, copc.js, laz-perf.

## 🎓 Funding & acknowledgements

<a href="https://www.ugent.be/en"><img src="docs/logos/ugent.png" alt="Ghent University" height="80" align="left" hspace="20" vspace="6"></a>

**This work has been (partially) funded by the Flanders AI Research program.**

Carried out at **Ghent University**.

<br clear="left">

## ⚖️ Licence

Short version: **the code is [AGPL-3.0-only](LICENSE). The data is not ours to license, and the hosting is not ours either.** Those are separate questions and it matters that they stay separate.

### The code 🔒

This viewer is a derivative of Potree-Next, which is **AGPL-3.0** (Copyright 2021 Markus Schütz). AGPL is *strong copyleft*, so this was never a menu we got to pick from — a derivative of AGPL software is AGPL software. The root [LICENSE](LICENSE) is carried over from upstream unchanged, and `package.json` declares the SPDX identifier `AGPL-3.0-only`.

The part worth understanding is **AGPL § 13**, the clause that separates AGPL from plain GPL:

> If you run a modified version on a server and let users interact with it **over a network**, you must offer those users the source of your modified version.

For a normal library that clause rarely fires. For a *web viewer* it fires every single time someone loads the page. Deploying this publicly is exactly the trigger — which is why this repository is public, why the live viewer links to this branch's source, and why any fork that goes online must publish its source too. Schütz [chose AGPL deliberately](LICENSE) to close the SaaS loophole; that choice propagates here, and we think it's the right one for a publicly funded dataset anyway. 👍

Everything in this repository that is *not* under `public/vendor/` — the DHMV integration layer and the tile-streaming module in [`src/`](src/) — is original work released under the same AGPL-3.0-only terms.

<details>
<summary>📚 <b>The vendored components (they keep their own licences)</b></summary>

AGPL's copyleft applies to *this* work; it does not retroactively relicense third-party code we merely bundle. Permissive licences combine into an AGPL work fine — the obligation is to preserve their notices, which is why every licence file stays beside its code.

| Component | Licence | Notice |
| :-- | :-- | :-- |
| Classic Potree 1.8 runtime, with local patches marked `Local patch` (`isSubtree`, `skipNode`, `maskBoxes`) | BSD-2-Clause © 2011–2020 Markus Schütz | `public/vendor/potree/LICENSE` |
| Potree math adapted from three.js | MIT | per-file headers |
| OpenLayers 3 | BSD-2-Clause | `libs/openlayers3/LICENSE` |
| proj4js | MIT-style | `libs/proj4/LICENSE.md` |
| d3 | BSD-3-Clause © Michael Bostock | `libs/d3/LICENSE` |
| jQuery 3.1.1 | MIT © jQuery Foundation | `libs/jquery/LICENSE.txt` |
| jQuery UI | MIT © jQuery Foundation | `libs/jquery-ui/LICENSE.txt` |
| jsTree | MIT © Ivan Bozhanov | `libs/jstree/LICENSE-MIT` |
| spectrum | MIT © Brian Grinstead | `libs/spectrum/LICENSE` |
| tween.js | MIT | `libs/tween/LICENSE.txt` |
| i18next 1.8.0 | MIT © Jan Mühlemann | `libs/i18next/LICENSE` |
| copc.js | MIT © Connor Manning | `libs/copc/LICENSE` + file banner |
| laz-perf 0.0.7 (npm, export worker decoder) | Apache-2.0 | `libs/laz-perf/LICENSE` |
| BinaryHeap | MIT © Marijn Haverbeke | header in `libs/other/BinaryHeap.js` |

MIT requires the full permission text to travel with the code, not just a
one-line pointer. Three vendored builds shipped without it — copc.js had no
notice at all, while i18next and jQuery carried only a short banner — so each
now has the verbatim upstream licence beside it, and the minified copc.js
bundle gained a `/*! … */` banner of its own. Each file records which upstream
tag its text came from. ✅

</details>

### The data and its hosting 🗺️

**The AGPL does not cover the point cloud, and cannot.** DHMV II is the Flemish government's data, released by Digitaal Vlaanderen under the [Gratis Open Data Licentie Vlaanderen](https://assets.vlaanderen.be/image/upload/v1679331485/GratisopendatalicentieVlaanderenv12_bqxu2t.pdf) (the licence Flai's dataset page links to), whose core condition is **attribution to the data owner** on any distribution or publication.

The COPC files this viewer streams are published and hosted by **Flai** on **Amazon S3**. This repository neither copies nor redistributes them; your browser reads them directly from Flai's bucket. So:

- ✅ Use, fly through, screenshot, cite. Attribute **Digitaal Vlaanderen / DHMV II**, and credit **Flai** for the hosted COPC.
- 📋 Check the current terms at the [source](https://remotesensing.vlaanderen.be/apps/openlidar/) before you redistribute a derived point cloud, and Flai's terms at [hub.flai.ai](https://hub.flai.ai) for use of their hosting and API. The sources are the authority, not this README.
- 🗺️ Map tiles are © OpenStreetMap contributors (ODbL); the attribution stays visible in the map panel, please leave it there.

**Suggested attribution** for anything built on this:

> Point cloud: DHMV II, © Digitaal Vlaanderen, open data (Gratis Open Data Licentie Vlaanderen). COPC hosting: Flai (hub.flai.ai), on Amazon S3. Viewer: Flanders in Points, AGPL-3.0, derived from Potree-Next (Markus Schütz). Format: COPC (Hobu, Inc.).

## 🔍 Provenance

Three things about this repository are worth stating:

**The upstream history is gone.** Potree-Next was imported by reduction, not by fork. The git history and upstream remote did not come along, and no revision file was kept — so the exact upstream commit this started from **is not recorded**.

**The runtime isn't pure Potree-Next.** The surviving bundle pairs the COPC loader with classic Potree 1.8-compatible runtime and GUI assets. That is why the deployed API is `Potree.Viewer`, why the bundle reports version 1.8.0, and why the layout looks nothing like the WebGPU-focused upstream source tree. The *provenance* is Potree-Next; the *composition* is a hybrid.

**The vendored Potree 1.8 runtime is patched.** Tile streaming needs three small changes in `public/vendor/potree/potree.js`, each marked `Local patch`: subtree LOD (`isSubtree`), node pruning (`skipNode`) and overview masking (`maskBoxes`).

<div align="center">

<!-- 📸 SCREENSHOT: something beautiful. A cathedral, a harbour crane, a forest canopy — one place that makes the resolution obvious. -->
![Detail](docs/screenshots/detail.png)

**78,809 tiles. One model. A browser tab.** 🎈

*Built at Ghent University on public data, standing on a lot of other people's shoulders.*

</div>
