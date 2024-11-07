// @deno-types="npm:@types/leaflet@^1.9.14"
import leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./leafletWorkaround.ts";
import { leafletExtend } from "./leafletWorkaround.ts";
import luck from "./luck.ts";

// Types and POD or POD-like constants

const MAP_CENTER = leaflet.latLng(36.98949379578401, -122.06277128548504);
const MAP_ZOOM = 19;
const MAP_DATA_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAP_ATTRIBUTION =
  `&copy; <a href="http://www.openstreetmap.org/copyright">
    OpenStreetMap
  </a>`;

const GRID_LATLNG_DIMENSIONS = 1e-4;
const GRID_REFERENCE_POINT_COORDS = 0;

const GEOCOIN_CACHE_PROBABILITY = 0.1;
const GEOCOIN_CACHE_MAX_VALUE = 100;
const GEOCOIN_CACHE_MIN_VALUE = 1;
const GEOCOIN_CACHE_EMOJI = "\u{1F381}";
const GEOCOIN_CACHE_EMOJI_STYLE = "32px sans-serif";
const GEOCOIN_CACHE_VISIBILITY_RADIUS = 8;

interface GeocoinGridCell {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  hasCache: boolean;
  coins: number;
}

type GeocoinGrid = Record<string, GeocoinGridCell>;

interface AppState {
  map: leaflet.Map;
  userMarker: leaflet.Marker;
  grid: GeocoinGrid;
  coinsOwned: number;
}

interface AppUI {
  map: HTMLElement;
  inventorySummary: HTMLElement;
}

// Utility functions

function latLngDistToPointDist(
  map: leaflet.Map,
  latLng: leaflet.LatLng,
): leaflet.Point {
  const referencePoint = leaflet.point(
    GRID_REFERENCE_POINT_COORDS,
    GRID_REFERENCE_POINT_COORDS,
  );
  const referencePointLatLng = map.layerPointToLatLng(referencePoint);
  const shiftedLatLng = leaflet.latLng(
    referencePointLatLng.lat + latLng.lat,
    referencePointLatLng.lng + latLng.lng,
  );
  const shiftedPoint = map.latLngToLayerPoint(shiftedLatLng);
  const distPoint = leaflet.point(
    Math.abs(shiftedPoint.x - referencePoint.x),
    Math.abs(shiftedPoint.y - referencePoint.y),
  );
  return distPoint;
}

function lerp(min: number, max: number, weight: number) {
  return min + weight * (max - min);
}

function makeElement<Tag extends keyof HTMLElementTagNameMap>(
  parent: Node | null,
  what: Tag,
  attrs?: Partial<HTMLElementTagNameMap[Tag]>,
  how?: (elem: HTMLElementTagNameMap[Tag]) => void,
): HTMLElementTagNameMap[Tag] {
  const elem = document.createElement(what);
  if (attrs !== undefined) Object.assign(elem, attrs);
  how?.call(elem, elem);
  parent?.appendChild(elem);
  return elem;
}

function boundsAround(center: leaflet.LatLng, radius: number) {
  return leaflet.latLngBounds(
    leaflet.latLng(center.lat + radius, center.lng + radius),
    leaflet.latLng(center.lat - radius, center.lng - radius),
  );
}

// UI

function makeGrid(
  map: leaflet.Map,
  createTile: (this: leaflet.GridLayer, coords: leaflet.Point) => HTMLElement,
  options?: object,
): leaflet.GridLayer {
  return (new (leafletExtend<leaflet.GridLayer>(leaflet.GridLayer, {
    createTile,
  }))({
    tileSize: latLngDistToPointDist(
      map,
      leaflet.latLng(
        GRID_LATLNG_DIMENSIONS,
        GRID_LATLNG_DIMENSIONS,
      ),
    ),
    ...(options || {}),
  })).addTo(map);
}

function makeMap(ui: AppUI) {
  const map = leaflet.map(ui.map, {
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    minZoom: MAP_ZOOM,
    maxZoom: MAP_ZOOM,
    zoomControl: false,
    scrollWheelZoom: false,
  });
  leaflet.tileLayer(MAP_DATA_URL, {
    maxZoom: MAP_ZOOM,
    attribution: MAP_ATTRIBUTION,
  }).addTo(map);
  return map;
}

function makeGeocoinGrid(state: AppState, ui: AppUI) {
  makeGrid(state.map, function (coords: leaflet.Point) {
    const key = coords.toString();
    let value: GeocoinGridCell;
    if (key in state.grid) {
      value = state.grid[key];
    } else {
      value = makeGridCell(state, ui, coords, this.getTileSize());
      state.grid[key] = value;
    }
    return value.canvas;
  }, {
    bounds: boundsAround(
      state.userMarker.getLatLng(),
      GRID_LATLNG_DIMENSIONS * GEOCOIN_CACHE_VISIBILITY_RADIUS,
    ),
  });
}

function makeUserMarker(map: leaflet.Map) {
  const marker = leaflet.marker(MAP_CENTER);
  marker.bindTooltip("You Are Here");
  marker.addTo(map);
  return marker;
}

function makeGridCell(
  state: AppState,
  ui: AppUI,
  coords: leaflet.Point,
  size: leaflet.Point,
) {
  const canvas = document.createElement("canvas");
  canvas.width = size.x;
  canvas.height = size.y;
  const ctx = canvas.getContext("2d");
  const hasCache = luck(`Is there a geocoin cache at ${coords.toString()}?`) >
    1 - GEOCOIN_CACHE_PROBABILITY;
  const coins = hasCache
    ? Math.round(lerp(
      GEOCOIN_CACHE_MIN_VALUE,
      GEOCOIN_CACHE_MAX_VALUE,
      luck(`How many geocoins are in the cache at ${coords.toString()}?`),
    ))
    : 0;
  if (hasCache) {
    canvas.onclick = (mouseEvent) =>
      showGeocoinCachePopup(state, ui, coords, mouseEvent);
    if (ctx !== null) {
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = GEOCOIN_CACHE_EMOJI_STYLE;
      ctx.fillText(GEOCOIN_CACHE_EMOJI, 0, 0);
      ctx.restore();
    }
  }
  return { canvas, ctx, hasCache, coins };
}

function showGeocoinCachePopup(
  state: AppState,
  ui: AppUI,
  coords: leaflet.Point,
  mouseEvent: MouseEvent,
) {
  const key = coords.toString();
  if (key in state.grid) {
    const latLng = state.map.mouseEventToLatLng(mouseEvent);
    const cell = state.grid[key];
    const popupContent = makeElement(null, "aside", {
      className: "map-popup",
    }, (elem) => {
      const status = makeElement(elem, "p");
      const takeButton = makeElement(elem, "button", {
        innerHTML: "Take a coin",
        onclick: () => {
          if (cell.coins > 0) {
            cell.coins--;
            state.coinsOwned++;
            updatePopup();
            updateInventoryStatus(state, ui);
          }
        },
      });
      const leaveButton = makeElement(elem, "button", {
        innerHTML: "Leave a coin",
        onclick: () => {
          if (state.coinsOwned > 0) {
            cell.coins++;
            state.coinsOwned--;
            updatePopup();
            updateInventoryStatus(state, ui);
          }
        },
      });
      makeElement(elem, "br");
      const takeAllButton = makeElement(elem, "button", {
        innerHTML: "Take all",
        onclick: () => {
          state.coinsOwned += cell.coins;
          cell.coins = 0;
          updatePopup();
          updateInventoryStatus(state, ui);
        },
      });
      const leaveAllButton = makeElement(elem, "button", {
        innerHTML: "Leave all",
        onclick: () => {
          cell.coins += state.coinsOwned;
          state.coinsOwned = 0;
          updatePopup();
          updateInventoryStatus(state, ui);
        },
      });
      const updatePopup = () => {
        status.innerHTML = `
          This cache at ${latLng.toString()}
          contains ${cell.coins} geocoin(s).
        `;
        takeButton.disabled = cell.coins <= 0;
        leaveButton.disabled = state.coinsOwned <= 0;
        takeAllButton.disabled = takeButton.disabled;
        leaveAllButton.disabled = leaveButton.disabled;
      };
      updatePopup();
    });
    setTimeout(
      () => state.map.openPopup(popupContent, latLng),
      10,
    );
  }
}

function updateInventoryStatus(state: AppState, ui: AppUI) {
  if (state.coinsOwned > 0) {
    ui.inventorySummary.innerHTML = `
      ${state.coinsOwned} geocoin(s)
    `;
  } else {
    ui.inventorySummary.innerHTML = "Empty";
  }
}

// Init

const appUI: AppUI = {
  map: document.querySelector("#map")!,
  inventorySummary: document.querySelector("#inventory-total")!,
};

const theMap = makeMap(appUI);

const appState: AppState = {
  map: theMap,
  userMarker: makeUserMarker(theMap),
  grid: {},
  coinsOwned: 0,
};

makeGeocoinGrid(appState, appUI);
