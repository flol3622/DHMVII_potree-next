export function initializeLasExport({ viewer, cropVolume, url }) {
  const menu = document.getElementById("viewer-download-menu");
  const select = document.getElementById("export-volume");
  const create = document.getElementById("export-create-box");
  const download = document.getElementById("export-las");
  const cancel = document.getElementById("export-cancel");
  const status = document.getElementById("export-status");
  const save = document.getElementById("export-save");
  const number = new Intl.NumberFormat("en");
  let worker = null;
  let downloadUrl = null;
  let signature = "";

  function clearDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    save.hidden = true;
    save.removeAttribute("href");
  }

  const volumes = () => viewer.scene.volumes.filter((volume) =>
    volume !== cropVolume && volume.clip && volume instanceof Potree.BoxVolume);

  function syncVolumes() {
    const boxes = volumes();
    const nextSignature = JSON.stringify(boxes.map((box) => [box.uuid, box.name]));
    if (signature !== nextSignature) {
      const selected = select.value;
      select.replaceChildren(...(boxes.length
        ? boxes.map((box) => new Option(box.name || "Clipping box", box.uuid))
        : [new Option("Create a clipping box first", "")]));
      if (boxes.some((box) => box.uuid === selected)) select.value = selected;
      signature = nextSignature;
    }
    const loaded = viewer.scene.pointclouds.some((cloud) => cloud.pcoGeometry?.type === "copc");
    select.disabled = !!worker || !boxes.length;
    download.disabled = !!worker || !boxes.length || !loaded;
    create.disabled = !!worker || !loaded;
  }

  function stop() {
    worker?.terminate(); // Also aborts requests and releases the decoder's memory.
    worker = null;
    cancel.hidden = true;
    menu.removeAttribute("aria-busy");
    syncVolumes();
  }

  create.addEventListener("click", () => {
    clearDownload();
    const box = viewer.volumeTool.startInsertion({ clip: true, name: "Download clip" });
    syncVolumes();
    select.value = box.uuid;
    status.textContent = "Move onto the point cloud and click to place the box. Select the box to move, rotate or resize it.";
    menu.open = false;
    box.addEventListener("drop", () => { menu.open = true; });
  });

  download.addEventListener("click", () => {
    if (worker) return;
    clearDownload();
    status.classList.remove("is-error");
    const box = volumes().find((volume) => volume.uuid === select.value);
    const cloud = viewer.scene.pointclouds.find((pointcloud) => pointcloud.pcoGeometry?.type === "copc");
    if (!box || !cloud) { syncVolumes(); return; }
    box.updateMatrixWorld(true);
    cloud.updateMatrixWorld(true);
    if (!Number.isFinite(box.matrixWorld.determinant()) || Math.abs(box.matrixWorld.determinant()) < 1e-12) {
      status.textContent = "Give the clipping box a nonzero width, depth and height.";
      return;
    }
    // Snapshot the box in source coordinates. The output retains Lambert72
    // coordinates, despite the viewer's large translation toward the origin.
    const matrix = box.matrixWorld.clone().invert().multiply(cloud.matrixWorld).elements;
    const filename = `${(box.name || "clipped-volume").replace(/[^a-z0-9_-]+/gi, "-")}-full-detail.las`;
    try {
      worker = new Worker(new URL("./las-export-worker.js", import.meta.url), { type: "module" });
      menu.setAttribute("aria-busy", "true");
      cancel.hidden = false;
      status.textContent = "Preparing full-detail LAS export…";
      syncVolumes();
      worker.onmessage = ({ data }) => {
        if (data.type === "progress") {
          status.textContent = `${data.phase} · ${number.format(data.count)} points · ${number.format(data.nodes)} nodes`;
        } else if (data.type === "complete") {
          downloadUrl = URL.createObjectURL(data.blob);
          save.href = downloadUrl;
          save.download = filename;
          save.hidden = false;
          save.click();
          const size = data.blob.size < 1048576
            ? `${(data.blob.size / 1024).toFixed(1)} KiB`
            : `${(data.blob.size / 1048576).toFixed(1)} MiB`;
          status.textContent = `${number.format(data.count)} points · ${size} · download ready.`;
          stop();
        } else if (data.type === "error") {
          status.textContent = data.message;
          status.classList.add("is-error");
          stop();
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        status.textContent = "The export worker could not finish. Try again with a smaller clipping box.";
        status.classList.add("is-error");
        stop();
      };
      worker.postMessage({ url, matrix });
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("is-error");
      stop();
    }
  });

  cancel.addEventListener("click", () => {
    stop();
    status.textContent = "Export cancelled.";
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
    event.stopPropagation();
  });
  // Do not let interactions with this overlay navigate or select the 3D scene.
  for (const type of ["pointerdown", "mousedown", "mouseup", "dblclick", "wheel", "touchstart", "touchmove"]) {
    menu.addEventListener(type, (event) => event.stopPropagation());
  }
  viewer.addEventListener("update", syncVolumes);
  window.addEventListener("pagehide", () => { stop(); clearDownload(); });
  syncVolumes();
}
