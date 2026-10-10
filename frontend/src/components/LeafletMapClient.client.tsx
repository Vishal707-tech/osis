import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LeafletMapProps } from "./leaflet-types";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  Marker as LeafletMarker,
  Polyline,
  Polygon,
  Rectangle,
  Circle,
  ImageOverlay,
  Popup,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export const DEFAULT_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const DEFAULT_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/**
 * Coordinate normalizer: converts [lon, lat] to [lat, lon] if detected in reverse order.
 * In India/Arabian Sea sector, Longitudes are ~65°E-80°E, Latitudes are ~10°N-25°N.
 */
export function normalizeLatLng(coord: [number, number]): [number, number] {
  const [a, b] = coord;
  if (Math.abs(a) > 45 && Math.abs(b) <= 45) {
    return [b, a];
  }
  return [a, b];
}

/**
 * Normalizes zoom level: maps legacy 1..3 multiplier scale to Leaflet scale (8..12).
 */
export function normalizeZoom(zoom: number | undefined): number {
  if (zoom === undefined) return 9;
  if (zoom <= 3.5) {
    return Math.round(8 + zoom * 1.5);
  }
  return Math.round(zoom);
}

/**
 * Tactical SVG marker icon generator matching the O.S.I.S. maritime radar palette.
 */
export function createTacticalIcon({
  color = "var(--accent-blue)",
  label,
  active = false,
  pulse = false,
}: {
  color?: string | undefined;
  label?: string | undefined;
  active?: boolean | undefined;
  pulse?: boolean | undefined;
} = {}) {
  const size = active ? 26 : 18;
  const pulseHtml = pulse
    ? `<div class="osis-marker-pulse" style="position:absolute;inset:-8px;border-radius:9999px;border:2px solid ${color};background:${color};opacity:0.25;pointer-events:none;"></div>`
    : "";
  const labelHtml = label
    ? `<div style="position:absolute;left:${size + 6}px;top:50%;transform:translateY(-50%);white-space:nowrap;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;font-weight:600;color:#f8fafc;text-shadow:0 1px 3px rgba(0,0,0,0.9);background:rgba(15,23,42,0.85);padding:2px 7px;border-radius:3px;border:1px solid rgba(255,255,255,0.2);pointer-events:none;">${label}</div>`
    : "";

  return L.divIcon({
    className: "osis-tactical-marker",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `
      <div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;cursor:pointer;">
        ${pulseHtml}
        <div style="position:absolute;inset:0;border-radius:9999px;border:${active ? 2.5 : 1.5}px solid ${color};background:${color}26;"></div>
        <div style="position:absolute;width:${active ? 10 : 6}px;height:${active ? 10 : 6}px;border-radius:9999px;background:${color};box-shadow:0 0 8px ${color};"></div>
        ${labelHtml}
      </div>
    `,
  });
}

function MapViewController({
  center,
  zoom,
  bounds,
}: {
  center: [number, number];
  zoom: number;
  bounds?: [[number, number], [number, number]] | undefined;
}) {
  const map = useMap();
  const lastCenterRef = useRef<string>("");

  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 150);
    return () => clearTimeout(timer);
  }, [map]);

  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [25, 25], maxZoom: 12 });
      return;
    }
    const key = `${center[0].toFixed(4)},${center[1].toFixed(4)},${zoom}`;
    if (lastCenterRef.current !== key) {
      lastCenterRef.current = key;
      map.setView(center, zoom, { animate: true });
    }
  }, [center, zoom, bounds, map]);

  return null;
}

function MapControlsOverlay({
  initialCenter,
  initialZoom,
  legend,
}: {
  initialCenter: [number, number];
  initialZoom: number;
  legend?: ReactNode | undefined;
}) {
  const map = useMap();
  const btn =
    "h-7 w-7 rounded border border-border bg-card text-foreground font-mono text-xs transition-colors hover:bg-secondary flex items-center justify-center shadow-xs cursor-pointer";

  return (
    <div className="pointer-events-none absolute inset-0 z-[1000] flex flex-col justify-between p-3">
      <div className="flex items-start justify-between gap-3">
        {legend ? (
          <div className="pointer-events-auto rounded border border-border bg-card/95 backdrop-blur-xs px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-xs font-mono max-w-xs">
            {legend}
          </div>
        ) : (
          <span />
        )}

        <div className="pointer-events-auto flex flex-col gap-1.5">
          <button
            type="button"
            aria-label="Zoom in"
            className={btn}
            onClick={() => map.zoomIn()}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            className={btn}
            onClick={() => map.zoomOut()}
            title="Zoom Out"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset view"
            className={btn}
            onClick={() => map.setView(initialCenter, initialZoom)}
            title="Reset View"
          >
            ⤾
          </button>
        </div>
      </div>

      <MapStatusFooter />
    </div>
  );
}

function MapStatusFooter() {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  const [cursorCoords, setCursorCoords] = useState<string | null>(null);

  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
    mousemove: (e) => {
      setCursorCoords(
        `${e.latlng.lat.toFixed(2)}°N, ${e.latlng.lng.toFixed(2)}°E`
      );
    },
    mouseout: () => setCursorCoords(null),
  });

  return (
    <div className="flex items-end justify-between text-[11px] text-muted-foreground font-mono">
      <span className="pointer-events-auto rounded bg-card/95 px-2 py-0.5 border border-border">
        Arabian Sea Sector {cursorCoords ? `· Cursor: ${cursorCoords}` : "· Drag to pan · Scroll to zoom"}
      </span>
      <span className="pointer-events-auto rounded bg-card/95 px-2 py-0.5 tabular-nums border border-border text-[var(--accent-blue)]">
        ZOOM {zoom}
      </span>
    </div>
  );
}

export type { LeafletMapProps };

export function LeafletMapClient({
  children,
  height = 460,
  initialZoom = 9,
  initialCenter = [15.25, 72.45],
  center,
  bounds,
  legend,
  tileUrl = DEFAULT_TILE_URL,
  tileAttribution = DEFAULT_TILE_ATTRIBUTION,
  className = "",
}: LeafletMapProps) {
  const targetCenter = center ?? initialCenter;
  const normCenter = useMemo(
    () => normalizeLatLng(targetCenter),
    [targetCenter]
  );
  const normZoom = useMemo(
    () => normalizeZoom(initialZoom),
    [initialZoom]
  );

  return (
    <div
      className={`relative overflow-hidden rounded border border-border osis-map-wrapper ${className}`}
      style={{ height }}
    >
      <MapContainer
        center={normCenter}
        zoom={normZoom}
        zoomControl={false}
        scrollWheelZoom={true}
        className="h-full w-full osis-leaflet-map"
        style={{ height: "100%", width: "100%", background: "var(--map-bg)" }}
      >
        <TileLayer
          url={tileUrl}
          attribution={tileAttribution}
          maxZoom={18}
        />
        <MapViewController center={normCenter} zoom={normZoom} bounds={bounds} />
        <MapControlsOverlay
          initialCenter={normCenter}
          initialZoom={normZoom}
          legend={legend}
        />
        {children}
      </MapContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaflet Layer Wrappers
// ---------------------------------------------------------------------------

export function MapMarker({
  position,
  lat,
  lon,
  color = "var(--accent-blue)",
  label,
  active,
  pulse,
  onClick,
  children,
  ...rest
}: {
  position?: [number, number] | undefined;
  lat?: number | undefined;
  lon?: number | undefined;
  color?: string | undefined;
  label?: string | undefined;
  active?: boolean | undefined;
  pulse?: boolean | undefined;
  onClick?: (() => void) | undefined;
  children?: ReactNode | undefined;
  [key: string]: any;
}) {
  const [pLat, pLon] = position
    ? normalizeLatLng(position)
    : lat !== undefined && lon !== undefined
      ? [lat, lon]
      : [15.25, 72.45];

  const icon = useMemo(
    () => createTacticalIcon({ color, label, active, pulse }),
    [color, label, active, pulse]
  );

  const markerProps: any = {
    position: [pLat, pLon],
    icon,
    ...rest,
  };
  if (onClick) {
    markerProps.eventHandlers = { click: onClick };
  }

  return <LeafletMarker {...markerProps}>{children}</LeafletMarker>;
}

export function MapGeoJSON({
  data,
  style,
  onEachFeature,
  ...rest
}: {
  data: any;
  style?: L.PathOptions | ((feature: any) => L.PathOptions) | undefined;
  onEachFeature?: ((feature: any, layer: L.Layer) => void) | undefined;
  [key: string]: any;
}) {
  if (!data) return null;
  const key = useMemo(() => {
    try {
      return JSON.stringify(data.geometry || data);
    } catch {
      return "geojson";
    }
  }, [data]);

  const props: any = { key, data, ...rest };
  if (style !== undefined) props.style = style;
  if (onEachFeature !== undefined) props.onEachFeature = onEachFeature;

  return <GeoJSON {...props} />;
}

export function MapPolyline({
  positions,
  pathOptions,
  children,
  ...rest
}: {
  positions: [number, number][];
  pathOptions?: L.PolylineOptions | undefined;
  children?: ReactNode | undefined;
  [key: string]: any;
}) {
  if (!positions || positions.length < 2) return null;
  const props: any = { positions, ...rest };
  if (pathOptions !== undefined) props.pathOptions = pathOptions;
  return <Polyline {...props}>{children}</Polyline>;
}

export function MapPolygon({
  positions,
  pathOptions,
  children,
  ...rest
}: {
  positions: [number, number][] | [number, number][][];
  pathOptions?: L.PolylineOptions | undefined;
  children?: ReactNode | undefined;
  [key: string]: any;
}) {
  if (!positions) return null;
  const props: any = { positions, ...rest };
  if (pathOptions !== undefined) props.pathOptions = pathOptions;
  return <Polygon {...props}>{children}</Polygon>;
}

export function MapRectangle({
  bounds,
  pathOptions,
  children,
  ...rest
}: {
  bounds: [[number, number], [number, number]];
  pathOptions?: L.PathOptions | undefined;
  children?: ReactNode | undefined;
  [key: string]: any;
}) {
  if (!bounds) return null;
  const props: any = { bounds, ...rest };
  if (pathOptions !== undefined) props.pathOptions = pathOptions;
  return <Rectangle {...props}>{children}</Rectangle>;
}

export function MapCircle({
  center,
  radius,
  pathOptions,
  children,
  ...rest
}: {
  center: [number, number];
  radius: number;
  pathOptions?: L.CircleMarkerOptions | undefined;
  children?: ReactNode | undefined;
  [key: string]: any;
}) {
  const normCenter = normalizeLatLng(center);
  const props: any = { center: normCenter, radius, ...rest };
  if (pathOptions !== undefined) props.pathOptions = pathOptions;
  return <Circle {...props}>{children}</Circle>;
}

export function MapImageOverlay({
  url,
  bounds,
  opacity = 0.85,
  children,
  ...rest
}: {
  url: string;
  bounds: [[number, number], [number, number]];
  opacity?: number | undefined;
  children?: ReactNode | undefined;
  [key: string]: any;
}) {
  if (!url || !bounds) return null;
  const props: any = { url, bounds, opacity, ...rest };
  return <ImageOverlay {...props}>{children}</ImageOverlay>;
}

export { Popup, Tooltip, useMap, useMapEvents };
