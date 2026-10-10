-- Additive upgrade: retain legacy completed reports while accepting empty/partial evidence.
ALTER TABLE osis_incidents ALTER COLUMN spill_geom DROP NOT NULL;
ALTER TABLE osis_incidents ALTER COLUMN origin_geom DROP NOT NULL;
ALTER TABLE osis_incidents ALTER COLUMN image_at DROP NOT NULL;
ALTER TABLE osis_incidents DROP CONSTRAINT IF EXISTS osis_incidents_report_check;
ALTER TABLE osis_incidents DROP CONSTRAINT IF EXISTS osis_incidents_outcome_check;
ALTER TABLE osis_incidents ADD CONSTRAINT osis_incidents_outcome_check CHECK (
    (report->>'outcome' IN ('SPILL_DETECTED','NO_SPILL_DETECTED','ANALYSIS_INCONCLUSIVE'))
    OR (NOT report ? 'outcome' AND report->>'status' = 'completed')
);
-- Keep legacy responsibility_score view name for consumers; new view uses accurate semantics.
CREATE OR REPLACE VIEW osis_candidate_compatibility AS
SELECT incident_id, mmsi, name, responsibility_score AS compatibility_score, evidence FROM osis_candidates;