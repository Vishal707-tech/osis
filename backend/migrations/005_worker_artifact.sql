-- ==============================================================================
-- O.S.I.S. (Oil Spill Identification System)
-- Migration 005: Worker Artifact Storage
-- ==============================================================================
-- Description:
--   Minimal additive migration for the Day 2 acquisition worker.
--
--   Adds:
--     artifact_metadata JSONB  -- stores local file paths and download metadata
--                              -- set when worker moves scene to 'completed'
--     worker_id        TEXT    -- optional: which worker instance claimed the scene
--                              -- useful for multi-worker debugging (Day 6+)
--
--   Also adds a composite index on (status, acquired_at) to speed up the
--   FOR UPDATE SKIP LOCKED queue claim query used by the worker.
--
-- Safety:
--   Idempotent. Safe to re-run.
-- ==============================================================================

ALTER TABLE processed_scenes
    ADD COLUMN IF NOT EXISTS artifact_metadata JSONB,
    ADD COLUMN IF NOT EXISTS worker_id          TEXT;

-- Composite index optimises the worker's queue claim query:
--   WHERE status='queued' ORDER BY acquired_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
CREATE INDEX IF NOT EXISTS idx_processed_scenes_claim
    ON processed_scenes (status, acquired_at ASC NULLS LAST)
    WHERE status = 'queued';

-- Stale-processing recovery index: find scenes stuck in processing
CREATE INDEX IF NOT EXISTS idx_processed_scenes_stale
    ON processed_scenes (processing_at ASC)
    WHERE status = 'processing';

-- ==============================================================================
-- End of Migration 005
-- ==============================================================================
