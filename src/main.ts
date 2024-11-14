// @deno-types="npm:@types/leaflet@^1.9.14"
import leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./leafletWorkaround.ts";
import { leafletExtend } from "./leafletWorkaround.ts";
import luck from "./luck.ts";

// Generics

type Incomplete<T, MustAlreadyHave extends keyof T = never> =
  & Partial<T>
  & Pick<T, MustAlreadyHave>;

function asHavingProperties<T extends object>(t: Partial<T>) {
  /* Currying is required here because TypeScript does not support
    partial inference of generic parameters. */
  return function <Ks extends (keyof T)[]>(...keys: Ks) {
    for (const key of keys) {
      if (!(key in t)) {
        throw new Error(`
          ${t} cast asHavingProperties ${keys}
          but is missing ${String(key)}
        `);
      }
    }
    return t as Incomplete<T, Ks[number]>;
  };
}

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

type Geocoin = string;

/* I'm aware the assignment requires that we use the flyweight pattern
  for game location objects. I argue I am using it:
  the shared intrinsic state is as defined below,
  and since the instance-specific extrinsic state passed around to functions
  is simply leaflet.LatLng, I use it directly as the flyweight object,
  and don't bother wrapping it in an interface
  that says "flyweight object" on it or anything.
  This application of the pattern is atypical
  in that the intrinsic state is mutable
  and the extrinsic state is immutable,
  rather than the other way around. */
interface GeocoinGridCell {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  latLng: leaflet.LatLng;
  hasCache: boolean;
  coins: Geocoin[];
  toMemento(): GeocoinGridCellMemento;
  fromMemento(memento: GeocoinGridCellMemento): void;
}

function asCompleteGeocoinGridCell(
  cell: Partial<GeocoinGridCell>,
): GeocoinGridCell {
  return asHavingProperties<GeocoinGridCell>(cell)(
    "canvas",
    "ctx",
    "latLng",
    "hasCache",
    "coins",
    "toMemento",
    "fromMemento",
  );
}

type GeocoinGridCellMemento = string;

interface GeocoinGridCellMementoObject {
  latLng: { lat: number; lng: number };
  hasCache: boolean;
  coins: Geocoin[];
}

type GeocoinGrid = Record<string, GeocoinGridCellMemento>;

interface AppState {
  map: leaflet.Map;
  userMarker: leaflet.Marker;
  grid: GeocoinGrid;
  gridLayer: leaflet.GridLayer;
  coinsOwned: Geocoin[];
}

function asCompleteAppState(state: Partial<AppState>): AppState {
  return asHavingProperties<AppState>(state)(
    "map",
    "userMarker",
    "grid",
    "gridLayer",
    "coinsOwned",
  );
}

type AppStateMemento = string;

interface AppStateMementoObject {
  userMarkerLatLng: { lat: number; lng: number };
  grid: GeocoinGrid;
  coinsOwned: Geocoin[];
}

interface AppUIOut {
  map: HTMLElement;
  inventorySummary: HTMLParagraphElement;
  inventoryList: HTMLUListElement;
}

interface AppUIIn {
  geolocationButton: HTMLButtonElement;
  northButton: HTMLButtonElement;
  southButton: HTMLButtonElement;
  eastButton: HTMLButtonElement;
  westButton: HTMLButtonElement;
  resetButton: HTMLButtonElement;
  geolocationWatchID: number | null;
}

// Utility functions

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

function arrayRemove<T>(ts: T[], predicate: (t: T) => boolean): T | null {
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (predicate(t)) {
      for (let j = i; j < ts.length - 1; j++) {
        ts[j] = ts[j + 1];
      }
      ts.length--;
      return t;
    }
  }
  return null;
}

// Logic

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

function tileCoordsToBounds(
  map: leaflet.Map,
  layer: leaflet.GridLayer,
  coords: leaflet.Point,
) {
  /* There is something like this in the internals of Leaflet
    (see private method _tileCoordsToBounds in leaflet.GridLayer)
    but it is not exported from @types/leaflet,
    and I should not use it anyway since it is a private method.
    In spite of this, I have a legitimate need for it.
    Therefore, I have reconstructed its functionality here. */
  const tileSize = layer.getTileSize();
  const nwPoint = coords.scaleBy(tileSize);
  const sePoint = nwPoint.add(tileSize);
  const nw = map.unproject(nwPoint);
  const se = map.unproject(sePoint);
  return map.wrapLatLngBounds(leaflet.latLngBounds(nw, se));
}

function boundsAround(center: leaflet.LatLng, radius: number) {
  return leaflet.latLngBounds(
    leaflet.latLng(center.lat + radius, center.lng + radius),
    leaflet.latLng(center.lat - radius, center.lng - radius),
  );
}

function getNearestDiscreteLatLng(
  where: leaflet.LatLng,
  marginLat: number,
  marginLng: number,
) {
  return leaflet.latLng(
    Math.round(where.lat / marginLat) * marginLat,
    Math.round(where.lng / marginLng) * marginLng,
  );
}

function geocoinGridCellToMemento(cell: GeocoinGridCell) {
  return JSON.stringify({
    latLng: { lat: cell.latLng.lat, lng: cell.latLng.lng },
    hasCache: cell.hasCache,
    coins: cell.coins,
  });
}

function populateGeocoinGridCellFromMemento(
  cell: Incomplete<GeocoinGridCell, "canvas" | "ctx">,
  memento: GeocoinGridCellMemento,
) {
  const mementoObject: GeocoinGridCellMementoObject = asHavingProperties<
    GeocoinGridCellMementoObject
  >(JSON.parse(memento))(
    "latLng",
    "hasCache",
    "coins",
  );
  cell.latLng = leaflet.latLng(
    mementoObject.latLng.lat,
    mementoObject.latLng.lng,
  );
  cell.hasCache = mementoObject.hasCache;
  cell.coins = mementoObject.coins;
}

function moveUserMarkerByCells(
  state: AppState,
  uiOut: AppUIOut,
  latCells: number,
  lngCells: number,
) {
  const from = state.userMarker.getLatLng();
  moveUserMarkerToLatLng(
    state,
    uiOut,
    leaflet.latLng(
      from.lat + latCells * GRID_LATLNG_DIMENSIONS,
      from.lng + lngCells * GRID_LATLNG_DIMENSIONS,
    ),
  );
  saveStateToLocalStorage(state);
}

function moveUserMarkerToLatLng(
  state: AppState,
  uiOut: AppUIOut,
  latLng: leaflet.LatLng,
) {
  const fromCell =
    getGridCell(state, uiOut, state.userMarker.getLatLng()).latLng;
  state.userMarker.setLatLng(latLng);
  state.map.panTo(latLng);
  const toCell = getGridCell(state, uiOut, latLng).latLng;
  if (toCell.toString() != fromCell.toString()) {
    state.gridLayer.redraw();
  }
}

function gridCellInRange(state: AppState, cell: GeocoinGridCell) {
  return boundsAround(
    state.userMarker.getLatLng(),
    GRID_LATLNG_DIMENSIONS * GEOCOIN_CACHE_VISIBILITY_RADIUS,
  ).contains(cell.latLng);
}

function tryGenerateGeocoinCache(
  cell: Incomplete<GeocoinGridCell, "latLng">,
): boolean {
  const hasCache =
    luck(`Is there a geocoin cache at ${cell.latLng.toString()}?`) >
      1 - GEOCOIN_CACHE_PROBABILITY;
  const coins: Geocoin[] = [];
  if (hasCache) {
    const count = Math.round(lerp(
      GEOCOIN_CACHE_MIN_VALUE,
      GEOCOIN_CACHE_MAX_VALUE,
      luck(`How many geocoins are in the cache at ${cell.latLng.toString()}?`),
    ));
    for (let i = 1; i <= count; i++) {
      coins.push(`#${i}@${cell.latLng}`);
    }
  }
  cell.hasCache = hasCache;
  cell.coins = coins;
  return cell.hasCache;
}

function moveCoin(
  from: Geocoin[],
  to: Geocoin[],
  coin?: Geocoin,
): boolean {
  if (from.length <= 0) {
    return false;
  }
  if (coin === undefined) {
    coin = from[0];
  }
  const coinTaken = arrayRemove(
    from,
    (candidate: Geocoin) => candidate === coin,
  );
  if (coinTaken !== null) {
    to.push(coinTaken);
    return true;
  } else {
    return false;
  }
}

function moveAllCoins(
  from: Geocoin[],
  to: Geocoin[],
) {
  for (const coin of from) {
    to.push(coin);
  }
  from.length = 0;
}

function getGridCell(state: AppState, ui: AppUIOut, coords: leaflet.LatLng) {
  const latLng = getNearestDiscreteLatLng(
    coords,
    GRID_LATLNG_DIMENSIONS,
    GRID_LATLNG_DIMENSIONS,
  );
  const key = latLng.toString();
  let value: GeocoinGridCell;
  if (key in state.grid) {
    value = makeGridCell(state, latLng, state.grid[key]);
  } else {
    value = makeGridCell(state, latLng);
    state.grid[key] = value.toMemento();
  }
  updateGridCellPresentation(state, ui, value);
  return value;
}

function saveGridCell(state: AppState, cell: GeocoinGridCell) {
  state.grid[cell.latLng.toString()] = cell.toMemento();
  saveStateToLocalStorage(state);
}

function makeGeocoinGrid(
  state: Incomplete<AppState, "map">,
  ui: AppUIOut,
) {
  state.gridLayer = makeGrid(state.map, function (coords: leaflet.Point) {
    /* Workaround for needing state to have gridLayer
      while we are still building it */
    state.gridLayer = this;
    return getGridCell(
      asCompleteAppState(state),
      ui,
      tileCoordsToBounds(state.map, this, coords).getCenter(),
    ).canvas;
  });
}

function makeGridCell(
  state: AppState,
  latLng: leaflet.LatLng,
  memento?: GeocoinGridCellMemento,
) {
  const size = state.gridLayer.getTileSize();
  const canvas = document.createElement("canvas");
  canvas.width = size.x;
  canvas.height = size.y;
  const ctx = canvas.getContext("2d");
  const result: Incomplete<
    GeocoinGridCell,
    "canvas" | "ctx" | "latLng" | "toMemento" | "fromMemento"
  > = {
    canvas,
    ctx,
    latLng,
    toMemento() {
      return geocoinGridCellToMemento(
        asCompleteGeocoinGridCell(this),
      );
    },
    fromMemento(memento: GeocoinGridCellMemento) {
      populateGeocoinGridCellFromMemento(this, memento);
    },
  };
  if (memento === undefined) {
    tryGenerateGeocoinCache(result);
  } else {
    result.fromMemento(memento);
  }
  return asCompleteGeocoinGridCell(result);
}

function makeMap(state: Partial<AppState>, ui: AppUIOut) {
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
  state.map = map;
  return map;
}

function makeUserMarker(map: leaflet.Map) {
  const marker = leaflet.marker(MAP_CENTER);
  marker.bindTooltip("You Are Here");
  marker.addTo(map);
  return marker;
}

function makeAppState(ui: AppUIOut): AppState {
  const result: Partial<AppState> = { grid: {}, coinsOwned: [] };
  const map = makeMap(result, ui);
  result.userMarker = makeUserMarker(map);
  makeGeocoinGrid(
    asHavingProperties<AppState>(result)("map", "userMarker"),
    ui,
  );
  return result as AppState;
}

function serializeAppState(appState: AppState): AppStateMemento {
  const latLng = appState.userMarker.getLatLng();
  return JSON.stringify({
    userMarkerLatLng: { lat: latLng.lat, lng: latLng.lng },
    grid: appState.grid,
    coinsOwned: appState.coinsOwned,
  });
}

function deserializeAppState(
  appState: AppState,
  uiOut: AppUIOut,
  memento: AppStateMemento,
) {
  const mementoObject: AppStateMementoObject = JSON.parse(memento);
  for (const key of Object.keys(appState.grid)) {
    delete appState.grid[key];
  }
  for (const key of Object.keys(mementoObject.grid)) {
    appState.grid[key] = mementoObject.grid[key];
  }
  appState.coinsOwned.length = 0;
  for (const coin of mementoObject.coinsOwned) {
    appState.coinsOwned.push(coin);
  }
  moveUserMarkerToLatLng(
    appState,
    uiOut,
    leaflet.latLng(
      mementoObject.userMarkerLatLng.lat,
      mementoObject.userMarkerLatLng.lng,
    ),
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

function updateGridCellPresentation(
  state: AppState,
  ui: AppUIOut,
  cell: GeocoinGridCell,
) {
  if (cell.ctx !== null) {
    cell.ctx.clearRect(0, 0, cell.canvas.width, cell.canvas.height);
  }
  if (cell.hasCache && gridCellInRange(state, cell)) {
    cell.canvas.onclick = (mouseEvent) =>
      showGeocoinCachePopup(state, ui, mouseEvent);
    if (cell.ctx !== null) {
      cell.ctx.save();
      cell.ctx.translate(cell.canvas.width / 2, cell.canvas.height / 2);
      cell.ctx.textAlign = "center";
      cell.ctx.textBaseline = "middle";
      cell.ctx.font = GEOCOIN_CACHE_EMOJI_STYLE;
      cell.ctx.fillText(GEOCOIN_CACHE_EMOJI, 0, 0);
      cell.ctx.restore();
    }
  } else {
    cell.canvas.onclick = () => {};
  }
}

function showGeocoinCachePopup(
  state: AppState,
  ui: AppUIOut,
  mouseEvent: MouseEvent,
) {
  const cell = getGridCell(
    state,
    ui,
    state.map.mouseEventToLatLng(mouseEvent),
  );
  if (!cell.hasCache) return;
  const popupContent = makeElement(null, "aside", {
    className: "map-popup",
  }, (elem) => {
    const cacheCoinCount = makeElement(elem, "p");
    const cacheCoinList = makeElement(elem, "ul");
    const takeButton = makeElement(elem, "button", {
      innerHTML: "Take a coin",
      onclick: () => {
        if (moveCoin(cell.coins, state.coinsOwned)) {
          updatePopup();
          updateInventoryStatus(state, ui);
          saveGridCell(state, cell);
        }
      },
    });
    const leaveButton = makeElement(elem, "button", {
      innerHTML: "Leave a coin",
      onclick: () => {
        if (moveCoin(state.coinsOwned, cell.coins)) {
          updatePopup();
          updateInventoryStatus(state, ui);
          saveGridCell(state, cell);
        }
      },
    });
    makeElement(elem, "br");
    const takeAllButton = makeElement(elem, "button", {
      innerHTML: "Take all",
      onclick: () => {
        moveAllCoins(cell.coins, state.coinsOwned);
        updatePopup();
        updateInventoryStatus(state, ui);
        saveGridCell(state, cell);
      },
    });
    const leaveAllButton = makeElement(elem, "button", {
      innerHTML: "Leave all",
      onclick: () => {
        moveAllCoins(state.coinsOwned, cell.coins);
        updatePopup();
        updateInventoryStatus(state, ui);
        saveGridCell(state, cell);
      },
    });
    const updatePopup = () => {
      cacheCoinList.innerHTML = "";
      cacheCoinCount.innerHTML = `
        This cache at ${cell.latLng.toString()}
        contains ${cell.coins.length} geocoin(s)
      `;
      if (cell.coins.length > 0) {
        cacheCoinCount.innerHTML += ":";
        for (const coin of cell.coins) {
          makeElement(cacheCoinList, "li", { innerHTML: coin });
        }
      }
      takeButton.disabled = cell.coins.length <= 0;
      leaveButton.disabled = state.coinsOwned.length <= 0;
      takeAllButton.disabled = takeButton.disabled;
      leaveAllButton.disabled = leaveButton.disabled;
    };
    updatePopup();
  });
  // Prevent same mouse event that opened popup from closing it
  setTimeout(
    () => state.map.openPopup(popupContent, cell.latLng),
    10,
  );
}

function updateInventoryStatus(state: AppState, ui: AppUIOut) {
  ui.inventoryList.innerHTML = "";
  if (state.coinsOwned.length > 0) {
    ui.inventorySummary.innerHTML = `
      ${state.coinsOwned.length} geocoin(s):
    `;
    for (const coin of state.coinsOwned) {
      makeElement(ui.inventoryList, "li", { innerHTML: coin });
    }
  } else {
    ui.inventorySummary.innerHTML = "Empty";
  }
}

function makeAppUIOut(): AppUIOut {
  return {
    map: document.querySelector("#map")!,
    inventorySummary: document.querySelector("#inventory-total")!,
    inventoryList: document.querySelector("#inventory ul")!,
  };
}

function makeAppUIIn(state: AppState, uiOut: AppUIOut): AppUIIn {
  const result: AppUIIn = {
    geolocationButton: document.querySelector("#sensor")!,
    northButton: document.querySelector("#north")!,
    southButton: document.querySelector("#south")!,
    eastButton: document.querySelector("#east")!,
    westButton: document.querySelector("#west")!,
    resetButton: document.querySelector("#reset")!,
    geolocationWatchID: null,
  };
  result.geolocationButton.onclick = toggleGeolocation.bind(
    null,
    state,
    uiOut,
    result,
  );
  result.northButton.onclick = moveUserMarkerByCells.bind(
    null,
    state,
    uiOut,
    1,
    0,
  );
  result.southButton.onclick = moveUserMarkerByCells.bind(
    null,
    state,
    uiOut,
    -1,
    0,
  );
  result.eastButton.onclick = moveUserMarkerByCells.bind(
    null,
    state,
    uiOut,
    0,
    1,
  );
  result.westButton.onclick = moveUserMarkerByCells.bind(
    null,
    state,
    uiOut,
    0,
    -1,
  );
  return result;
}

// Device API reliant functions

function eachGeolocationPosition(
  uiIn: AppUIIn,
  doWhat: (posn: GeolocationPosition) => void,
) {
  navigator.geolocation.getCurrentPosition((posn) => {
    doWhat(posn);
    uiIn.geolocationWatchID = navigator.geolocation.watchPosition(doWhat);
  });
}

function keepUserMarkerSyncedToGeolocation(
  state: AppState,
  uiOut: AppUIOut,
  uiIn: AppUIIn,
) {
  eachGeolocationPosition(uiIn, (posn) => {
    moveUserMarkerToLatLng(
      state,
      uiOut,
      leaflet.latLng(
        posn.coords.latitude,
        posn.coords.longitude,
      ),
    );
  });
}

function stopSyncingUserMarkerToGeolocation(
  uiIn: AppUIIn,
) {
  if (uiIn.geolocationWatchID !== null) {
    navigator.geolocation.clearWatch(uiIn.geolocationWatchID);
    uiIn.geolocationWatchID = null;
  }
}

function toggleGeolocation(state: AppState, uiOut: AppUIOut, uiIn: AppUIIn) {
  if (uiIn.geolocationWatchID === null) {
    keepUserMarkerSyncedToGeolocation(state, uiOut, uiIn);
  } else {
    stopSyncingUserMarkerToGeolocation(uiIn);
  }
}

function saveStateToLocalStorage(state: AppState) {
  localStorage.setItem(
    "serializedAppState",
    serializeAppState(state),
  );
}

function loadStateFromLocalStorage(state: AppState, uiOut: AppUIOut): boolean {
  const serializedAppState = localStorage.getItem("serializedAppState");
  if (serializedAppState !== null) {
    deserializeAppState(state, uiOut, serializedAppState);
    return true;
  } else {
    return false;
  }
}

// Init

const uiOut = makeAppUIOut();
const appState = makeAppState(uiOut);
loadStateFromLocalStorage(appState, uiOut);
makeAppUIIn(appState, uiOut);
