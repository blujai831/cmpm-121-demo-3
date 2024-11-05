// @deno-types="npm:@types/leaflet@^1.9.14"
import leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./leafletWorkaround.ts";

// Types and POD or POD-like constants

const MAP_CENTER = leaflet.latLng(36.98949379578401, -122.06277128548504);
const MAP_ZOOM = 19;
const MAP_DATA_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAP_ATTRIBUTION =
  `&copy; <a href="http://www.openstreetmap.org/copyright">
    OpenStreetMap
  </a>`;

// Element constants

const mapFigure: HTMLElement = document.querySelector("#map")!;

// Factories

function makeMap() {
  const map = leaflet.map(mapFigure, {
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

function makePlayerMarker(map: leaflet.Map) {
  const playerMarker = leaflet.marker(MAP_CENTER);
  playerMarker.bindTooltip("You Are Here");
  playerMarker.addTo(map);
  return playerMarker;
}

// Object constants

const map = makeMap();

// Init

makePlayerMarker(map);
