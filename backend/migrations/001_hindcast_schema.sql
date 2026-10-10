-- ==============================================================================
-- O.S.I.S. (Oil Spill Identification System)
-- Migration 001: Backward Drift / Hindcast Engine Schema
-- ==============================================================================
-- Description:
--   Creates the `hindcast_runs` table to track physics-based simulation runs,
--   origin uncertainty polygons, and release-window estimates.
--   Extends `drift_predictions` with simulation metadata (run_id, step_index,
--   uncertainty radii, metocean velocity fields) while maintaining 100% backward
--   compatibility with existing seed data and legacy API queries.
--
-- Safety:
--   Idempotent script (uses IF NOT EXISTS). Safe to execute on live PostgreSQL/PostGIS.
-- ==============================================================================

-- 1. Ensure PostGIS extension is available
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Create `hindcast_runs` Table
-- Represents an execution instance of the backward advection & dispersion simulation.
CREATE TABLE IF NOT EXISTS hindcast_runs (
    id SERIAL PRIMARY KEY,
    spill_id INTEGER NOT NULL REFERENCES spills(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'completed', -- 'pending', 'running', 'completed', 'failed'
    
    -- Simulation Configuration & Physics Model
    physics_model VARCHAR(100) NOT NULL DEFAULT 'rk4_ensemble', -- 'rk4_ensemble', 'euler_advection'
    data_source VARCHAR(100) NOT NULL DEFAULT 'cmems_glorys12_era5', -- ocean/wind source
    ensemble_size INTEGER NOT NULL DEFAULT 50, -- number of perturbed Lagrangian particles
    timestep_seconds INTEGER NOT NULL DEFAULT 3600, -- temporal step size (dt)
    hmax_hours FLOAT NOT NULL DEFAULT 12.0, -- maximum backward drift lookback time
    leeway FLOAT NOT NULL DEFAULT 0.03, -- wind leeway drift factor (typically 3-3.5% for surface slicks)
    
    -- Estimated Release Window
    release_window_start TIMESTAMPTZ, -- earliest plausible discharge timestamp
    release_window_end TIMESTAMPTZ, -- latest plausible discharge timestamp
    origin_timestamp TIMESTAMPTZ, -- central / mode release timestamp estimate
    
    -- Estimated Probable Origin Geometry & Uncertainty
    origin_centroid GEOMETRY(POINT, 4326), -- central probable origin coordinate (WGS84)
    origin_polygon GEOMETRY(POLYGON, 4326), -- convex hull / 95% confidence origin boundary
    origin_uncertainty_km FLOAT, -- equivalent circular uncertainty radius
    origin_major_axis_km FLOAT, -- principal dispersion ellipse semi-major axis
    origin_minor_axis_km FLOAT, -- principal dispersion ellipse semi-minor axis
    origin_orientation_deg FLOAT, -- orientation of dispersion ellipse (degrees from North)
    
    -- Observability & Tracking
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);

-- 3. Indexes for `hindcast_runs`
CREATE INDEX IF NOT EXISTS idx_hindcast_runs_spill_id ON hindcast_runs(spill_id);
CREATE INDEX IF NOT EXISTS idx_hindcast_runs_status ON hindcast_runs(status);
CREATE INDEX IF NOT EXISTS idx_hindcast_runs_created_at ON hindcast_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hindcast_runs_origin_centroid ON hindcast_runs USING GIST (origin_centroid);
CREATE INDEX IF NOT EXISTS idx_hindcast_runs_origin_polygon ON hindcast_runs USING GIST (origin_polygon);

-- 4. Extend `drift_predictions` Table
-- All added columns are NULLABLE to preserve legacy records and seed data.
ALTER TABLE drift_predictions 
    ADD COLUMN IF NOT EXISTS run_id INTEGER REFERENCES hindcast_runs(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS step_index INTEGER,
    ADD COLUMN IF NOT EXISTS sigma_km FLOAT,
    ADD COLUMN IF NOT EXISTS ensemble_spread_km FLOAT,
    ADD COLUMN IF NOT EXISTS current_speed_ms FLOAT,
    ADD COLUMN IF NOT EXISTS wind_speed_ms FLOAT;

-- 5. Indexes for `drift_predictions` optimization
CREATE INDEX IF NOT EXISTS idx_drift_predictions_run_id ON drift_predictions(run_id);
CREATE INDEX IF NOT EXISTS idx_drift_predictions_spill_timestamp ON drift_predictions(spill_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_drift_predictions_geom ON drift_predictions USING GIST (geom);

-- ==============================================================================
-- End of Migration 001
-- ==============================================================================
