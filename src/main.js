import {
  CENTER,
  CROP,
  ELEVATION_RANGE,
  GEOCODER_URL,
  INITIAL_VIEW,
  MAP_TILE_URL,
  POINT_CLOUD_NAME,
  POINT_CLOUD_URL,
} from "./config.js";
import { initializeMapTab } from "./map.js";
import "./styles/main.css";

const formatNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const viewer = new Potree.Viewer(document.getElementById("potree_render_area"));
window.viewer = viewer;

const sidebarWidth = () => Math.min(360, Math.max(0, window.innerWidth - 48));
const renderArea = $("#potree_render_area");
const sidebarIsOpen = () => Number.parseFloat(renderArea.css("left")) > 0;

// Lucide panel-left / panel-left-close.
const svgIcon = (paths) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#333332" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  )}`;
const SIDEBAR_PANEL = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>';
const TOGGLE_ICON = {
  closed: svgIcon(SIDEBAR_PANEL),
  open: svgIcon(`${SIDEBAR_PANEL}<path d="m16 15-3-3 3-3"/>`),
};

function setSidebarOpen(isOpen) {
  renderArea.css("left", isOpen ? `${sidebarWidth()}px` : "0px");
  document.documentElement.classList.toggle("sidebar-open", isOpen);

  const toggle = document.querySelector(".potree_menu_toggle");
  if (toggle) {
    toggle.src = isOpen ? TOGGLE_ICON.open : TOGGLE_ICON.closed;
    toggle.title = isOpen ? "Hide sidebar" : "Show sidebar";
    toggle.alt = toggle.title;
  }
}

viewer.toggleSidebar = () => {
  setSidebarOpen(!sidebarIsOpen());
};
window.addEventListener("resize", () => {
  if (sidebarIsOpen()) setSidebarOpen(true);
});

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

document.querySelectorAll("#potree_menu > h3").forEach((header, index) => {
  const content = header.nextElementSibling;
  if (!content) return;

  const contentId = `potree-menu-section-${index}`;
  content.id = contentId;
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-controls", contentId);
  header.setAttribute("aria-expanded", "false");

  header.addEventListener("click", () => {
    const isOpen = !header.classList.contains("is-open");
    header.classList.toggle("is-open", isOpen);
    header.setAttribute("aria-expanded", String(isOpen));
  });
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    header.click();
  });
});

// Potree renders the EDL opacity label but never fills in its value, so the row
// reads "Opacity:" with nothing after it.
const edlOpacityLabel = document.getElementById("lblEDLOpacity");
if (edlOpacityLabel) {
  const syncEdlOpacity = () => {
    edlOpacityLabel.textContent = viewer.getEDLOpacity().toFixed(2);
  };
  syncEdlOpacity();
  $("#sldEDLOpacity").on("slide slidechange", syncEdlOpacity);
}

viewer.setLanguage("en");
viewer.toggleSidebar();

initializeMapTab({
  viewer,
  center: CENTER,
  crop: CROP,
  tileUrl: MAP_TILE_URL,
  geocoderUrl: GEOCODER_URL,
});

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
cropVolume.position.set(0, 0, -6000);
cropVolume.scale.set(CROP.maxX - CROP.minX, CROP.maxY - CROP.minY, 15000);
cropVolume.clip = true;
cropVolume.visible = false;
viewer.scene.addVolume(cropVolume);

let pointCloud = null;
const startedAt = performance.now();

async function loadPointCloud() {
  try {
    const event = await Potree.loadPointCloud(POINT_CLOUD_URL, "rawpoints_flat_BE");
    pointCloud = event.pointcloud;
    // The scene tree labels each node with this name; without it the row is blank.
    pointCloud.name = POINT_CLOUD_NAME;
    pointCloud.position.set(-CENTER.x, -CENTER.y, 0);
    pointCloud.minimumNodePixelSize = 55;
    pointCloud.pointBudget = 5_000_000;

    const material = pointCloud.material;
    material.size = 1.2;
    material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
    material.shape = Potree.PointShape.CIRCLE;
    material.activeAttributeName = "elevation";
    material.elevationRange = ELEVATION_RANGE;

    viewer.scene.addPointCloud(pointCloud);
    const cropDiagonal = Math.hypot(CROP.maxX - CROP.minX, CROP.maxY - CROP.minY);
    viewer.setMoveSpeed(Math.max(50, Math.min(25000, cropDiagonal / 10)));
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
}

loadPointCloud();

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
