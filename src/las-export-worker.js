import { createRangeGetter, exportClippedLas } from "./las-export-core.js";
import { Copc, Las } from "copc";
import { createLazPerf } from "laz-perf";
import decoderUrl from "laz-perf/lib/web/laz-perf.wasm?url";

self.onmessage = async ({ data }) => {
  try {
    const lazPerf = await createLazPerf({ locateFile: () => decoderUrl });
    const result = await exportClippedLas({
      api: { Copc, Las },
      lazPerf,
      get: createRangeGetter(data.url),
      matrix: data.matrix,
      onProgress: (progress) => self.postMessage({ type: "progress", ...progress }),
    });
    self.postMessage({ type: "complete", ...result });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof WebAssembly.RuntimeError
      ? "The browser could not finish this export. Try a smaller clipping box."
      : error.message || String(error) });
  }
};
