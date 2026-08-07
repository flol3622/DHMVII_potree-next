const LAMBERT72 = "EPSG:31370";
const WEB_MERCATOR = "EPSG:3857";
const WGS84 = "EPSG:4326";
const MAP_NAVIGATION_MAX_Z = 500;
const MAP_NAVIGATION_TILT = 60;
const SEARCH_MINIMUM_LENGTH = 3;
const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_REQUEST_INTERVAL_MS = 1000;
const SEARCH_RESULT_LIMIT = 6;

// The COPC WKT identifies EPSG:31370. The explicit datum transform keeps this
// usable with the older Proj4 build bundled by Potree.
const LAMBERT72_DEFINITION = [
  "+proj=lcc",
  "+lat_0=90",
  "+lon_0=4.36748666666667",
  "+lat_1=51.1666672333333",
  "+lat_2=49.8333339",
  "+x_0=150000.013",
  "+y_0=5400088.438",
  "+ellps=intl",
  "+towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.456955,-1.84218,1.2747",
  "+units=m",
  "+no_defs",
].join(" ");

const CAMERA_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
    <defs>
      <filter id="s" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#071013" flood-opacity=".7"/>
      </filter>
    </defs>
    <g filter="url(#s)">
      <path d="M28 3 21 15h14L28 3Z" fill="#8bf5c6" stroke="#071013" stroke-width="2"/>
      <rect x="12" y="16" width="32" height="25" rx="7" fill="#102426" stroke="#eafff7" stroke-width="2.5"/>
      <path d="m44 23 8-4v19l-8-4V23Z" fill="#102426" stroke="#eafff7" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="28" cy="28.5" r="7" fill="#57c7ff" stroke="#eafff7" stroke-width="2.5"/>
      <circle cx="28" cy="28.5" r="2.5" fill="#071013"/>
    </g>
  </svg>`;

const CAMERA_ICON_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(CAMERA_SVG)}`;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function cardinalDirection(degrees) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(normalizeDegrees(degrees) / 45) % directions.length];
}

function normalize2D(x, y, fallbackX, fallbackY) {
  const length = Math.hypot(x, y);
  if (length < 1e-8) return [fallbackX, fallbackY];
  return [x / length, y / length];
}

function normalize3D(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function addScaled(base, first, firstScale, second, secondScale) {
  return normalize3D({
    x: base.x + first.x * firstScale + second.x * secondScale,
    y: base.y + first.y * firstScale + second.y * secondScale,
    z: base.z + first.z * firstScale + second.z * secondScale,
  });
}

function frameGeometry(map, geometry, fallbackCenter) {
  const size = map.getSize();
  if (!size || size[0] < 2 || size[1] < 2) return;

  if (geometry) {
    map.getView().fit(geometry, size, {
      constrainResolution: false,
      maxZoom: 16,
      padding: [56, 48, 56, 48],
    });
  } else {
    map.getView().setCenter(fallbackCenter);
    map.getView().setZoom(12);
  }
}

function destroyLegacyMap(viewer) {
  const legacyMapView = viewer.mapView;
  if (!legacyMapView) return;

  viewer.scene.removeEventListener("pointcloud_added", legacyMapView.onPointcloudAdded);
  legacyMapView.enabled = false;
  legacyMapView.map?.setTarget(null);

  const mapElement = $("#potree_map");
  if (mapElement.hasClass("ui-draggable")) mapElement.draggable("destroy");
  if (mapElement.hasClass("ui-resizable")) mapElement.resizable("destroy");
}

export function initializeMapTab({ viewer, center, crop, tileUrl, geocoderUrl }) {
  const openButton = document.getElementById("map-tab-button");
  const panel = document.getElementById("potree_map");
  const closeButton = document.getElementById("map-close");
  const frameButton = document.getElementById("map-frame-view");
  const searchForm = document.getElementById("map-search-form");
  const searchInput = document.getElementById("map-search-input");
  const searchSubmit = document.getElementById("map-search-submit");
  const searchResults = document.getElementById("map-search-results");
  const status = document.getElementById("map-status");
  const readout = document.getElementById("map-camera-readout");
  const heightReadout = document.getElementById("map-camera-height");
  const tiltReadout = document.getElementById("map-camera-tilt");
  const headingReadout = document.getElementById("map-camera-heading");

  if (!openButton || !panel || typeof ol === "undefined" || typeof proj4 === "undefined") {
    console.warn("Map tab could not start because its DOM or mapping runtime is unavailable.");
    return null;
  }

  destroyLegacyMap(viewer);
  proj4.defs(LAMBERT72, LAMBERT72_DEFINITION);

  const lambertToMap = proj4(LAMBERT72, WEB_MERCATOR);
  const vectorSource = new ol.source.Vector({});
  const footprintFeature = new ol.Feature({
    geometry: new ol.geom.Polygon([[
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]]),
  });
  const headingFeature = new ol.Feature({ geometry: new ol.geom.LineString([[0, 0], [0, 0]]) });
  const cameraFeature = new ol.Feature({ geometry: new ol.geom.Point([0, 0]) });

  const footprintStyle = new ol.style.Style({
    fill: new ol.style.Fill({ color: "rgba(87, 199, 255, 0.2)" }),
    stroke: new ol.style.Stroke({ color: "rgba(111, 216, 255, 0.95)", width: 2 }),
  });
  const headingStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "rgba(139, 245, 198, 0.9)", width: 2 }),
  });
  const cameraIcon = new ol.style.Icon({
    anchor: [0.5, 0.52],
    opacity: 1,
    rotateWithView: false,
    scale: 0.72,
    src: CAMERA_ICON_URL,
  });
  const cameraStyle = new ol.style.Style({ image: cameraIcon, zIndex: 20 });

  function updateCameraStyle(rotation) {
    cameraIcon.setRotation(rotation);
    cameraFeature.changed();
  }

  footprintFeature.setStyle(footprintStyle);
  headingFeature.setStyle(headingStyle);
  cameraFeature.setStyle(cameraStyle);
  vectorSource.addFeatures([footprintFeature, headingFeature, cameraFeature]);

  const coverageCorners = [
    [crop.minX, crop.minY],
    [crop.maxX, crop.minY],
    [crop.maxX, crop.maxY],
    [crop.minX, crop.maxY],
    [crop.minX, crop.minY],
  ].map((coordinate) => lambertToMap.forward(coordinate));
  const coverageLonLat = coverageCorners.map((coordinate) => (
    ol.proj.transform(coordinate, WEB_MERCATOR, WGS84)
  ));
  const coverageLongitudes = coverageLonLat.map(([longitude]) => longitude);
  const coverageLatitudes = coverageLonLat.map(([, latitude]) => latitude);
  const searchBounds = [
    Math.min(...coverageLongitudes),
    Math.min(...coverageLatitudes),
    Math.max(...coverageLongitudes),
    Math.max(...coverageLatitudes),
  ];
  const coverageFeature = new ol.Feature({ geometry: new ol.geom.LineString(coverageCorners) });
  coverageFeature.setStyle(
    new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "rgba(139, 245, 198, 0.52)",
        lineDash: [6, 7],
        width: 1.5,
      }),
    }),
  );
  vectorSource.addFeature(coverageFeature);

  const initialMapCenter = lambertToMap.forward([center.x, center.y]);
  const map = new ol.Map({
    controls: ol.control.defaults({
      attributionOptions: { collapsible: false },
      rotate: false,
    }),
    interactions: ol.interaction.defaults({ altShiftDragRotate: false, pinchRotate: false }),
    layers: [
      new ol.layer.Tile({
        source: new ol.source.OSM({
          crossOrigin: "anonymous",
          url: tileUrl,
        }),
      }),
      new ol.layer.Vector({ source: vectorSource }),
    ],
    target: "potree_map_content",
    view: new ol.View({ center: initialMapCenter, minZoom: 3, maxZoom: 19, zoom: 8 }),
  });

  let lastCameraMapPosition = initialMapCenter;
  let lastFootprintCoordinates = null;

  function sceneToLambert(position) {
    return [position.x + center.x, position.y + center.y];
  }

  function footprintCorner(cameraPosition, ray, planeZ, maximumRange) {
    const horizontalLength = Math.hypot(ray.x, ray.y);
    let distanceAlongRay = (planeZ - cameraPosition.z) / ray.z;
    const hasGroundHit = Number.isFinite(distanceAlongRay) && distanceAlongRay > 0;
    const groundRange = hasGroundHit ? distanceAlongRay * horizontalLength : Number.POSITIVE_INFINITY;

    if (!hasGroundHit || groundRange > maximumRange) {
      distanceAlongRay = maximumRange / Math.max(horizontalLength, 1e-6);
    }

    return [
      cameraPosition.x + ray.x * distanceAlongRay,
      cameraPosition.y + ray.y * distanceAlongRay,
    ];
  }

  function calculateFootprint() {
    const view = viewer.scene.view;
    const direction = normalize3D(view.direction);
    const right = normalize3D({ x: Math.cos(view.yaw), y: Math.sin(view.yaw), z: 0 });
    const up = normalize3D(cross(right, direction));
    const rendererElement = viewer.renderer?.domElement;
    const width = rendererElement?.clientWidth || window.innerWidth;
    const height = rendererElement?.clientHeight || window.innerHeight;
    const aspect = Math.max(width / Math.max(height, 1), 0.1);
    const verticalTangent = Math.tan((viewer.getFOV() * Math.PI) / 360);
    const horizontalTangent = verticalTangent * aspect;
    const pivot = view.getPivot();
    const maximumRange = Math.max(view.radius * 4, 1000);
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    return corners.map(([horizontal, vertical]) => {
      const ray = addScaled(
        direction,
        right,
        horizontal * horizontalTangent,
        up,
        vertical * verticalTangent,
      );
      const scenePoint = footprintCorner(view.position, ray, pivot.z, maximumRange);
      return lambertToMap.forward([scenePoint[0] + center.x, scenePoint[1] + center.y]);
    });
  }

  function updateCameraOverlay() {
    const view = viewer.scene.view;
    const cameraLambert = sceneToLambert(view.position);
    const cameraMap = lambertToMap.forward(cameraLambert);
    const fallbackHeading = [-Math.sin(view.yaw), Math.cos(view.yaw)];
    const [headingX, headingY] = normalize2D(
      view.direction.x,
      view.direction.y,
      fallbackHeading[0],
      fallbackHeading[1],
    );
    const aheadMap = lambertToMap.forward([
      cameraLambert[0] + headingX * 1000,
      cameraLambert[1] + headingY * 1000,
    ]);
    const mapHeadingX = aheadMap[0] - cameraMap[0];
    const mapHeadingY = aheadMap[1] - cameraMap[1];
    const rotation = Math.atan2(mapHeadingX, mapHeadingY);
    const headingLength = clamp(view.radius * 0.16, 250, 25000);
    const headingEnd = lambertToMap.forward([
      cameraLambert[0] + headingX * headingLength,
      cameraLambert[1] + headingY * headingLength,
    ]);
    const footprint = calculateFootprint();
    const closedFootprint = [...footprint, footprint[0]];

    cameraFeature.getGeometry().setCoordinates(cameraMap);
    headingFeature.getGeometry().setCoordinates([cameraMap, headingEnd]);
    footprintFeature.getGeometry().setCoordinates([closedFootprint]);
    updateCameraStyle(rotation);

    const lonLat = ol.proj.transform(cameraMap, WEB_MERCATOR, WGS84);
    const headingDegrees = normalizeDegrees((Math.atan2(headingX, headingY) * 180) / Math.PI);
    const tiltDegrees = Math.abs((view.pitch * 180) / Math.PI);

    readout.textContent = `${lonLat[1].toFixed(5)}, ${lonLat[0].toFixed(5)}`;
    if (heightReadout) heightReadout.textContent = `${Math.round(view.position.z)} m`;
    if (tiltReadout) {
      tiltReadout.textContent = `${tiltDegrees.toFixed(0)}° ${view.pitch <= 0 ? "down" : "up"}`;
    }
    if (headingReadout) {
      headingReadout.textContent = `${cardinalDirection(headingDegrees)} · ${headingDegrees.toFixed(0)}°`;
    }
    lastCameraMapPosition = cameraMap;
    lastFootprintCoordinates = closedFootprint;
  }

  function frameCurrentView() {
    updateCameraOverlay();
    const frameCoordinates = [...lastFootprintCoordinates, lastCameraMapPosition];
    frameGeometry(map, new ol.geom.LineString(frameCoordinates), lastCameraMapPosition);
  }

  function navigateToMapCoordinate(mapCoordinate, label) {
    const lambert = lambertToMap.inverse(mapCoordinate);
    const view = viewer.scene.view;
    const sceneX = lambert[0] - center.x;
    const sceneY = lambert[1] - center.y;
    const cameraZ = Math.min(view.position.z, MAP_NAVIGATION_MAX_Z);
    const tiltRadians = (MAP_NAVIGATION_TILT * Math.PI) / 180;
    // Derive the horizontal offset from scene Z to apply the configured downward tilt.
    const verticalLookDistance = Math.max(Math.abs(cameraZ), 1);
    const horizontalLookDistance = verticalLookDistance / Math.tan(tiltRadians);
    const nextTarget = [
      sceneX,
      sceneY,
      cameraZ - verticalLookDistance,
    ];
    const nextPosition = [
      sceneX,
      sceneY - horizontalLookDistance,
      cameraZ,
    ];

    status.textContent = `${label}: centered in view from scene Z ${Math.round(cameraZ)} m, ${MAP_NAVIGATION_TILT}° down, facing north.`;
    viewer.scene.view.setView(nextPosition, nextTarget, 350, () => {
      updateCameraOverlay();
      if (!panel.hidden) frameCurrentView();
    });
  }

  function openPanel() {
    panel.hidden = false;
    openButton.hidden = true;
    openButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      map.updateSize();
      frameCurrentView();
      searchInput.focus({ preventScroll: true });
    });
  }

  function closePanel() {
    clearTimeout(searchTimer);
    activeSearch?.abort();
    activeSearch = null;
    searchForm.classList.remove("is-searching");
    hideSearchResults();
    panel.hidden = true;
    openButton.hidden = false;
    openButton.setAttribute("aria-expanded", "false");
    openButton.focus({ preventScroll: true });
  }

  openButton.addEventListener("click", openPanel);
  closeButton.addEventListener("click", closePanel);
  frameButton.addEventListener("click", frameCurrentView);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) closePanel();
  });

  map.on("singleclick", (event) => {
    navigateToMapCoordinate(event.coordinate, "Map location");
  });

  const searchCache = new Map();
  const knownSearchResults = new Map();
  let activeSearch = null;
  let searchTimer = null;
  let activeSearchResults = [];
  let activeSearchResultIndex = -1;
  let shownSearchQuery = "";
  let lastGeocoderRequestAt = 0;

  function normalizeSearchText(value) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      let diagonal = previous[0];
      previous[0] = leftIndex;
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const above = previous[rightIndex];
        previous[rightIndex] = Math.min(
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + 1,
          diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
        );
        diagonal = above;
      }
    }

    return previous[right.length];
  }

  function fuzzySearchScore(result, query) {
    const normalizedQuery = normalizeSearchText(query);
    const normalizedResult = normalizeSearchText(`${result.title} ${result.detail}`);
    if (!normalizedQuery || !normalizedResult) return Number.POSITIVE_INFINITY;

    const directIndex = normalizedResult.indexOf(normalizedQuery);
    if (directIndex >= 0) return directIndex / 100;

    const resultWords = normalizedResult.split(" ");
    let score = 0;
    for (const queryWord of normalizedQuery.split(" ")) {
      let wordScore = Number.POSITIVE_INFINITY;
      for (const resultWord of resultWords) {
        if (resultWord.startsWith(queryWord)) {
          wordScore = Math.min(wordScore, 0.5 + (resultWord.length - queryWord.length) / 100);
          continue;
        }

        const allowedDistance = queryWord.length >= 6 ? 2 : 1;
        const distance = editDistance(queryWord, resultWord);
        if (distance <= allowedDistance) wordScore = Math.min(wordScore, 2 + distance);
      }
      if (!Number.isFinite(wordScore)) return Number.POSITIVE_INFINITY;
      score += wordScore;
    }

    return score;
  }

  function rememberSearchResults(results) {
    for (const result of results) knownSearchResults.set(result.id, result);
    while (knownSearchResults.size > 60) {
      knownSearchResults.delete(knownSearchResults.keys().next().value);
    }
  }

  function findKnownSearchResults(query) {
    return [...knownSearchResults.values()]
      .map((result) => ({ result, score: fuzzySearchScore(result, query) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => left.score - right.score)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map(({ result }) => result);
  }

  function setSearchExpanded(expanded) {
    searchInput.setAttribute("aria-expanded", String(expanded));
    if (!expanded) searchInput.removeAttribute("aria-activedescendant");
  }

  function hideSearchResults() {
    searchResults.hidden = true;
    activeSearchResults = [];
    activeSearchResultIndex = -1;
    setSearchExpanded(false);
  }

  function showSearchFeedback(message, { loading = false } = {}) {
    searchResults.replaceChildren();
    searchResults.setAttribute("aria-busy", String(loading));
    searchResults.classList.toggle("is-loading", loading);
    searchResults.hidden = false;
    shownSearchQuery = normalizeSearchText(searchInput.value);
    activeSearchResults = [];
    activeSearchResultIndex = -1;
    searchInput.removeAttribute("aria-activedescendant");
    setSearchExpanded(true);

    const feedback = document.createElement("div");
    feedback.className = "map-search-feedback";
    feedback.setAttribute("role", "status");
    if (loading) {
      const spinner = document.createElement("i");
      spinner.setAttribute("aria-hidden", "true");
      feedback.append(spinner);
    }
    feedback.append(document.createTextNode(message));
    searchResults.append(feedback);
  }

  function setActiveSearchResult(index) {
    if (!activeSearchResults.length) return;
    activeSearchResultIndex = (index + activeSearchResults.length) % activeSearchResults.length;

    const options = searchResults.querySelectorAll(".map-search-result");
    options.forEach((option, optionIndex) => {
      option.setAttribute("aria-selected", String(optionIndex === activeSearchResultIndex));
    });
    const activeOption = options[activeSearchResultIndex];
    searchInput.setAttribute("aria-activedescendant", activeOption.id);
    activeOption.scrollIntoView({ block: "nearest" });
  }

  function selectSearchResult(result) {
    const coordinate = ol.proj.transform(result.lonLat, WGS84, WEB_MERCATOR);
    searchInput.value = result.detail;
    hideSearchResults();
    navigateToMapCoordinate(coordinate, result.title);
  }

  function showSearchResults(results, query) {
    searchResults.replaceChildren();
    searchResults.setAttribute("aria-busy", "false");
    searchResults.classList.remove("is-loading");
    searchResults.hidden = false;
    shownSearchQuery = normalizeSearchText(query);
    activeSearchResults = results;
    activeSearchResultIndex = -1;
    searchInput.removeAttribute("aria-activedescendant");
    setSearchExpanded(true);

    results.forEach((result, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-search-result";
      button.id = `map-search-result-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");

      const title = document.createElement("strong");
      title.textContent = result.title;
      const detail = document.createElement("span");
      detail.textContent = result.detail;
      button.append(title, detail);
      button.addEventListener("pointerenter", () => setActiveSearchResult(index));
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => selectSearchResult(result));
      searchResults.append(button);
    });
  }

  function normalizeGeocoderResults(payload) {
    const rawResults = Array.isArray(payload) ? payload : payload?.features || [];
    const normalizedResults = [];

    for (const rawResult of rawResults) {
      if (rawResult?.geometry?.type === "Point") {
        const properties = rawResult.properties || {};
        const lonLat = rawResult.geometry.coordinates?.slice(0, 2).map(Number);
        if (!lonLat || !lonLat.every(Number.isFinite)) continue;

        const streetAddress = [properties.housenumber, properties.street]
          .filter(Boolean)
          .join(" ");
        const title = properties.name || streetAddress || properties.city || properties.county;
        if (!title) continue;
        const detailParts = [
          title,
          properties.locality,
          properties.district,
          properties.city && properties.city !== title ? properties.city : null,
          properties.postcode,
          properties.county,
          properties.state,
          properties.country,
        ].filter((part, index, parts) => part && parts.indexOf(part) === index);
        normalizedResults.push({
          id: `${properties.osm_type || "place"}-${properties.osm_id || lonLat.join("-")}`,
          title,
          detail: detailParts.join(", "),
          lonLat,
        });
        continue;
      }

      const lonLat = [Number(rawResult?.lon), Number(rawResult?.lat)];
      if (!lonLat.every(Number.isFinite) || !rawResult?.display_name) continue;
      normalizedResults.push({
        id: `${rawResult.osm_type || "place"}-${rawResult.osm_id || lonLat.join("-")}`,
        title: rawResult.name || rawResult.display_name.split(",")[0],
        detail: rawResult.display_name,
        lonLat,
      });
    }

    return [...new Map(normalizedResults.map((result) => [result.id, result])).values()]
      .slice(0, SEARCH_RESULT_LIMIT);
  }

  function waitForSearchInterval(delay, signal) {
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, delay);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new DOMException("Search cancelled", "AbortError"));
      }, { once: true });
    });
  }

  async function searchLocations(query) {
    const normalizedQuery = normalizeSearchText(query);
    if (normalizedQuery.length < SEARCH_MINIMUM_LENGTH) return;

    activeSearch?.abort();
    const searchController = new AbortController();
    activeSearch = searchController;
    searchForm.classList.add("is-searching");

    const cachedResults = searchCache.get(normalizedQuery);
    if (cachedResults) {
      if (cachedResults.length) {
        showSearchResults(cachedResults, query);
        status.textContent = `${cachedResults.length} possible location${cachedResults.length === 1 ? "" : "s"} for ${query}.`;
      } else {
        showSearchFeedback(`No location found for “${query}”. Try a nearby town or fewer words.`);
        status.textContent = `No Belgian location found for ${query}.`;
      }
      activeSearch = null;
      searchForm.classList.remove("is-searching");
      return;
    }

    if (shownSearchQuery !== normalizedQuery || !activeSearchResults.length) {
      showSearchFeedback("Finding possible locations…", { loading: true });
    } else {
      searchResults.setAttribute("aria-busy", "true");
      searchResults.classList.add("is-loading");
    }

    try {
      const rateLimitDelay = Math.max(
        0,
        SEARCH_REQUEST_INTERVAL_MS - (Date.now() - lastGeocoderRequestAt),
      );
      await waitForSearchInterval(rateLimitDelay, searchController.signal);
      if (searchController.signal.aborted) throw new DOMException("Search cancelled", "AbortError");

      const language = (document.documentElement.lang || "en").split("-")[0];
      const url = new URL(geocoderUrl, document.baseURI);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(SEARCH_RESULT_LIMIT));
      const isPhotonEndpoint = url.hostname.includes("photon.")
        || /\/(?:api|photon)\/?$/i.test(url.pathname);
      if (isPhotonEndpoint) {
        url.searchParams.set("lang", language);
        url.searchParams.set("bbox", searchBounds.join(","));
      } else {
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("countrycodes", "be");
        url.searchParams.set("dedupe", "1");
        url.searchParams.set("accept-language", language);
        url.searchParams.set("viewbox", [
          searchBounds[0],
          searchBounds[3],
          searchBounds[2],
          searchBounds[1],
        ].join(","));
      }
      lastGeocoderRequestAt = Date.now();
      const response = await fetch(url, {
        headers: { Accept: "application/json, application/geo+json" },
        signal: searchController.signal,
      });
      if (!response.ok) throw new Error(`Location service returned ${response.status}`);
      const results = normalizeGeocoderResults(await response.json());
      rememberSearchResults(results);

      const combinedResults = [...new Map(
        [...results, ...findKnownSearchResults(query)].map((result) => [result.id, result]),
      ).values()].slice(0, SEARCH_RESULT_LIMIT);
      searchCache.set(normalizedQuery, combinedResults);

      if (normalizeSearchText(searchInput.value) !== normalizedQuery) return;

      if (!combinedResults.length) {
        showSearchFeedback(`No location found for “${query}”. Try a nearby town or fewer words.`);
        status.textContent = `No Belgian location found for ${query}.`;
      } else {
        showSearchResults(combinedResults, query);
        status.textContent = `${combinedResults.length} possible location${combinedResults.length === 1 ? "" : "s"} for ${query}.`;
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error(error);
        showSearchFeedback("Location suggestions are temporarily unavailable. You can still click the map.");
        status.textContent = "Location search is temporarily unavailable. You can still click the map.";
      }
    } finally {
      if (activeSearch === searchController) {
        activeSearch = null;
        searchForm.classList.remove("is-searching");
        searchResults.setAttribute("aria-busy", "false");
        searchResults.classList.remove("is-loading");
      }
    }
  }

  function queueSearch(query, immediately = false) {
    clearTimeout(searchTimer);
    if (immediately) searchLocations(query);
    else searchTimer = setTimeout(() => searchLocations(query), SEARCH_DEBOUNCE_MS);
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (activeSearchResultIndex >= 0 && shownSearchQuery === normalizeSearchText(searchInput.value)) {
      selectSearchResult(activeSearchResults[activeSearchResultIndex]);
      return;
    }

    const query = searchInput.value.trim();
    if (normalizeSearchText(query).length < SEARCH_MINIMUM_LENGTH) {
      showSearchFeedback(`Type at least ${SEARCH_MINIMUM_LENGTH} characters to search.`);
      status.textContent = `Enter at least ${SEARCH_MINIMUM_LENGTH} characters to search.`;
      return;
    }
    queueSearch(query, true);
  });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    activeSearch?.abort();
    activeSearch = null;
    searchForm.classList.remove("is-searching");
    const query = searchInput.value.trim();
    const normalizedQuery = normalizeSearchText(query);

    if (!normalizedQuery) {
      hideSearchResults();
      return;
    }
    if (normalizedQuery.length < SEARCH_MINIMUM_LENGTH) {
      const charactersNeeded = SEARCH_MINIMUM_LENGTH - normalizedQuery.length;
      showSearchFeedback(`Type ${charactersNeeded} more character${charactersNeeded === 1 ? "" : "s"} for suggestions.`);
      return;
    }

    const immediateResults = searchCache.get(normalizedQuery) || findKnownSearchResults(query);
    if (immediateResults.length) showSearchResults(immediateResults, query);
    else showSearchFeedback("Finding possible locations…", { loading: true });
    queueSearch(query);
  });

  searchInput.addEventListener("focus", () => {
    const query = searchInput.value.trim();
    const normalizedQuery = normalizeSearchText(query);
    if (normalizedQuery.length < SEARCH_MINIMUM_LENGTH) return;
    const immediateResults = searchCache.get(normalizedQuery) || findKnownSearchResults(query);
    if (immediateResults.length) showSearchResults(immediateResults, query);
    else queueSearch(query);
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && activeSearchResults.length) {
      event.preventDefault();
      setActiveSearchResult(activeSearchResultIndex + 1);
    } else if (event.key === "ArrowUp" && activeSearchResults.length) {
      event.preventDefault();
      setActiveSearchResult(
        activeSearchResultIndex < 0 ? activeSearchResults.length - 1 : activeSearchResultIndex - 1,
      );
    } else if (event.key === "Escape" && !searchResults.hidden) {
      event.preventDefault();
      event.stopPropagation();
      hideSearchResults();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!searchForm.contains(event.target) && !searchResults.contains(event.target)) {
      hideSearchResults();
    }
  });

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (!panel.hidden) map.updateSize();
    }).observe(document.getElementById("potree_map_content"));
  } else {
    window.addEventListener("resize", () => {
      if (!panel.hidden) map.updateSize();
    });
  }

  viewer.addEventListener("camera_changed", updateCameraOverlay);
  viewer.addEventListener("fov_changed", updateCameraOverlay);
  updateCameraOverlay();

  return {
    map,
    open: openPanel,
    close: closePanel,
    frame: frameCurrentView,
    navigateToMapCoordinate,
    get footprint() {
      return lastFootprintCoordinates;
    },
  };
}
