import { CENTER, CROP, INITIAL_VIEW, POINT_CLOUD_URL } from "./config.js";
import "./styles/main.css";

const formatNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const viewer = new Potree.Viewer(document.getElementById("potree_render_area"));
window.viewer = viewer;

const sidebarWidth = () => Math.min(340, Math.max(0, window.innerWidth - 48));
viewer.toggleSidebar = () => {
  const renderArea = $("#potree_render_area");
  const isOpen = Number.parseFloat(renderArea.css("left")) > 0;
  renderArea.css("left", isOpen ? "0px" : `${sidebarWidth()}px`);
};

viewer.setEDLEnabled(true);
viewer.setEDLRadius(1.35);
viewer.setEDLStrength(0.8);
viewer.setFOV(55);
viewer.setPointBudget(5_000_000);
viewer.setBackground("gradient");
viewer.setClipTask(Potree.ClipTask.SHOW_INSIDE);
viewer.setClipMethod(Potree.ClipMethod.INSIDE_ANY);

await viewer.loadGUI();
document.getElementById("sidebar_root").prepend(
  document.getElementById("project-summary-template").content.cloneNode(true),
);
viewer.setLanguage("en");
viewer.toggleSidebar();

const status = document.getElementById("status");
const statusDot = document.getElementById("status-dot");

function resetView(duration = 0) {
  viewer.scene.view.setView(INITIAL_VIEW.position, INITIAL_VIEW.target, duration);
}

resetView();

// This clip volume limits rendering and node traversal to the Lambert72 crop.
// Its generous Z span removes extreme outliers without clipping Belgian terrain.
const cropVolume = new Potree.BoxVolume({ clip: true });
cropVolume.name = "Lambert72 crop";
cropVolume.position.set(0, 0, 1000);
cropVolume.scale.set(CROP.maxX - CROP.minX, CROP.maxY - CROP.minY, 20000);
cropVolume.clip = true;
cropVolume.visible = false;
viewer.scene.addVolume(cropVolume);

let pointCloud = null;
const startedAt = performance.now();

try {
  const event = await Potree.loadPointCloud(POINT_CLOUD_URL, "rawpoints_flat_BE");
  pointCloud = event.pointcloud;
  pointCloud.position.set(-CENTER.x, -CENTER.y, 0);
  pointCloud.minimumNodePixelSize = 55;
  pointCloud.pointBudget = 5_000_000;

  const material = pointCloud.material;
  material.size = 1.2;
  material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
  material.shape = Potree.PointShape.CIRCLE;
  material.activeAttributeName = "elevation";
  material.elevationRange = [-20, 350];

  viewer.scene.addPointCloud(pointCloud);
  viewer.setMoveSpeed(25000);
  resetView();
  status.textContent = `Streaming COPC · header ${(performance.now() - startedAt).toFixed(0)} ms`;
  statusDot.classList.add("ready");
} catch (error) {
  console.error(error);
  status.textContent = "Load failed";
  statusDot.classList.add("error");
  document.getElementById("error-message").textContent = String(error?.stack || error);
  document.getElementById("error-card").style.display = "block";
}

document.getElementById("reset-view").addEventListener("click", () => resetView(450));

function updateMetrics() {
  const visiblePoints = Math.max(0, pointCloud?.numVisiblePoints || 0);
  document.getElementById("visible-points").textContent = formatNumber.format(visiblePoints);
  document.getElementById("visible-nodes").textContent = pointCloud?.numVisibleNodes ?? 0;
  const deepestLevel =
    pointCloud?.visibleNodes?.reduce((depth, node) => Math.max(depth, node.getLevel()), 0) ?? 0;
  document.getElementById("deepest-level").textContent = deepestLevel;
  document.getElementById("active-loads").textContent = Potree.numNodesLoading;
  requestAnimationFrame(updateMetrics);
}

updateMetrics();
