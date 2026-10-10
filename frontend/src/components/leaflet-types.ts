import type { ReactNode } from "react";

export type LeafletMapProps = {
  children?: ReactNode | undefined;
  height?: number | string | undefined;
  initialZoom?: number | undefined;
  initialCenter?: [number, number] | undefined;
  center?: [number, number] | undefined;
  bounds?: [[number, number], [number, number]] | undefined;
  legend?: ReactNode | undefined;
  tileUrl?: string | undefined;
  tileAttribution?: string | undefined;
  className?: string | undefined;
};
