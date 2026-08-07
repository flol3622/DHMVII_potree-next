import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT || "1234", 10);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".laz", "application/octet-stream"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  const pathname = url.pathname === "/" ? "/examples/dhmv.html" : decodeURIComponent(url.pathname);
  const relativePath = path.normalize(pathname).replace(/^[/\\]+/, "");
  const filePath = path.join(root, relativePath);

  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the viewer root");
  }

  return filePath;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
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

const server = createServer(async (request, response) => {
  try {
    const filePath = resolveRequestPath(request.url || "/");
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");

    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600",
      "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    };

    const requestedRange = request.headers.range;
    if (requestedRange) {
      const range = parseRange(requestedRange, stat.size);
      if (!range) {
        response.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
        response.end();
        return;
      }

      const length = range.end - range.start + 1;
      response.writeHead(206, {
        ...headers,
        "Content-Length": length,
        "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath, range).pipe(response);
      return;
    }

    response.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`DHMV Potree viewer: http://localhost:${port}`);
});
