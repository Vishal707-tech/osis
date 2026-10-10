#!/usr/bin/env python3
"""
==============================================================================
O.S.I.S. - Oil Spill Identification System
Phase 4A: Backward Lagrangian Hindcast Engine + Real Environmental Data
==============================================================================
File    : backend/scripts/hindcast_runner.py
Purpose : Standalone backward-drift simulation. Runs entirely from the
          command line and emits machine-readable JSON consumed by the
          Node.js backend.

Physics :
  V_total = V_current + leeway * V_wind
  Backward integration: position(t - dt) via negative V_total
  Integration scheme : Runge-Kutta 4 (RK4) applied to every particle.

Environmental data :
  Phase 4A: real CMEMS ocean currents + ERA5 winds via environment_provider.py
  Fetched once before the RK4 loop; cached in memory; no per-step API calls.
  data_source = "cmems_<dataset>_era5"  when real data available.
  If either source fails, falls back to climatological_fallback for BOTH
  (to avoid silently mixing real and synthetic fields).
  data_source = "climatological_fallback"  when fallback is active.

No database access. No Node.js integration. No AIS.
==============================================================================
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import datetime

try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EARTH_RADIUS_KM = 6371.0
DEG_PER_KM_LAT  = 1.0 / 111.0
SIGMA_TURB_KM   = 0.08
SEED_RADIUS_KM  = 0.5


# ===========================================================================
# 1. Geospatial utilities
# ===========================================================================

def km_to_deg_lat(km):
    return km / 111.0

def km_to_deg_lon(km, lat_deg):
    return km / (111.0 * math.cos(math.radians(lat_deg)))

def haversine_km(lat1, lon1, lat2, lon2):
    r = math.radians
    dlat = r(lat2 - lat1); dlon = r(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(r(lat1))*math.cos(r(lat2))*math.sin(dlon/2)**2
    return 2.0 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))

def bearing_deg(lat1, lon1, lat2, lon2):
    r = math.radians; dlon = r(lon2 - lon1)
    x = math.sin(dlon) * math.cos(r(lat2))
    y = math.cos(r(lat1))*math.sin(r(lat2)) - math.sin(r(lat1))*math.cos(r(lat2))*math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


# ===========================================================================
# 2. Climatological fallback environmental model
#    data_source = "climatological_fallback"
# ===========================================================================

def _climatological_current(lat, lon, hour_of_day):
    """Deterministic synthetic surface current (m/s). data_source=climatological_fallback"""
    bg_u = -0.08 * math.cos(math.radians(lat))
    bg_v = -0.04 * math.sin(math.radians(lat * 2.0))
    phase = 2.0 * math.pi * hour_of_day / 12.42
    return bg_u + 0.06*math.sin(phase + math.radians(lon)), bg_v + 0.05*math.cos(phase + math.radians(lat))

def _climatological_wind(lat, lon, hour_of_day):
    """Deterministic synthetic 10-m wind (m/s). data_source=climatological_fallback"""
    bg_u = 3.5 * math.sin(math.radians(lat + 10.0))
    bg_v = -2.0 * math.cos(math.radians(lon))
    phase = 2.0 * math.pi * hour_of_day / 24.0
    return bg_u + 1.2*math.sin(phase), bg_v + 0.8*math.cos(phase + math.radians(lat))

def get_environment(lat, lon, sim_time, override_current=None, override_wind=None,
                    provider=None):
    """
    Returns environment dict with keys: u_current, v_current, u_wind, v_wind, data_source.

    Priority:
      1. override_current / override_wind (explicit CLI values)
      2. provider.get_environment()  (real CMEMS + ERA5 if provider is set and loaded)
      3. climatological fallback
    """
    hf = sim_time.hour + sim_time.minute/60.0 + sim_time.second/3600.0

    if override_current is not None and override_wind is not None:
        # Both explicitly overridden — use user values directly
        return dict(u_current=float(override_current[0]),
                    v_current=float(override_current[1]),
                    u_wind=float(override_wind[0]),
                    v_wind=float(override_wind[1]),
                    data_source="user_supplied")

    if provider is not None:
        env_r = provider.get_environment(lat, lon, sim_time)
        u_c = env_r["current_u_ms"]
        v_c = env_r["current_v_ms"]
        u_w = env_r["wind_u_ms"]
        v_w = env_r["wind_v_ms"]
        # Apply user overrides on top of real data if only one component overridden
        if override_current is not None:
            u_c, v_c = float(override_current[0]), float(override_current[1])
        if override_wind is not None:
            u_w, v_w = float(override_wind[0]), float(override_wind[1])
        return dict(u_current=u_c, v_current=v_c, u_wind=u_w, v_wind=v_w,
                    data_source=env_r["data_source"])

    # Fallback: synthetic climatological model
    u_c, v_c = _climatological_current(lat, lon, hf)
    u_w, v_w = _climatological_wind(lat, lon, hf)
    if override_current is not None: u_c, v_c = float(override_current[0]), float(override_current[1])
    if override_wind   is not None: u_w, v_w = float(override_wind[0]),   float(override_wind[1])
    return dict(u_current=u_c, v_current=v_c, u_wind=u_w, v_wind=v_w,
                data_source="climatological_fallback")


# ===========================================================================
# 3. RK4 single-particle backward step (pure Python)
# ===========================================================================

def rk4_step_backward(lat, lon, sim_time, dt_s, leeway,
                      override_current=None, override_wind=None, provider=None):
    """One RK4 backward step. Backward = negate the advection velocity."""
    def v_deg(la, lo, t):
        env = get_environment(la, lo, t, override_current, override_wind, provider)
        u = env["u_current"] + leeway * env["u_wind"]
        v = env["v_current"] + leeway * env["v_wind"]
        cos_la = math.cos(math.radians(la))
        return (-(u/1000.0)/(EARTH_RADIUS_KM*cos_la)*(180.0/math.pi),
                -(v/1000.0)/EARTH_RADIUS_KM*(180.0/math.pi), env)

    hdt = datetime.timedelta(seconds=dt_s/2.0)
    fdt = datetime.timedelta(seconds=dt_s)
    k1l, k1b, env0 = v_deg(lat, lon, sim_time)
    k2l, k2b, _   = v_deg(lat+k1b*dt_s/2, lon+k1l*dt_s/2, sim_time-hdt)
    k3l, k3b, _   = v_deg(lat+k2b*dt_s/2, lon+k2l*dt_s/2, sim_time-hdt)
    k4l, k4b, _   = v_deg(lat+k3b*dt_s,   lon+k3l*dt_s,   sim_time-fdt)
    return (lat + (dt_s/6.0)*(k1b+2*k2b+2*k3b+k4b),
            lon + (dt_s/6.0)*(k1l+2*k2l+2*k3l+k4l), env0)


# ===========================================================================
# 4. NumPy-accelerated vectorised RK4
# ===========================================================================

def _np_vbwd(lats, lons, sim_time, leeway, oc, ow, provider=None):
    """
    NumPy-vectorised backward velocity field.

    When provider is set and loaded with real data:
      Uses provider.get_environment() at the ENSEMBLE CENTROID for the
      time step, then broadcasts that single scalar field to all particles.
      This is an acceptable approximation because the spatial extent of
      the particle cloud (< 10 km) is much smaller than the CMEMS grid
      spacing (9 km) — the field is effectively uniform across the cloud
      at each time step.

    When provider is None or falls back to climatological:
      Restores the original vectorised synthetic math.
    """
    hf = sim_time.hour + sim_time.minute/60.0 + sim_time.second/3600.0

    # --- determine u_c, v_c ---
    if oc is not None:
        u_c = np.full(lats.shape, float(oc[0]))
        v_c = np.full(lats.shape, float(oc[1]))
        src_c = "user_supplied"
    elif provider is not None:
        # Sample environment at ensemble centroid
        clat = float(np.mean(lats)); clon = float(np.mean(lons))
        env_r = provider.get_environment(clat, clon, sim_time)
        u_c = np.full(lats.shape, env_r["current_u_ms"])
        v_c = np.full(lats.shape, env_r["current_v_ms"])
        src_c = env_r["data_source"]
    else:
        phase = 2.0*math.pi*hf/12.42
        u_c = -0.08*np.cos(np.radians(lats)) + 0.06*np.sin(phase+np.radians(lons))
        v_c = -0.04*np.sin(np.radians(lats*2)) + 0.05*np.cos(phase+np.radians(lats))
        src_c = "climatological_fallback"

    # --- determine u_w, v_w ---
    if ow is not None:
        u_w = np.full(lats.shape, float(ow[0]))
        v_w = np.full(lats.shape, float(ow[1]))
        src_w = "user_supplied"
    elif provider is not None and src_c != "climatological_fallback":
        # Already sampled above — reuse for wind too
        u_w = np.full(lats.shape, env_r["wind_u_ms"])
        v_w = np.full(lats.shape, env_r["wind_v_ms"])
        src_w = env_r["data_source"]
    elif provider is not None:
        # Provider fell back for current; also fall back for wind
        clat = float(np.mean(lats)); clon = float(np.mean(lons))
        env_r2 = provider.get_environment(clat, clon, sim_time)
        u_w = np.full(lats.shape, env_r2["wind_u_ms"])
        v_w = np.full(lats.shape, env_r2["wind_v_ms"])
        src_w = env_r2["data_source"]
    else:
        phase = 2.0*math.pi*hf/24.0
        u_w = 3.5*np.sin(np.radians(lats+10.0)) + 1.2*np.sin(phase)
        v_w = -2.0*np.cos(np.radians(lons)) + 0.8*np.cos(phase+np.radians(lats))
        src_w = "climatological_fallback"

    u_t = u_c + leeway*u_w
    v_t = v_c + leeway*v_w
    cos_lat = np.cos(np.radians(lats))

    overall_src = (
        src_c if src_c == src_w else
        "climatological_fallback"   # mixed — degrade to fallback label
    )
    env = dict(
        u_current=float(np.mean(u_c)), v_current=float(np.mean(v_c)),
        u_wind=float(np.mean(u_w)),    v_wind=float(np.mean(v_w)),
        data_source=overall_src
    )
    return (-(v_t/1000.0)/EARTH_RADIUS_KM*(180.0/math.pi),
            -(u_t/1000.0)/(EARTH_RADIUS_KM*cos_lat)*(180.0/math.pi), env)

def np_rk4_step_backward(lats, lons, sim_time, dt_s, leeway,
                         oc=None, ow=None, provider=None):
    hdt = datetime.timedelta(seconds=dt_s/2); fdt = datetime.timedelta(seconds=dt_s)
    k1la, k1lo, env = _np_vbwd(lats, lons, sim_time, leeway, oc, ow, provider)
    k2la, k2lo, _  = _np_vbwd(lats+k1la*dt_s/2, lons+k1lo*dt_s/2, sim_time-hdt, leeway, oc, ow, provider)
    k3la, k3lo, _  = _np_vbwd(lats+k2la*dt_s/2, lons+k2lo*dt_s/2, sim_time-hdt, leeway, oc, ow, provider)
    k4la, k4lo, _  = _np_vbwd(lats+k3la*dt_s,   lons+k3lo*dt_s,   sim_time-fdt, leeway, oc, ow, provider)
    return (lats+(dt_s/6.0)*(k1la+2*k2la+2*k3la+k4la),
            lons+(dt_s/6.0)*(k1lo+2*k2lo+2*k3lo+k4lo), env)


# ===========================================================================
# 5. Ensemble seeding (Vogel spiral or polygon bbox)
# ===========================================================================

def _point_in_poly(lat, lon, poly):
    n, inside, j = len(poly), False, len(poly)-1
    for i in range(n):
        yi,xi = poly[i][0],poly[i][1]; yj,xj = poly[j][0],poly[j][1]
        if ((yi>lat)!=(yj>lat)) and lon<(xj-xi)*(lat-yi)/(yj-yi)+xi:
            inside = not inside
        j = i
    return inside

def seed_ensemble(clat, clon, n, polygon=None, seed=42):
    if _HAS_NUMPY:
        rng = np.random.default_rng(seed)
        if polygon and len(polygon)>=3:
            plat=np.array([p[0] for p in polygon]); plon=np.array([p[1] for p in polygon])
            samples=[]; attempts=0
            while len(samples)<n and attempts<n*30:
                la=float(rng.uniform(plat.min(),plat.max())); lo=float(rng.uniform(plon.min(),plon.max()))
                if _point_in_poly(la,lo,polygon): samples.append((la,lo))
                attempts+=1
            while len(samples)<n:
                samples.append((clat+float(rng.uniform(-0.005,0.005)),clon+float(rng.uniform(-0.005,0.005))))
            return np.array([s[0] for s in samples]), np.array([s[1] for s in samples])
        g=(1+math.sqrt(5))/2; idx=np.arange(n,dtype=float)
        th=2*math.pi*idx/g; r=SEED_RADIUS_KM*np.sqrt((idx+0.5)/n)
        return clat+r*np.cos(th)*DEG_PER_KM_LAT, clon+r*np.sin(th)*km_to_deg_lon(1.0,clat)
    import random; random.seed(seed)
    g=(1+math.sqrt(5))/2; lats=[]; lons=[]
    for i in range(n):
        th=2*math.pi*i/g; r=SEED_RADIUS_KM*math.sqrt((i+0.5)/n)
        lats.append(clat+r*math.cos(th)*DEG_PER_KM_LAT)
        lons.append(clon+r*math.sin(th)*km_to_deg_lon(1.0,clat))
    return lats, lons


# ===========================================================================
# 6. Convex hull (Graham scan, stdlib-only)
# ===========================================================================

def convex_hull(points):
    pts = list(set((float(p[0]),float(p[1])) for p in (points.tolist() if _HAS_NUMPY and hasattr(points,'tolist') else points)))
    if len(pts)<3: return pts
    pts.sort(key=lambda p:(p[0],p[1]))
    def cross(o,a,b): return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
    lo=[]; up=[]
    for p in pts:
        while len(lo)>=2 and cross(lo[-2],lo[-1],p)<=0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up)>=2 and cross(up[-2],up[-1],p)<=0: up.pop()
        up.append(p)
    return lo[:-1]+up[:-1]


# ===========================================================================
# 7. Statistics helpers
# ===========================================================================

def ensemble_stats(lats, lons, clat):
    if _HAS_NUMPY:
        la=np.asarray(lats,dtype=np.float64); lo=np.asarray(lons,dtype=np.float64)
        mla=float(np.median(la)); mlo=float(np.median(lo))
        dlat=(la-mla)*111.0; dlon=(lo-mlo)*111.0*math.cos(math.radians(clat))
        d=np.sqrt(dlat**2+dlon**2)
        return dict(median_lat=round(mla,6),median_lon=round(mlo,6),
                    sigma_km=round(float(np.std(d)),4),ensemble_spread_km=round(float(np.max(d)-np.min(d)),4))
    sl=sorted(lats); n=len(sl)
    mla=sl[n//2] if n%2 else (sl[n//2-1]+sl[n//2])/2
    sl2=sorted(lons); mlo=sl2[n//2] if n%2 else (sl2[n//2-1]+sl2[n//2])/2
    d=[haversine_km(mla,mlo,la,lo) for la,lo in zip(lats,lons)]
    mu=sum(d)/len(d)
    return dict(median_lat=round(mla,6),median_lon=round(mlo,6),
                sigma_km=round(math.sqrt(sum((x-mu)**2 for x in d)/len(d)),4),
                ensemble_spread_km=round(max(d)-min(d),4))

def origin_statistics(lats, lons, clat):
    if _HAS_NUMPY:
        la=np.asarray(lats,dtype=np.float64); lo=np.asarray(lons,dtype=np.float64)
        ola=float(np.mean(la)); olo=float(np.mean(lo))
        dlat=(la-ola)*111.0; dlon=(lo-olo)*111.0*math.cos(math.radians(ola))
        cov=np.cov(np.stack([dlon,dlat]))
        evals,evecs=np.linalg.eigh(cov); idx=np.argsort(evals)[::-1]
        evals=evals[idx]; evecs=evecs[:,idx]
        major=float(math.sqrt(max(float(evals[0]),0.0)*5.991))
        minor=float(math.sqrt(max(float(evals[1]),0.0)*5.991))
        orient=float(math.degrees(math.atan2(float(evecs[0,0]),float(evecs[1,0]))))%360.0
        unc=float(math.sqrt((float(np.max(la)-np.min(la)))**2*111.0**2+(float(np.max(lo)-np.min(lo)))**2*(111.0*math.cos(math.radians(ola)))**2)/2.0)
        hull=convex_hull(np.column_stack([la,lo]))
    else:
        ola=sum(lats)/len(lats); olo=sum(lons)/len(lons)
        d=[haversine_km(ola,olo,la,lo) for la,lo in zip(lats,lons)]
        mu=sum(d)/len(d); unc=max(d); major=max(d); minor=mu; orient=0.0
        hull=convex_hull(list(zip(lats,lons)))
    return dict(origin_lat=round(ola,6),origin_lon=round(olo,6),
                uncertainty_radius_km=round(unc,3),major_axis_km=round(major,3),
                minor_axis_km=round(minor,3),orientation_deg=round(orient,2),
                hull_polygon=[[round(p[0],6),round(p[1],6)] for p in hull])


# ===========================================================================
# 8. Main simulation loop
# ===========================================================================

def run_hindcast(center_lat, center_lon, spill_age_hours,
                 spill_polygon=None, ensemble_size=50, timestep_s=3600.0,
                 leeway=0.03, override_current=None, override_wind=None,
                 observation_time=None, use_real_data=True):
    """
    use_real_data: if True (default), attempt to fetch real CMEMS+ERA5 data
                   via environment_provider.EnvironmentProvider before the
                   RK4 loop.  Falls back to climatological if unavailable.
    """
    if observation_time is None:
        observation_time = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)

    lats, lons = seed_ensemble(center_lat, center_lon, ensemble_size, spill_polygon)
    if _HAS_NUMPY:
        lats = np.array(lats, dtype=np.float64)
        lons = np.array(lons, dtype=np.float64)

    n_steps  = max(1, int(math.ceil(spill_age_hours * 3600.0 / timestep_s)))
    dt_s     = float(timestep_s)
    sim_time = observation_time
    data_source_seen = set()

    # ── Phase 4A: initialise real-data provider ───────────────────────────
    provider = None
    env_meta = {"real_data": False, "fallback_used": True,
                "fallback_reason": "use_real_data=False"}
    if use_real_data and override_current is None and override_wind is None:
        try:
            import sys as _sys
            import os as _os
            _scripts_dir = _os.path.dirname(_os.path.abspath(__file__))
            if _scripts_dir not in _sys.path:
                _sys.path.insert(0, _scripts_dir)
            from environment_provider import EnvironmentProvider
            t_start = observation_time - datetime.timedelta(
                seconds=n_steps * dt_s + 3600.0)   # +1 h buffer
            provider = EnvironmentProvider(
                center_lat, center_lon, t_start, observation_time)
            provider.fetch()                        # ONE network call
            env_meta = provider.environment_meta
        except Exception as _prov_exc:
            import warnings
            warnings.warn(f"[hindcast] provider init failed: {_prov_exc}; "
                          f"using climatological_fallback")
            provider = None
            env_meta = {"real_data": False, "fallback_used": True,
                        "fallback_reason": str(_prov_exc)}
    elif override_current is not None or override_wind is not None:
        env_meta = {"real_data": False, "fallback_used": False,
                    "data_source": "user_supplied",
                    "fallback_reason": "user override provided"}
    trajectory = []

    # Step 0 - observation state
    s0 = ensemble_stats(lats, lons, center_lat)
    e0 = get_environment(center_lat, center_lon, sim_time,
                         override_current=override_current, override_wind=override_wind,
                         provider=provider)
    data_source_seen.add(e0["data_source"])
    c0 = math.sqrt(e0["u_current"]**2 + e0["v_current"]**2)
    w0 = math.sqrt(e0["u_wind"]**2    + e0["v_wind"]**2)
    trajectory.append({
        "step": 0, "timestamp_utc": sim_time.isoformat()+"Z",
        "hours_before_observation": 0.0,
        "median_lat": s0["median_lat"], "median_lon": s0["median_lon"],
        "sigma_km": s0["sigma_km"], "ensemble_spread_km": s0["ensemble_spread_km"],
        "current_speed_ms": round(c0,4), "wind_speed_ms": round(w0,4),
        "data_source": e0["data_source"],
        "particle_positions": [[round(float(la),6),round(float(lo),6)] for la,lo in zip(lats,lons)],
    })

    for step in range(1, n_steps+1):
        if _HAS_NUMPY:
            rng = np.random.default_rng(1000+step)
            lats = lats + rng.normal(0, km_to_deg_lat(SIGMA_TURB_KM), lats.shape)
            lons = lons + rng.normal(0, km_to_deg_lon(SIGMA_TURB_KM, center_lat), lons.shape)
            new_lats, new_lons, env = np_rk4_step_backward(
                lats, lons, sim_time, dt_s, leeway,
                oc=override_current, ow=override_wind, provider=provider)
        else:
            import random; random.seed(1000+step)
            new_lats=[]; new_lons=[]; env=None
            for la,lo in zip(lats,lons):
                la+=random.gauss(0,km_to_deg_lat(SIGMA_TURB_KM))
                lo+=random.gauss(0,km_to_deg_lon(SIGMA_TURB_KM,center_lat))
                nla,nlo,e=rk4_step_backward(la,lo,sim_time,dt_s,leeway,
                                            override_current=override_current,
                                            override_wind=override_wind,
                                            provider=provider)
                new_lats.append(nla); new_lons.append(nlo); env=e

        sim_time -= datetime.timedelta(seconds=dt_s)
        lats=new_lats; lons=new_lons
        data_source_seen.add(env["data_source"])
        ss=ensemble_stats(lats,lons,center_lat)
        cs=math.sqrt(env["u_current"]**2+env["v_current"]**2)
        ws=math.sqrt(env["u_wind"]**2+env["v_wind"]**2)
        trajectory.append({
            "step": step, "timestamp_utc": sim_time.isoformat()+"Z",
            "hours_before_observation": round(step*dt_s/3600.0,3),
            "median_lat": ss["median_lat"], "median_lon": ss["median_lon"],
            "sigma_km": ss["sigma_km"], "ensemble_spread_km": ss["ensemble_spread_km"],
            "current_speed_ms": round(cs,4), "wind_speed_ms": round(ws,4),
            "data_source": env["data_source"],
            "particle_positions": [[round(float(la),6),round(float(lo),6)] for la,lo in zip(lats,lons)],
        })

    orig=origin_statistics(lats,lons,center_lat)
    unc_h=math.sqrt((orig["uncertainty_radius_km"]/max(c0*3.6,0.1))**2+(dt_s/3600.0/2.0)**2)
    rel_ctr=sim_time
    # Determine overall data_source from what was actually seen in the loop
    if "climatological_fallback" in data_source_seen:
        gds = "climatological_fallback"
    elif provider is not None and env_meta.get("real_data"):
        from environment_provider import DATASOURCE_REAL
        gds = DATASOURCE_REAL
    else:
        gds = "user_supplied"
    dkm=haversine_km(center_lat,center_lon,orig["origin_lat"],orig["origin_lon"])
    dbrg=bearing_deg(center_lat,center_lon,orig["origin_lat"],orig["origin_lon"])

    return {
        "status": "completed",
        "physics_model": "rk4_ensemble",
        "data_source": gds,
        "numpy_accelerated": _HAS_NUMPY,
        "ensemble_size": ensemble_size,
        "actual_particle_count": int(len(lats)),
        "timestep_seconds": int(dt_s),
        "n_steps": n_steps,
        "hmax_hours": round(n_steps*dt_s/3600.0,3),
        "leeway": leeway,
        "observation": {
            "lat": center_lat, "lon": center_lon,
            "time_utc": observation_time.isoformat()+"Z",
            "spill_age_hours_input": spill_age_hours,
        },
        "origin": {
            "lat": orig["origin_lat"], "lon": orig["origin_lon"],
            "uncertainty_radius_km": orig["uncertainty_radius_km"],
            "major_axis_km": orig["major_axis_km"],
            "minor_axis_km": orig["minor_axis_km"],
            "orientation_deg": orig["orientation_deg"],
            "hull_polygon": orig["hull_polygon"],
            "displacement_from_observation_km": round(dkm,3),
            "displacement_bearing_deg": round(dbrg,2),
        },
        "release_window": {
            "center_utc": rel_ctr.isoformat()+"Z",
            "earliest_utc": (rel_ctr-datetime.timedelta(hours=unc_h)).isoformat()+"Z",
            "latest_utc":   (rel_ctr+datetime.timedelta(hours=unc_h)).isoformat()+"Z",
            "uncertainty_hours": round(unc_h,3),
            "note": ("Release window estimate. Uncertainty may be significantly larger "
                 "with real observed metocean fields."
                 if gds != "climatological_fallback" else
                 "Release window estimate under climatological_fallback data. "
                 "Uncertainty may be significantly larger with observed metocean fields."),
        },
        "trajectory": trajectory,
        "environment": {
            "data_source":     env_meta.get("data_source", gds),
            "current_source":  env_meta.get("current_source", gds),
            "wind_source":     env_meta.get("wind_source", gds),
            "cmems_dataset_id": env_meta.get("cmems_dataset_id", None),
            "era5_dataset":     env_meta.get("era5_dataset", None),
            "real_data":        bool(env_meta.get("real_data", False)),
            "fallback_used":    bool(env_meta.get("fallback_used", True)),
            "fallback_reason":  env_meta.get("fallback_reason", None),
        },
        "metadata": {
            "engine_version": "4A.0-real-env",
            "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()+"Z",
            "warnings": _build_warnings(gds, spill_age_hours),
            "uncertainty_note": (
                "All positions are ensemble medians. sigma_km and ensemble_spread_km "
                "represent particle-cloud dispersion, NOT observation accuracy. "
                "Origin coordinates carry inherent model uncertainty. "
                "Do NOT interpret as a precise fix."
            ),
        },
    }

def _build_warnings(ds, age_h):
    w=[]
    if ds=="climatological_fallback":
        w.append("CLIMATOLOGICAL FALLBACK ACTIVE: Environmental data is synthetic. "
                 "Results are physically plausible but NOT validated against real "
                 "metocean observations. Use only for development and testing.")
    if age_h>72:
        w.append(f"Spill age {age_h:.1f} h exceeds 72 h. Origin estimate reliability is LOW.")
    elif age_h>24:
        w.append(f"Spill age {age_h:.1f} h is substantial. Origin uncertainty may be significant.")
    return w


# ===========================================================================
# 9. Input validation
# ===========================================================================

def validate_inputs(args):
    e=[]
    if not (-90.0<=args.lat<=90.0): e.append(f"Invalid latitude {args.lat}: must be in [-90,90].")
    if not (-180.0<=args.lon<=180.0): e.append(f"Invalid longitude {args.lon}: must be in [-180,180].")
    if args.age_hours<=0: e.append(f"Invalid spill age {args.age_hours}: must be > 0 hours.")
    if args.age_hours>720: e.append(f"Spill age {args.age_hours} h exceeds 720 h.")
    if args.ensemble_size<2: e.append(f"Ensemble size {args.ensemble_size} must be >= 2.")
    if args.ensemble_size>10000: e.append(f"Ensemble size {args.ensemble_size} exceeds limit 10000.")
    if args.timestep<=0: e.append(f"Timestep {args.timestep} s must be > 0.")
    if args.timestep>86400: e.append(f"Timestep {args.timestep} s exceeds 24 h.")
    if not (0.0<=args.leeway<=0.10): e.append(f"Leeway {args.leeway} outside [0,0.10].")
    return e


# ===========================================================================
# 10. CLI entry point
# ===========================================================================

def build_parser():
    p=argparse.ArgumentParser(prog="hindcast_runner.py",
        description="O.S.I.S. Phase 2 - Backward Lagrangian Hindcast Engine.\nEmits machine-readable JSON to stdout.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lat",type=float,required=True,help="Spill centroid latitude (WGS-84)")
    p.add_argument("--lon",type=float,required=True,help="Spill centroid longitude (WGS-84)")
    p.add_argument("--age-hours",type=float,required=True,dest="age_hours",help="Estimated spill age in hours")
    p.add_argument("--ensemble-size",type=int,default=50,dest="ensemble_size",help="Particle count (default 50)")
    p.add_argument("--timestep",type=float,default=3600.0,help="Timestep seconds (default 3600)")
    p.add_argument("--leeway",type=float,default=0.03,help="Wind leeway fraction (default 0.03)")
    p.add_argument("--current",type=float,nargs=2,metavar=("U","V"),default=None,help="Override current (m/s)")
    p.add_argument("--wind",type=float,nargs=2,metavar=("U","V"),default=None,help="Override wind (m/s)")
    p.add_argument("--polygon",type=str,default=None,help="Spill polygon JSON [[lat,lon],...]")
    p.add_argument("--obs-time",type=str,default=None,dest="obs_time",help="Observation UTC ISO-8601")
    return p

def main():
    parser=build_parser(); args=parser.parse_args()
    errs=validate_inputs(args)
    if errs:
        print(json.dumps({"status":"error","errors":errs},indent=2)); sys.exit(1)

    polygon=None
    if args.polygon:
        try:
            polygon=json.loads(args.polygon)
            if not isinstance(polygon,list) or len(polygon)<3: raise ValueError("Need >= 3 points.")
        except (json.JSONDecodeError,ValueError) as ex:
            print(json.dumps({"status":"error","errors":[f"Invalid polygon: {ex}"]},indent=2)); sys.exit(1)

    obs_time=None
    if args.obs_time:
        try:
            obs_time=datetime.datetime.fromisoformat(args.obs_time.replace("Z","+00:00")).replace(tzinfo=None)
        except ValueError as ex:
            print(json.dumps({"status":"error","errors":[f"Invalid --obs-time: {ex}"]},indent=2)); sys.exit(1)

    try:
        result=run_hindcast(
            center_lat=args.lat, center_lon=args.lon, spill_age_hours=args.age_hours,
            spill_polygon=polygon, ensemble_size=args.ensemble_size,
            timestep_s=args.timestep, leeway=args.leeway,
            override_current=tuple(args.current) if args.current else None,
            override_wind=tuple(args.wind) if args.wind else None,
            observation_time=obs_time)
    except Exception as ex:
        print(json.dumps({"status":"error","errors":[f"Simulation failed: {ex}"]},indent=2)); sys.exit(2)

    print(json.dumps(result,indent=2)); sys.exit(0)

if __name__=="__main__":
    main()
