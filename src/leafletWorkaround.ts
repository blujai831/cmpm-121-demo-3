// @deno-types="npm:@types/leaflet@^1.9.14"
import leaflet from "leaflet";

// Work around bug in Leaflet (https://github.com/Leaflet/Leaflet/issues/4968)
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";

delete (leaflet.Icon.Default.prototype as unknown as { _getIconUrl: unknown })
  ._getIconUrl;
leaflet.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });

// Workaround for lack of any way to instantiate an extended layer type
export function leafletExtend<LayerType>(
  layerType: leaflet.Class & {
    extend: (extensions: object) => new (...args: unknown[]) => LayerType;
  },
  extensions: object,
) {
  return layerType.extend(extensions);
}
