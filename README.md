# DHMV Potree-Next viewer

This repository is a heavily cleaned-up, project-specific derivative of [Potree-Next](https://github.com/m-schuetz/Potree-Next), Markus Schütz's rewrite of Potree. It adapts that work to one purpose: streaming and viewing the 3.3 TB DHMV COPC point cloud.

## Where the code came from

The starting point was the upstream **Potree-Next rewrite**, not a new viewer written specifically for DHMV. This repository is not maintained as a conventional Git fork: it was reduced to the small runtime deployment needed for this dataset.

That cleanup removed most of the recognizable upstream project:

- the original Potree-Next Git history and upstream remote;
- the complete source tree and upstream build tooling;
- unrelated examples, experimental renderers, development tools, and sample data; and
- resources and dependencies not needed by the DHMV deployment.

The cleanup retained and reorganized only the browser assets needed by the resulting viewer, then added a small DHMV-specific application layer. Because the import did not preserve upstream history or a revision file, the exact Potree-Next commit used as the starting point is not recorded in this repository.

## Current runtime composition

The cleaned viewer is not a file-for-file copy of today's Potree-Next tree. Its retained browser bundle includes classic Potree 1.8-compatible runtime and GUI assets alongside the COPC loader:

- `public/vendor/potree/` contains the prebuilt viewer runtime, default GUI, workers, icons, translations, and textures;
- `public/vendor/libs/copc/` contains the COPC JavaScript library used for hierarchy and range loading; and
- the other directories under `public/vendor/libs/` contain the browser dependencies required by the retained GUI.

This explains why the deployed API uses `Potree.Viewer`, why the bundle reports Potree 1.8.0 at runtime, and why the repository layout differs substantially from the full WebGPU-focused Potree-Next source repository. Those details describe the surviving cleaned runtime; the project provenance remains Potree-Next.

## What was added for DHMV

The code outside `public/vendor/` is the local integration and deployment layer. It:

- loads `rawpoints_flat_BE.copc.laz` directly through HTTP byte-range requests;
- configures the DHMV crop, initial camera, point budget, material, and EDL rendering;
- adds the DHMV status and metrics panel while retaining Potree's standard sidebar;
- packages the viewer as a Vite static site; and
- adds development and preview middleware that serves the local COPC with `206 Partial Content` responses.

The COPC is never copied into the application bundle. Potree requests only the hierarchy and point ranges needed for the current view.

## Licensing and attribution

This Potree-Next derivative is distributed under the **GNU Affero General Public License v3**. The root [LICENSE](LICENSE) is copied from the upstream Potree-Next repository, and the package metadata uses the SPDX identifier `AGPL-3.0-only`.

Vendored components remain under their respective licenses. In particular, the retained classic Potree runtime carries its BSD 2-Clause license in `public/vendor/potree/LICENSE`; the other bundled libraries keep their license files beside their code.

## Local development

Requirements are Node.js `^20.19.0` or `>=22.12.0`, npm, and a local COPC link at `pointclouds/rawpoints_flat_BE.copc.laz`.

Install the locked dependencies and start Vite:

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

The local dataset is gitignored. If its location changes, recreate the symlink:

```bash
mkdir -p pointclouds
ln -s ../../copc/rawpoints_flat_BE.copc.laz pointclouds/rawpoints_flat_BE.copc.laz
```

## Static build

Create and test the deployable site:

```bash
npm run build
npm run preview
```

The output is written to `dist/`. Only that directory is deployed as the website. The point cloud must be hosted separately or mounted by the production web server at `pointclouds/rawpoints_flat_BE.copc.laz`, relative to `index.html`.

For an external data host, create `.env.production` or provide this value in the build environment:

```dotenv
VITE_POINT_CLOUD_URL=https://data.example.org/rawpoints_flat_BE.copc.laz
```

The data host must support `GET`, `HEAD`, and single HTTP byte ranges. For a different origin, it must also allow the `Range` request header and expose `Accept-Ranges`, `Content-Length`, and `Content-Range` through CORS.

The default `VITE_BASE_PATH=./` makes the bundle portable to a domain root or subdirectory. Set a fixed base such as `/potree-next-viewer/` when the deployment platform requires one. See [.env.example](.env.example) for both build settings.

## Repository layout

```text
.
├── index.html             # Vite HTML entry point
├── src/                   # DHMV-specific integration code and styles
├── public/vendor/         # Runtime assets retained during the upstream cleanup
├── pointclouds/           # Local-only COPC link; excluded from builds and Git
├── vite.config.js         # Static build plus local Range middleware
└── dist/                  # Generated static site; not committed
```

Potree resolves workers, GUI fragments, translations, icons, and textures relative to `potree.js` at runtime. Keep the structure inside `public/vendor/potree/` intact when updating or deploying the upstream runtime.
