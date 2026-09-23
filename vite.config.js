import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const localPointCloudRoute = "/pointclouds/test.copc.laz";
const localPointCloudPath = path.join(projectRoot, "pointclouds", "test.copc.laz");

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match) return null;

  let start;
  let end;

  if (match[1] === "") {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === "" ? size - 1 : Number.parseInt(match[2], 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function pointCloudMiddleware(request, response, next) {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!pathname.endsWith(localPointCloudRoute)) {
    next();
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" });
    response.end();
    return;
  }

  void fs
    .stat(localPointCloudPath)
    .then((stat) => {
      if (!stat.isFile()) {
        const error = new Error("Local COPC path is not a file");
        error.code = "ENOENT";
        throw error;
      }

      const headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "application/octet-stream",
      };
      const rangeHeader = request.headers.range;

      if (rangeHeader) {
        const range = parseRange(rangeHeader, stat.size);
        if (!range) {
          response.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
          response.end();
          return;
        }

        const contentLength = range.end - range.start + 1;
        response.writeHead(206, {
          ...headers,
          "Content-Length": contentLength,
          "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        });
        if (request.method === "HEAD") response.end();
        else createReadStream(localPointCloudPath, range).pipe(response);
        return;
      }

      response.writeHead(200, { ...headers, "Content-Length": stat.size });
      if (request.method === "HEAD") response.end();
      else createReadStream(localPointCloudPath).pipe(response);
    })
    .catch((error) => {
      const message = error?.code === "ENOENT" ? "Local COPC file not found\n" : "Could not read local COPC file\n";
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(message);
    });
}

function localPointCloudPlugin() {
  const installMiddleware = (server) => {
    server.middlewares.use(pointCloudMiddleware);
  };

  return {
    name: "local-point-cloud",
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "VITE_");

  return {
    base: env.VITE_BASE_PATH || "./",
    plugins: [localPointCloudPlugin()],
  };
});
