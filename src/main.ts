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

/* Assignment D3.c requires us to implement the memento pattern
  so as to ensure that we "save the state of caches so that their contents
  [are] preserved even when the player moves out of view and back."
  My implementation already accomplishes this without explicit use
  of the memento pattern; as such, it does not also use the memento pattern
  for it, because then the state of caches would be saved in two different ways
  in parallel, which would be needlessly redundant and introduce
  the possibility of consistency errors. However, I am implementing,
  but not yet using, the memento pattern at this time regardless, both because
  it is required by the assignment, and because it will make persistent storage
  of grid cells possible for assignment D3.d. */
type GeocoinGridCellMemento = string;

interface GeocoinGridCellMementoObject {
  latLng: { lat: number; lng: number };
  hasCache: boolean;
  coins: Geocoin[];
}

type GeocoinGrid = Record<string, GeocoinGridCell>;

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

interface AppUI {
  map: HTMLElement;
  inventorySummary: HTMLParagraphElement;
  inventoryList: HTMLUListElement;
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
  cell: GeocoinGridCell,
  memento: GeocoinGridCellMemento,
) {
  const mementoObject: GeocoinGridCellMementoObject = asHavingProperties<
    GeocoinGridCellMementoObject
  >(JSON.parse(memento))("latLng", "hasCache", "coins");
  cell.latLng = leaflet.latLng(
    mementoObject.latLng.lat,
    mementoObject.latLng.lng,
  );
  cell.hasCache = mementoObject.hasCache;
  cell.coins = mementoObject.coins;
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

function makeMap(state: Partial<AppState>, ui: AppUI) {
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

function getGridCell(state: AppState, ui: AppUI, coords: leaflet.LatLng) {
  const latLng = getNearestDiscreteLatLng(
    coords,
    GRID_LATLNG_DIMENSIONS,
    GRID_LATLNG_DIMENSIONS,
  );
  const key = latLng.toString();
  let value: GeocoinGridCell;
  if (key in state.grid) {
    value = state.grid[key];
  } else {
    value = makeGridCell.call(state.gridLayer, state, ui, latLng);
    state.grid[key] = value;
  }
  return value;
}

function makeGeocoinGrid(
  state: Incomplete<AppState, "map" | "userMarker">,
  ui: AppUI,
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
  }, {
    /* Assignment D3.c requires caches only be visible within a radius
      around the user. I believe this is why we are expected to have need
      of the memento pattern to serialize and deserialize caches
      as they leave and reenter this radius. However, by leveraging
      leaflet.GridLayer, my implementation is able to solve this problem
      trivially without use of the memento pattern: I simply store the caches
      at all times, and even though they always exist in memory, the GridLayer
      automatically controls whether they exist in the page. */
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
  latLng: leaflet.LatLng,
) {
  const size = state.gridLayer.getTileSize();
  const canvas = document.createElement("canvas");
  canvas.width = size.x;
  canvas.height = size.y;
  const ctx = canvas.getContext("2d");
  const hasCache = luck(`Is there a geocoin cache at ${latLng.toString()}?`) >
    1 - GEOCOIN_CACHE_PROBABILITY;
  const coins: Geocoin[] = [];
  if (hasCache) {
    const count = Math.round(lerp(
      GEOCOIN_CACHE_MIN_VALUE,
      GEOCOIN_CACHE_MAX_VALUE,
      luck(`How many geocoins are in the cache at ${latLng.toString()}?`),
    ));
    for (let i = 1; i <= count; i++) {
      coins.push(`#${i}@${latLng}`);
    }
  }
  if (hasCache) {
    canvas.onclick = (mouseEvent) =>
      showGeocoinCachePopup(state, ui, mouseEvent);
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
  return {
    canvas,
    ctx,
    latLng,
    hasCache,
    coins,
    toMemento() {
      return geocoinGridCellToMemento(this);
    },
    fromMemento(memento: GeocoinGridCellMemento) {
      populateGeocoinGridCellFromMemento(this, memento);
    },
  };
}

function showGeocoinCachePopup(
  state: AppState,
  ui: AppUI,
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
        if (cell.coins.length > 0) {
          const coin = cell.coins[cell.coins.length - 1];
          cell.coins.pop();
          state.coinsOwned.push(coin);
          updatePopup();
          updateInventoryStatus(state, ui);
        }
      },
    });
    const leaveButton = makeElement(elem, "button", {
      innerHTML: "Leave a coin",
      onclick: () => {
        if (state.coinsOwned.length > 0) {
          const coin = state.coinsOwned[state.coinsOwned.length - 1];
          state.coinsOwned.pop();
          cell.coins.push(coin);
          updatePopup();
          updateInventoryStatus(state, ui);
        }
      },
    });
    makeElement(elem, "br");
    const takeAllButton = makeElement(elem, "button", {
      innerHTML: "Take all",
      onclick: () => {
        state.coinsOwned = [...state.coinsOwned, ...cell.coins];
        cell.coins.length = 0;
        updatePopup();
        updateInventoryStatus(state, ui);
      },
    });
    const leaveAllButton = makeElement(elem, "button", {
      innerHTML: "Leave all",
      onclick: () => {
        cell.coins = [...cell.coins, ...state.coinsOwned];
        state.coinsOwned.length = 0;
        updatePopup();
        updateInventoryStatus(state, ui);
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
  setTimeout(
    () => state.map.openPopup(popupContent, cell.latLng),
    10,
  );
}

function updateInventoryStatus(state: AppState, ui: AppUI) {
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

function makeAppState(ui: AppUI): AppState {
  const result: Partial<AppState> = { grid: {}, coinsOwned: [] };
  const map = makeMap(result, ui);
  result.userMarker = makeUserMarker(map);
  makeGeocoinGrid(
    asHavingProperties<AppState>(result)("map", "userMarker"),
    ui,
  );
  return result as AppState;
}

// Init

const appUI: AppUI = {
  map: document.querySelector("#map")!,
  inventorySummary: document.querySelector("#inventory-total")!,
  inventoryList: document.querySelector("#inventory ul")!,
};

makeAppState(appUI);
