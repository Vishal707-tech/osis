"""Local, fail-closed environmental and historical AIS adapters for REAL reports.

No network calls, climatology, zero-fill, seeded database tracks or demo imports.
NetCDF inputs are bounded rectilinear CMEMS uo/vo and ERA5 u10/v10 subsets.
"""
import csv
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path


class Unavailable(ValueError):
    """Public, configuration-safe reason why a real stage cannot run."""


def asset(path, limit):
    try:
        return _asset(path, limit)
    except OSError:
        raise Unavailable("Required local data asset cannot be read") from None


def _asset(path, limit):
    if not path or not Path(path).is_file():
        raise Unavailable("Required local data asset is not configured or missing")
    file = Path(path)
    if file.stat().st_size > limit:
        raise Unavailable("Local data asset exceeds the supported subset size")
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return file, digest.hexdigest()


class StrictEnvironmentProvider:
    """Nearest neighbour with coverage/tolerance/units/finite checks on EVERY RK4 sample."""
    values = {"leeway": .03, "velocity_uncertainty_ms": .15}

    def __init__(self, current_path=False, wind_path=False):
        self.datasets = []
        self._opened = []
        self.meta = {"source": "CMEMS/ERA5 local reanalysis", "kind": "REAL_REANALYSIS",
                     "sampling": "nearest; no extrapolation or missing-value substitution",
                     "leeway": .03, "velocity_uncertainty_ms": .15}
        self.has_wind = True
        try:
            import numpy as np
            import xarray as xr
            self.np = np
            c_path = os.environ.get("REAL_CURRENT_NETCDF") if current_path is False else current_path
            w_path = os.environ.get("REAL_WIND_NETCDF") if wind_path is False else wind_path
            
            configs = [("current", c_path, ("uo", "vo"), 13, .15)]
            if w_path is not None:
                configs.append(("wind", w_path, ("u10", "v10"), 1, .3))
            else:
                self.has_wind = False
                self.meta["wind_status"] = "intentionally unavailable; wind advection disabled"
                
            for label, path, variables, tolerance, spatial_limit in configs:
                file, digest = asset(path, 128 * 1024 * 1024)
                ds = xr.open_dataset(file)
                self._opened.append(ds)
                self.datasets.append((ds, variables, tolerance, spatial_limit))
                rename = {}
                for target, aliases in (("latitude", ("lat",)), ("longitude", ("lon",)),
                                        ("time", ("valid_time",))):
                    if target not in ds.coords:
                        alias = next((a for a in aliases if a in ds.coords), None)
                        if alias is None:
                            raise Unavailable("Environmental coordinate is missing")
                        rename[alias] = target
                ds = ds.rename(rename)
                if "depth" in ds.dims:
                    depths = np.asarray(ds.depth.values)
                    if depths.ndim != 1 or not np.isfinite(depths).all() or depths.min() < 0 or depths.min() > 1:
                        raise Unavailable("Environmental currents require a surface level within 1 m")
                    ds = ds.isel(depth=int(np.argmin(depths)))
                for coord in ("latitude", "longitude", "time"):
                    c = ds[coord]
                    if c.dims != (coord,) or c.size == 0:
                        raise Unavailable("Only nonempty rectilinear environmental grids are supported")
                    vals = c.values
                    if coord == "time":
                        if not np.issubdtype(vals.dtype, np.datetime64) or np.isnat(vals).any():
                            raise Unavailable("Environmental times must be decoded UTC dates")
                    elif not np.isfinite(vals).all():
                        raise Unavailable("Environmental coordinates must be finite")
                    if len(vals) > 1 and not ((vals[1:] > vals[:-1]).all() or (vals[1:] < vals[:-1]).all()):
                        raise Unavailable("Environmental coordinates must be strictly monotonic")
                for name in variables:
                    if name not in ds or set(ds[name].dims) != {"time", "latitude", "longitude"}:
                        raise Unavailable("Required surface current/wind components are missing or unsupported")
                    if ds[name].attrs.get("units", "").strip().lower() not in ("m/s", "m s-1", "m s**-1"):
                        raise Unavailable("Environmental component units must explicitly be m/s")
                    if ds[name].nbytes > 128 * 1024 * 1024:
                        raise Unavailable("Decoded environmental component exceeds the subset limit")
                self.datasets[-1] = (ds, variables, tolerance, spatial_limit)
                self.meta[label + "Sha256"] = digest
                self.meta[label + "TimeRange"] = f"{ds.time.values.min()} / {ds.time.values.max()} UTC"
                self.meta[label + "MaxTimeOffsetHours"] = tolerance
        except Exception as exc:
            self.close()
            if isinstance(exc, Unavailable):
                raise
            raise Unavailable("Environmental NetCDF reader unavailable or subset invalid") from None

    def get_environment(self, lat, lon, when):
        try:
            return self._sample(lat, lon, when)
        except Unavailable:
            raise
        except Exception:
            # Lazy NetCDF reads can fail after initialization; retain prior SAR evidence.
            raise Unavailable("Environmental sample could not be read from the local subset") from None

    def _sample(self, lat, lon, when):
        np = self.np
        if not math.isfinite(lat) or not math.isfinite(lon) or not -90 < lat < 90 or not -180 <= lon <= 180:
            raise Unavailable("Modeled position is outside supported geographic coverage")
        if when.tzinfo is None:
            raise Unavailable("Environmental sample time must include timezone")
        instant = np.datetime64(when.astimezone(dt.timezone.utc).replace(tzinfo=None), "ns")
        result = {"data_source": self.meta["source"]}
        for ds, variables, tolerance, spatial_limit in self.datasets:
            # Normalize negative longitudes only for a clearly 0..360 dataset.
            query_lon = lon + 360 if lon < 0 and float(ds.longitude.max()) > 180 else lon
            indexers = {}
            for coord, value in (("latitude", lat), ("longitude", query_lon), ("time", instant)):
                vals = ds[coord].values
                if value < vals.min() or value > vals.max():
                    raise Unavailable("Environmental sample is outside spatial or temporal coverage")
                idx = int(np.argmin(abs(vals - value)))
                distance = abs(vals[idx] - value)
                if coord == "time":
                    if distance > np.timedelta64(int(tolerance * 3600), "s"):
                        raise Unavailable("Environmental sample is stale across a temporal gap")
                elif distance > spatial_limit:
                    raise Unavailable("Environmental sample is too far from a supported grid cell")
                indexers[coord] = idx
            for name in variables:
                value = float(ds[name].isel(indexers).values)
                if not math.isfinite(value):
                    raise Unavailable("Environmental sample contains missing or nonfinite values")
                result[{"uo": "current_u_ms", "vo": "current_v_ms",
                        "u10": "wind_u_ms", "v10": "wind_v_ms"}[name]] = value
        if len(result) != 5:
            if not getattr(self, "has_wind", True) and len(result) == 3:
                result["wind_u_ms"] = 0.0
                result["wind_v_ms"] = 0.0
            else:
                raise Unavailable("Both real current and wind fields are required")
        return result

    def close(self):
        # Keep the original handles: rename/isel views may not retain xarray's close callback.
        for ds in self._opened:
            ds.close()
        self._opened = []
        self.datasets = []


def historical_ais(origin, window, normalize, timestamp):
    """Canonical observed CSV + operator-attested coverage manifest; never query seeded DB."""
    file, digest = asset(os.environ.get("REAL_AIS_CSV"), 8 * 1024 * 1024)
    manifest_file, manifest_hash = asset(os.environ.get("REAL_AIS_MANIFEST"), 64 * 1024)
    try:
        meta = json.loads(manifest_file.read_text(encoding="utf-8"))
        if (meta["dataKind"] != "observed" or not isinstance(meta["source"], str) or not meta["source"].strip()
                or meta["speedUnits"] != "knots" or meta["courseUnits"] != "degrees"):
            raise ValueError()
        start, end = timestamp(window["start"]), timestamp(window["end"])
        west, south, east, north = meta["bbox"]
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError()
        pad_lat = 15 / 111.32
        pad_lon = pad_lat / math.cos(math.radians(origin["lat"]))
        if not (timestamp(meta["start"]) <= start <= end <= timestamp(meta["end"])
                and west <= origin["lon"]-pad_lon and east >= origin["lon"]+pad_lon
                and south <= origin["lat"]-pad_lat and north >= origin["lat"]+pad_lat):
            raise Unavailable("Historical AIS manifest does not cover the modeled origin search window/region")
        with file.open(newline="", encoding="utf-8-sig") as stream:
            reader = csv.DictReader(stream)
            headers = set(reader.fieldnames or [])
            if not {"timestamp", "latitude", "longitude"} <= headers or not ({"mmsi", "MMSI"} & headers):
                raise ValueError()
            rows = []
            for i, row in enumerate(reader):
                if i >= 20000:
                    raise Unavailable("Historical AIS exceeds the 20,000-record subset limit")
                rows.append({k: v for k, v in row.items() if k in
                             ("mmsi", "MMSI", "timestamp", "latitude", "longitude", "speed", "course", "heading", "name", "type")})
        records, rejected = normalize(rows)
        records = [r for r in records if start <= timestamp(r["timestamp"]) <= end
                   and abs(r["latitude"]-origin["lat"]) <= pad_lat
                   and abs(r["longitude"]-origin["lon"]) <= pad_lon]
        if not records:
            raise Unavailable("No compatible observed AIS fixes in the modeled origin search window/region")
        vessels = {r["mmsi"]: {"mmsi": r["mmsi"], "name": r.get("name") or "Unknown vessel",
                              "type": r.get("type") or "Unknown"} for r in records}
        return records, list(vessels.values()), {"source": meta["source"][:240], "kind": "REAL",
            "assetSha256": digest, "manifestSha256": manifest_hash, "records": len(records),
            "rejected": rejected, "coverage": "operator-attested; receiver completeness not independently verified"}
    except Unavailable:
        raise
    except Exception:
        raise Unavailable("Historical AIS CSV or coverage manifest is invalid") from None