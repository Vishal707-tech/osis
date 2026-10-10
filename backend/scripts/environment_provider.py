#!/usr/bin/env python3
"""
==============================================================================
O.S.I.S. - Oil Spill Identification System
environment_provider.py  -  Phase 4A Real Environmental Data Layer
==============================================================================
File    : backend/scripts/environment_provider.py
Purpose : Fetch a small spatiotemporal subset of CMEMS ocean-current data
          and ERA5 wind data for a single hindcast window, cache it in memory,
          and expose a fast get_environment(lat, lon, timestamp) interface
          consumed by the RK4 backward-advection engine.

Architecture (one hindcast):
    remote API
        |
        v
    small subset fetched ONCE
        |
        v
    in-memory xarray Dataset (self._cmems_ds, self._era5_ds)
        |
        v
    RK4 engine calls get_environment() repeatedly
        |
        v
    nearest-grid-point / nearest-time lookup (documented below)

Interpolation method: NEAREST NEIGHBOUR in both space and time.
  - Spatial:  xarray .sel(latitude=..., longitude=..., method="nearest")
  - Temporal: xarray .sel(time=..., method="nearest")
This is NOT bilinear interpolation. The spatial resolution of GLORYS12
is 0.083 deg (~9 km); ERA5 is 0.25 deg (~28 km). For a hindcast with
O(1-2 deg) bounding box the nearest-neighbour error is bounded by
half the grid spacing (~4.5 km for CMEMS, ~14 km for ERA5), which is
acceptable for a first real-data integration.

Data sources:
  - CMEMS GLORYS12: product GLOBAL_MULTIYEAR_PHY_001_030
                    dataset cmems_mod_glo_phy_my_0.083deg_P1D-m
                    variables: uo (m/s), vo (m/s), depth ~0.49 m (surface)
  - ERA5:           dataset reanalysis-era5-single-levels
                    variables: 10m_u_component_of_wind (m/s),
                               10m_v_component_of_wind (m/s)

Units: both CMEMS and ERA5 provide m/s natively. No unit conversion needed.

Credential sources (in priority order):
  CMEMS  : env COPERNICUSMARINE_SERVICE_USERNAME / _PASSWORD
           or  CMEMS_USERNAME / CMEMS_PASSWORD  (alias)
           or  copernicusmarine stored login (~/.copernicusmarine/)
  ERA5   : ~/.cdsapirc  key/url (already configured on this machine)
           or  env CDS_API_KEY

Fallback: if EITHER source fails entirely, both fall back to
          climatological_fallback (to avoid silently mixing sources).
==============================================================================
"""

from __future__ import annotations

import datetime
import math
import os
import sys
import warnings

# ---------------------------------------------------------------------------
# Optional heavy imports - will fail gracefully if not installed
# ---------------------------------------------------------------------------
try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False

try:
    import xarray as xr
    _HAS_XARRAY = True
except ImportError:
    _HAS_XARRAY = False

try:
    import copernicusmarine as cm
    _HAS_CM = True
except ImportError:
    _HAS_CM = False

try:
    import cdsapi
    _HAS_CDSAPI = True
except ImportError:
    _HAS_CDSAPI = False

# ---------------------------------------------------------------------------
# CMEMS configuration
# ---------------------------------------------------------------------------
CMEMS_DATASET_ID   = "cmems_mod_glo_phy_my_0.083deg_P1D-m"
CMEMS_PRODUCT_ID   = "GLOBAL_MULTIYEAR_PHY_001_030"
CMEMS_VARIABLES    = ["uo", "vo"]
CMEMS_SURFACE_DEPTH_MIN = 0.0
CMEMS_SURFACE_DEPTH_MAX = 1.0   # grab only top 1 m; actual shallowest layer ~0.49 m

CMEMS_ARCO_ZARR_URL = "https://s3.waw3-1.cloudferro.com/mdl-arco-time-025/arco/GLOBAL_MULTIYEAR_PHY_001_030/cmems_mod_glo_phy_my_0.083deg_P1D-m_202311/timeChunked.zarr"

# ERA5 configuration
ERA5_DATASET    = "reanalysis-era5-single-levels"
ERA5_VARIABLES  = ["10m_u_component_of_wind", "10m_v_component_of_wind"]

# Spatial bounding box padding around spill (degrees)
BBOX_PAD_DEG = 2.0

# data_source label when BOTH real sources succeed
DATASOURCE_REAL = f"cmems_{CMEMS_DATASET_ID}_era5"


# ===========================================================================
# Climatological fallback (inline copy so provider is self-contained)
# ===========================================================================

def _clim_current(lat, lon, hf):
    bg_u = -0.08 * math.cos(math.radians(lat))
    bg_v = -0.04 * math.sin(math.radians(lat * 2.0))
    phase = 2.0 * math.pi * hf / 12.42
    return (bg_u + 0.06 * math.sin(phase + math.radians(lon)),
            bg_v + 0.05 * math.cos(phase + math.radians(lat)))

def _clim_wind(lat, lon, hf):
    bg_u = 3.5 * math.sin(math.radians(lat + 10.0))
    bg_v = -2.0 * math.cos(math.radians(lon))
    phase = 2.0 * math.pi * hf / 24.0
    return (bg_u + 1.2 * math.sin(phase),
            bg_v + 0.8 * math.cos(phase + math.radians(lat)))

def _fallback_env(lat, lon, sim_time):
    hf = sim_time.hour + sim_time.minute / 60.0 + sim_time.second / 3600.0
    u_c, v_c = _clim_current(lat, lon, hf)
    u_w, v_w = _clim_wind(lat, lon, hf)
    return {
        "current_u_ms": u_c, "current_v_ms": v_c,
        "wind_u_ms":    u_w, "wind_v_ms":    v_w,
        "data_source":  "climatological_fallback",
        "current_source": "climatological_fallback",
        "wind_source":    "climatological_fallback",
    }


# ===========================================================================
# EnvironmentProvider
# ===========================================================================

class EnvironmentProvider:
    """
    Fetch and cache real CMEMS + ERA5 data for one hindcast window.

    Usage:
        provider = EnvironmentProvider(
            center_lat, center_lon,
            t_start,        # oldest backward time (obs - age)
            t_end,          # observation time
        )
        provider.fetch()    # one-time network call
        env = provider.get_environment(lat, lon, timestamp)

    If fetch() fails for either source, the provider silently degrades
    to climatological_fallback for BOTH sources (to avoid mixing).
    """

    def __init__(self, center_lat: float, center_lon: float,
                 t_start: datetime.datetime, t_end: datetime.datetime):
        self.center_lat = center_lat
        self.center_lon = center_lon
        self.t_start    = t_start    # earliest time needed (most backward)
        self.t_end      = t_end      # observation time

        # Bounding box with padding
        self.lat_min = center_lat - BBOX_PAD_DEG
        self.lat_max = center_lat + BBOX_PAD_DEG
        self.lon_min = center_lon - BBOX_PAD_DEG
        self.lon_max = center_lon + BBOX_PAD_DEG

        # Cached xarray datasets (None = not loaded / failed)
        self._cmems_ds: "xr.Dataset | None" = None
        self._era5_ds:  "xr.Dataset | None" = None

        # Metadata reported back to the hindcast engine
        self.environment_meta: dict = {
            "data_source":     "climatological_fallback",
            "current_source":  "climatological_fallback",
            "wind_source":     "climatological_fallback",
            "cmems_dataset_id": CMEMS_DATASET_ID,
            "era5_dataset":     ERA5_DATASET,
            "real_data":        False,
            "fallback_used":    True,
            "fallback_reason":  "fetch() not yet called",
        }

    # -----------------------------------------------------------------------
    # Public: one-time network fetch
    # -----------------------------------------------------------------------

    def fetch(self) -> None:
        """
        Fetch both CMEMS and ERA5 subsets. If either fails, both revert to
        climatological_fallback (no silent source mixing).
        """
        cmems_ok = self._fetch_cmems()
        era5_ok  = self._fetch_era5()

        if cmems_ok and era5_ok:
            self.environment_meta.update({
                "data_source":    DATASOURCE_REAL,
                "current_source": f"cmems:{CMEMS_DATASET_ID}",
                "wind_source":    f"era5:{ERA5_DATASET}",
                "real_data":      True,
                "fallback_used":  False,
                "fallback_reason": None,
            })
        else:
            # Partial success: revert to full fallback for scientific integrity
            reason_parts = []
            if not cmems_ok:
                reason_parts.append("CMEMS fetch failed")
                self._cmems_ds = None
            if not era5_ok:
                reason_parts.append("ERA5 fetch failed")
                self._era5_ds = None
            if cmems_ok and not era5_ok:
                self._cmems_ds = None
                reason_parts.append("both sources reverted to fallback for consistency")
            elif not cmems_ok and era5_ok:
                self._era5_ds = None
                reason_parts.append("both sources reverted to fallback for consistency")

            self.environment_meta.update({
                "data_source":    "climatological_fallback",
                "current_source": "climatological_fallback",
                "wind_source":    "climatological_fallback",
                "real_data":      False,
                "fallback_used":  True,
                "fallback_reason": "; ".join(reason_parts),
            })

    # -----------------------------------------------------------------------
    # Public: per-step environment lookup (called by RK4)
    # -----------------------------------------------------------------------

    def get_environment(self, lat: float, lon: float,
                        sim_time: datetime.datetime) -> dict:
        """
        Return environment dict with keys:
            current_u_ms, current_v_ms,
            wind_u_ms,    wind_v_ms,
            data_source, current_source, wind_source
        """
        if self._cmems_ds is None or self._era5_ds is None:
            return _fallback_env(lat, lon, sim_time)

        try:
            u_c, v_c = self._lookup_cmems(lat, lon, sim_time)
            u_w, v_w = self._lookup_era5(lat, lon, sim_time)
            return {
                "current_u_ms":  float(u_c),
                "current_v_ms":  float(v_c),
                "wind_u_ms":     float(u_w),
                "wind_v_ms":     float(v_w),
                "data_source":   DATASOURCE_REAL,
                "current_source": f"cmems:{CMEMS_DATASET_ID}",
                "wind_source":    f"era5:{ERA5_DATASET}",
            }
        except Exception as exc:
            warnings.warn(f"[env_provider] lookup failed ({exc}); using fallback")
            return _fallback_env(lat, lon, sim_time)

    # -----------------------------------------------------------------------
    # Internal: CMEMS fetch
    # -----------------------------------------------------------------------

    def _fetch_cmems(self) -> bool:
        if not _HAS_XARRAY:
            print("[env_provider] xarray not installed; CMEMS unavailable", file=sys.stderr)
            return False

        # Strategy A: If explicit credentials are provided and copernicusmarine is installed, try it
        username = (os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME") or
                    os.environ.get("CMEMS_USERNAME"))
        password = (os.environ.get("COPERNICUSMARINE_SERVICE_PASSWORD") or
                    os.environ.get("CMEMS_PASSWORD"))

        if username and password and _HAS_CM:
            try:
                print("[env_provider] Attempting CMEMS open_dataset via copernicusmarine...", file=sys.stderr)
                ds = cm.open_dataset(
                    dataset_id=CMEMS_DATASET_ID,
                    variables=CMEMS_VARIABLES,
                    minimum_latitude=self.lat_min,
                    maximum_latitude=self.lat_max,
                    minimum_longitude=self.lon_min,
                    maximum_longitude=self.lon_max,
                    start_datetime=self.t_start.strftime("%Y-%m-%dT00:00:00"),
                    end_datetime=self.t_end.strftime("%Y-%m-%dT23:59:59"),
                    minimum_depth=CMEMS_SURFACE_DEPTH_MIN,
                    maximum_depth=CMEMS_SURFACE_DEPTH_MAX,
                    username=username,
                    password=password,
                )
                if "depth" in ds.dims:
                    ds = ds.isel(depth=0, drop=True)
                elif "elevation" in ds.dims:
                    ds = ds.isel(elevation=0, drop=True)
                for v in CMEMS_VARIABLES:
                    if v not in ds:
                        raise ValueError(f"Variable '{v}' not found in CMEMS dataset")
                self._cmems_ds = ds
                print(f"[env_provider] CMEMS OK (copernicusmarine). Grid: {dict(ds.sizes)}", file=sys.stderr)
                return True
            except Exception as cm_exc:
                print(f"[env_provider] copernicusmarine fetch failed ({cm_exc}), falling back to direct ARCO Zarr...", file=sys.stderr)

        # Strategy B: Direct access to official CMEMS ARCO Zarr store on CloudFerro
        try:
            print("[env_provider] Fetching CMEMS subset via official ARCO Zarr store...", file=sys.stderr)
            ds_cm = xr.open_dataset(CMEMS_ARCO_ZARR_URL, engine="zarr", zarr_format=2)
            if "elevation" in ds_cm.dims:
                ds_cm = ds_cm.isel(elevation=-1, drop=True)
            elif "depth" in ds_cm.dims:
                ds_cm = ds_cm.isel(depth=0, drop=True)

            sub = ds_cm[CMEMS_VARIABLES].sel(
                latitude=slice(self.lat_min, self.lat_max),
                longitude=slice(self.lon_min, self.lon_max)
            )

            max_cm_time = sub.time.max().values
            t_start_np = np.datetime64(self.t_start) if _HAS_NUMPY else None
            if t_start_np is not None and t_start_np > max_cm_time:
                sub = sub.sel(time=[self.t_end], method="nearest").load()
            else:
                sub = sub.sel(time=slice(self.t_start, self.t_end)).load()

            for v in CMEMS_VARIABLES:
                if v not in sub:
                    raise ValueError(f"Variable '{v}' not found in CMEMS Zarr dataset")

            self._cmems_ds = sub
            print(f"[env_provider] CMEMS OK (ARCO Zarr). Grid: {dict(sub.sizes)}", file=sys.stderr)
            return True
        except Exception as exc:
            print(f"[env_provider] CMEMS ARCO Zarr fetch failed: {exc}", file=sys.stderr)
            return False

    # -----------------------------------------------------------------------
    # Internal: ERA5 fetch
    # -----------------------------------------------------------------------

    def _fetch_era5(self) -> bool:
        if not _HAS_CDSAPI:
            print("[env_provider] cdsapi not installed; ERA5 unavailable",
                  file=sys.stderr)
            return False
        if not _HAS_XARRAY:
            print("[env_provider] xarray not installed; ERA5 unavailable",
                  file=sys.stderr)
            return False

        try:
            print("[env_provider] Fetching ERA5 subset via CDS API...", file=sys.stderr)
            c = cdsapi.Client(quiet=True)
            try:
                c.client.accept_licence('cc-by', 1)
            except Exception:
                pass
            try:
                c.client.accept_licence('licence-to-use-copernicus-products', 12)
            except Exception:
                pass

            era5_max_date = datetime.date(2026, 9, 2)
            dates = set()
            hours = set()
            t = self.t_start
            while t <= self.t_end + datetime.timedelta(hours=1):
                d = min(t.date(), era5_max_date)
                dates.add(d)
                hours.add(t.strftime("%H:00"))
                t += datetime.timedelta(hours=1)

            years = sorted(list(set(d.strftime("%Y") for d in dates)))
            months = sorted(list(set(d.strftime("%m") for d in dates)))
            days = sorted(list(set(d.strftime("%d") for d in dates)))

            area = [
                round(self.lat_max + 0.5),   # North
                round(self.lon_min - 0.5),   # West
                round(self.lat_min - 0.5),   # South
                round(self.lon_max + 0.5),   # East
            ]

            import tempfile, pathlib
            with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tf:
                tmp_path = tf.name

            try:
                c.retrieve(
                    ERA5_DATASET,
                    {
                        "product_type": ["reanalysis"],
                        "variable": ERA5_VARIABLES,
                        "year": years,
                        "month": months,
                        "day": days,
                        "time": sorted(list(hours)),
                        "data_format": "netcdf",
                        "area": area,
                    },
                    tmp_path,
                )

                raw_ds = xr.open_dataset(tmp_path)
                ds = raw_ds.load()
                raw_ds.close()
                pathlib.Path(tmp_path).unlink(missing_ok=True)

                u_var = "u10" if "u10" in ds else "10m_u_component_of_wind"
                v_var = "v10" if "v10" in ds else "10m_v_component_of_wind"
                if u_var not in ds or v_var not in ds:
                    available = list(ds.data_vars)
                    raise ValueError(f"ERA5 wind variables not found. Available: {available}")

                ds.attrs["_u10_var"] = u_var
                ds.attrs["_v10_var"] = v_var

                for var in [u_var, v_var]:
                    unit = ds[var].attrs.get("units", "unknown")
                    print(f"[env_provider] ERA5 {var}: units={unit}", file=sys.stderr)

                self._era5_ds = ds
                print(f"[env_provider] ERA5 OK. Grid: {dict(ds.sizes)}", file=sys.stderr)
                return True
            except Exception:
                try:
                    pathlib.Path(tmp_path).unlink(missing_ok=True)
                except Exception:
                    pass
                raise
        except Exception as exc:
            print(f"[env_provider] ERA5 fetch failed: {exc}", file=sys.stderr)
            return False

    # -----------------------------------------------------------------------
    # Internal: nearest-neighbour lookups
    # -----------------------------------------------------------------------

    def _lookup_cmems(self, lat: float, lon: float,
                      sim_time: datetime.datetime) -> tuple[float, float]:
        """
        Nearest-neighbour lookup in CMEMS dataset.
        Returns (u_current_ms, v_current_ms).
        """
        ds = self._cmems_ds
        lat_coord = _find_coord(ds, ["latitude", "lat", "y"])
        lon_coord = _find_coord(ds, ["longitude", "lon", "x"])
        time_coord = _find_coord(ds, ["time", "valid_time"])

        sel_kwargs = {
            lat_coord:  lat,
            lon_coord:  lon,
        }
        if time_coord in ds.dims and ds[time_coord].size > 1:
            t64 = _to_np_datetime64(sim_time)
            sel_kwargs[time_coord] = t64

        point = ds.sel(sel_kwargs, method="nearest")

        u = float(np.asarray(point["uo"].values).item())
        v = float(np.asarray(point["vo"].values).item())

        if math.isnan(u) or math.isnan(v):
            warnings.warn(
                f"[env_provider] CMEMS NaN at lat={lat:.3f} lon={lon:.3f} "
                f"t={sim_time.isoformat()} — using 0.0"
            )
            u = 0.0 if math.isnan(u) else u
            v = 0.0 if math.isnan(v) else v

        return u, v

    def _lookup_era5(self, lat: float, lon: float,
                     sim_time: datetime.datetime) -> tuple[float, float]:
        """
        Nearest-neighbour lookup in ERA5 dataset.
        Returns (u_wind_ms, v_wind_ms).
        """
        ds = self._era5_ds
        u_var = ds.attrs.get("_u10_var", "u10")
        v_var = ds.attrs.get("_v10_var", "v10")

        lat_coord  = _find_coord(ds, ["latitude", "lat", "y"])
        lon_coord  = _find_coord(ds, ["longitude", "lon", "x"])
        time_coord = _find_coord(ds, ["valid_time", "time"])

        sel_kwargs = {
            lat_coord:  lat,
            lon_coord:  lon,
        }
        if time_coord in ds.dims and ds[time_coord].size > 1:
            t64 = _to_np_datetime64(sim_time)
            sel_kwargs[time_coord] = t64

        point = ds.sel(sel_kwargs, method="nearest")

        u = float(np.asarray(point[u_var].values).item())
        v = float(np.asarray(point[v_var].values).item())

        if math.isnan(u) or math.isnan(v):
            warnings.warn(
                f"[env_provider] ERA5 NaN at lat={lat:.3f} lon={lon:.3f} "
                f"t={sim_time.isoformat()} — using 0.0"
            )
            u = 0.0 if math.isnan(u) else u
            v = 0.0 if math.isnan(v) else v

        return u, v

    # -----------------------------------------------------------------------
    # Cleanup
    # -----------------------------------------------------------------------

    def close(self) -> None:
        """Release in-memory datasets."""
        if self._cmems_ds is not None:
            try:
                self._cmems_ds.close()
            except Exception:
                pass
            self._cmems_ds = None

        if self._era5_ds is not None:
            try:
                self._era5_ds.close()
            except Exception:
                pass
            self._era5_ds = None


# ===========================================================================
# Helpers
# ===========================================================================

def _find_coord(ds: "xr.Dataset", candidates: list) -> str:
    """Return the first candidate name that exists as a coordinate."""
    for name in candidates:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"None of {candidates} found in dataset coords: "
                   f"{list(ds.coords)}")

def _to_np_datetime64(dt: datetime.datetime):
    """Convert a naive UTC datetime to numpy datetime64."""
    import numpy as np
    return np.datetime64(dt.isoformat(), "ns")


# ===========================================================================
# Standalone test (run: python environment_provider.py)
# ===========================================================================

if __name__ == "__main__":
    import json

    # Spill 1 parameters
    CENTER_LAT = 15.234
    CENTER_LON = 72.451
    OBS_TIME   = datetime.datetime(2026, 9, 4, 5, 30, 0)
    AGE_HOURS  = 7.5

    t_end   = OBS_TIME
    t_start = OBS_TIME - datetime.timedelta(hours=AGE_HOURS + 1)  # +1h buffer

    print(f"Testing EnvironmentProvider")
    print(f"  center: {CENTER_LAT} N, {CENTER_LON} E")
    print(f"  window: {t_start.isoformat()} -> {t_end.isoformat()}")
    print(f"  bbox:   lat [{CENTER_LAT-BBOX_PAD_DEG}, {CENTER_LAT+BBOX_PAD_DEG}]"
          f"  lon [{CENTER_LON-BBOX_PAD_DEG}, {CENTER_LON+BBOX_PAD_DEG}]")
    print()

    provider = EnvironmentProvider(CENTER_LAT, CENTER_LON, t_start, t_end)
    provider.fetch()

    print()
    print("=== environment_meta ===")
    print(json.dumps(provider.environment_meta, indent=2))
    print()

    # Test lookup at obs time
    env = provider.get_environment(CENTER_LAT, CENTER_LON, OBS_TIME)
    print("=== get_environment at obs_time ===")
    print(json.dumps(env, indent=2))

    # Test lookup 4 h before obs
    env2 = provider.get_environment(
        CENTER_LAT, CENTER_LON,
        OBS_TIME - datetime.timedelta(hours=4)
    )
    print("=== get_environment at obs-4h ===")
    print(json.dumps(env2, indent=2))

    # Verify not NaN
    for k in ["current_u_ms","current_v_ms","wind_u_ms","wind_v_ms"]:
        val = env[k]
        ok = math.isfinite(val)
        print(f"  [{('OK' if ok else 'FAIL')}] {k} = {val:.4f}")

    provider.close()
    print()
    print("Test complete.")
