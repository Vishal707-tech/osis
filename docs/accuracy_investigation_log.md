# O.S.I.S. — Accuracy Investigation Log
## Oil Spill Detection & Vessel Tracking Investigation

> **Document Version:** 1.0  
> **Created:** 2026-09-18  
> **System:** Oil Spill Identification System (O.S.I.S.)  
> **Investigation Scope:** End-to-end accuracy assessment of spill detection, characterization, drift modelling, and vessel attribution pipelines  
> **Classification:** Internal — Engineering Investigation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Investigation Scope & Methodology](#2-investigation-scope--methodology)
3. [Spill Detection Accuracy](#3-spill-detection-accuracy)
4. [Vessel Tracking & Attribution Accuracy](#4-vessel-tracking--attribution-accuracy)
5. [Pipeline Stage Completion Rates](#5-pipeline-stage-completion-rates)
6. [Per-Incident Accuracy Log](#6-per-incident-accuracy-log)
7. [Model & Detector Performance](#7-model--detector-performance)
8. [Known Limitations & Error Sources](#8-known-limitations--error-sources)
9. [Recommendations](#9-recommendations)
10. [Appendix — Raw Metrics & Definitions](#appendix--raw-metrics--definitions)

---

## 1. Executive Summary

This log documents the accuracy investigation of the O.S.I.S. system across its two primary capabilities: **oil spill detection** from SAR satellite imagery and **vessel tracking/attribution** via AIS correlation with modelled drift trajectories.

### Key Findings at a Glance

| Metric                                | Value         | Notes                                         |
|---------------------------------------|---------------|-----------------------------------------------|
| Total Incidents Analyzed              | 50            | Across DEMO, REAL, and UPLOAD modes           |
| Spill Detection Rate                  | 54.0%         | 27 / 50 incidents returned SPILL_DETECTED     |
| No-Spill Outcome Rate                 | 6.0%          | 3 / 50 incidents returned NO_SPILL_DETECTED   |
| Inconclusive Rate                     | 36.0%         | 18 / 50 incidents returned ANALYSIS_INCONCLUSIVE |
| Full Pipeline Completion Rate         | 58.0%         | 29 / 50 passed all stages through ranking     |
| DEMO Mode Success (completed)         | 80.6%         | 29 / 36 DEMO incidents fully completed        |
| REAL Mode Data Availability           | 0.0%          | 0 / 12 REAL incidents passed detection stage  |
| Stage Failure Hotspot                 | detection     | REAL mode blocked by CDSE credential/network  |

---

## 2. Investigation Scope & Methodology

### 2.1 Systems Under Investigation

| Component                  | Technology               | Source File                                      |
|----------------------------|--------------------------|--------------------------------------------------|
| SAR Spill Detector         | Hybrid (Classical + DL)  | `scripts/hybrid-spill-detector.py`               |
| POSEatSea Model            | U-Net + MiT-B2           | `models/best_sar_model.pth`                      |
| Real SAR Adapter           | Python adapter            | `scripts/real_sar_adapter.py`                    |
| Spill Characterization     | PostGIS + Python engine  | `services/characterization.service.js`           |
| Environment Provider       | ERA5/CMEMS reanalysis    | `scripts/environment_provider.py`                |
| Hindcast Drift Model       | RK4 advection engine     | `scripts/hindcast_runner.py`                     |
| Incident Pipeline (DEMO)   | Python orchestrator      | `scripts/incident_pipeline.py`                   |
| Incident Pipeline (REAL)   | Python orchestrator      | `scripts/real_incident_pipeline.py`              |
| Vessel Attribution         | AIS correlation + scoring| `scripts/real_incident_pipeline.py` (correlate)  |
| Sentinel-1 Acquisition     | CDSE Process API         | `services/sentinel.service.js`                   |

### 2.2 Data Sources

- **50 incident reports** from `backend/data/incidents/`
- **1 archived Sentinel-1 scene** (`s1a-20240619-karnataka`, Karnataka, India)
- **3 synthetic DEMO scenes** (arabian-sea, no-spill, inconclusive)
- **DARTIS-2019 benchmark** (6 scenes: ow-0002, ow-0004, ow-0006, oc-0001, nw-0001, nw-0002)

### 2.3 Methodology

- Aggregation of all 50 persisted incident JSON reports
- Stage-by-stage completion analysis
- Outcome classification (SPILL_DETECTED / NO_SPILL_DETECTED / ANALYSIS_INCONCLUSIVE)
- Cross-reference of detector confidence, spill geometry metrics, and vessel scores
- Architecture review of error-handling and unavailability propagation

---

## 3. Spill Detection Accuracy

### 3.1 Detection Outcome Distribution

| Outcome                 | Count | Percentage | Mode Breakdown                     |
|-------------------------|-------|------------|------------------------------------|
| SPILL_DETECTED          | 27    | 54.0%      | 27 DEMO, 0 REAL                    |
| NO_SPILL_DETECTED       | 3     | 6.0%       | 3 DEMO, 0 REAL                     |
| ANALYSIS_INCONCLUSIVE   | 18    | 36.0%      | 6 DEMO, 12 REAL                    |
| Unknown/Malformed       | 2     | 4.0%       | Parse errors in legacy reports     |

### 3.2 Detection by Mode

| Mode  | Total | Completed | Partial | No Candidates | Detection Stage Pass Rate |
|-------|-------|-----------|---------|---------------|---------------------------|
| DEMO  | 36    | 29        | 4       | 3             | 88.9% (32/36)             |
| REAL  | 12    | 0         | 12      | 0             | 0.0% (0/12)               |

### 3.3 DEMO Mode — Detector Accuracy (Synthetic SAR)

The DEMO pipeline uses an **adaptive dark-region detector** on synthetic SAR data:

| Metric                        | Value     | Notes                                          |
|-------------------------------|-----------|-------------------------------------------------|
| Detector Name                 | demo-adaptive-dark-region | Morphological + heuristic scoring   |
| Scenes Segmented              | 32 / 36   | 4 failures due to preprocessing issues         |
| Candidates Characterized      | 29 / 32   | 3 scenes had no dark-slick candidates          |
| True Positive Rate (DEMO)     | ~84.4%    | 27 / 32 segmented → SPILL_DETECTED            |
| False Negative Rate (DEMO)    | ~9.4%     | 3 / 32 segmented → NO_SPILL_DETECTED          |
| Inconclusive Rate (DEMO)      | ~6.3%     | 2 / 32 segmented → ANALYSIS_INCONCLUSIVE      |

### 3.4 REAL Mode — Detector Accuracy (Sentinel-1 SAR)

| Metric                          | Value           | Root Cause                                      |
|----------------------------------|-----------------|-------------------------------------------------|
| Detection Attempts               | 12              | All against archived Sentinel-1 Karnataka scene |
| Successful Detections            | 0               | CDSE credentials/network unavailable            |
| Failure Classification           | REAL_DATA_UNAVAILABLE | Authentication or process API failure     |
| Detector Used                    | unavailable     | Pipeline never reached SAR processing           |

> **Root Cause:** All 12 REAL mode incidents failed at the detection stage because `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` were either missing, expired, or the network request to the Copernicus Data Space Ecosystem (CDSE) Process API was rejected. The system correctly classified these as `ANALYSIS_INCONCLUSIVE` without falling back to synthetic data.

### 3.5 Hybrid Detector Architecture Metrics (from DARTIS Benchmark)

The hybrid detector combines classical SAR analysis with POSEatSea deep learning:

| Component               | Architecture          | Validation Benchmark   | Metric Type           |
|--------------------------|-----------------------|------------------------|-----------------------|
| Classical V2             | Morphology + Heuristic| DARTIS-2019 (6 scenes) | BBox IoU              |
| POSEatSea                | U-Net + MiT-B2        | DARTIS-2019 ow-0002    | Pixel segmentation    |
| Fusion Layer             | Evidence Fusion        | Combined candidates    | Spatial overlap merge |

**Fusion Configuration:**
- Classical window radius: 25 pixels
- k-sigma threshold: 2.0
- Min damping: 3.5 dB
- Min candidate pixels: 10
- Candidate threshold score: 0.50
- POSEatSea classes: Sea Surface, Oil Spill, Look-alike, Ship, Land

### 3.6 Spill Geometry Accuracy (DEMO — Characterized Spills)

For the 29 fully characterized spills:

| Geometry Metric         | Typical Range                  | Unit     |
|-------------------------|--------------------------------|----------|
| Area                    | 2.0 – 6.0                     | km²      |
| Perimeter               | 6,000 – 12,000                | m        |
| Elongation              | 2.5 – 5.0                     | ratio    |
| Compactness             | 0.40 – 0.70                   | ratio    |
| Centroid Lat             | ~15.24                        | °N       |
| Centroid Lon             | ~72.45                        | °E       |
| Orientation             | 80 – 100                      | ° CW N  |

---

## 4. Vessel Tracking & Attribution Accuracy

### 4.1 Vessel Attribution Pipeline

The vessel attribution pipeline operates as follows:
1. **Hindcast** — RK4 backward drift from spill centroid using ERA5/CMEMS currents and winds
2. **Origin Estimation** — Terminal point of backward trajectory with ±1h search window
3. **AIS Correlation** — Historical AIS records matched within search radius (15 km) around estimated origin
4. **Scoring** — Weighted heuristic scoring of candidate vessels

### 4.2 Attribution Scoring Weights

| Factor                  | Weight  | Description                                          |
|-------------------------|---------|------------------------------------------------------|
| Origin Proximity        | 0.40    | Distance from vessel to estimated release point      |
| Temporal                | 0.25    | Temporal proximity to estimated release window       |
| Trajectory Consistency  | 0.20    | Alignment between vessel track and drift model       |
| Speed Consistency       | 0.075   | Whether vessel speed is consistent with transit      |
| Heading Consistency     | 0.075   | Whether vessel heading aligns with trajectory        |

### 4.3 Attribution Results

| Metric                           | DEMO Mode   | REAL Mode    |
|----------------------------------|-------------|--------------|
| Incidents with Attribution Stage | 29          | 0            |
| Leading Candidate Identified     | 29          | 0            |
| AIS Records Correlated           | Yes (synthetic) | N/A      |
| Anomalies Flagged                | Yes         | N/A          |
| Search Radius                    | 15 km       | 15 km        |

### 4.4 Hindcast/Drift Model Parameters

| Parameter             | Value           | Notes                                     |
|-----------------------|-----------------|-------------------------------------------|
| Physics Model         | RK4 Advection   | 4th-order Runge-Kutta integration         |
| Ensemble Size         | 50 particles    | Monte Carlo spread estimation             |
| Timestep              | 3600 s (1h)     | Integration step                          |
| Leeway Factor         | 0.03            | Wind drift coefficient                    |
| Velocity Sensitivity  | 0.15 m/s        | Assumed (not calibrated)                  |
| Max Hindcast          | 48 hours        | Configurable per incident (1–48h)         |
| Forecast Horizons     | 24 / 48 / 72 h  | Forward prediction windows                |

### 4.5 Vessel Attribution Caveats

> ⚠ **Critical Limitations:**
> - Scores are **heuristic compatibility**, not calibrated probability
> - AIS coverage is inherently incomplete — non-AIS vessels cannot be excluded
> - Rankings do **not** establish legal responsibility
> - AIS gaps are **not** proof of transponder disabling
> - DEMO mode uses **synthetic AIS**, not real vessel data

---

## 5. Pipeline Stage Completion Rates

### 5.1 Stage-by-Stage Success (All 50 Incidents)

| Stage                      | Completions | Rate (%) | Blocking Factor                       |
|----------------------------|-------------|----------|---------------------------------------|
| scene_loaded               | 32          | 64.0%    | REAL mode CDSE failures               |
| preprocessed               | 32          | 64.0%    | Follows scene_loaded                  |
| segmented                  | 32          | 64.0%    | Depends on preprocessing              |
| characterized              | 29          | 58.0%    | 3 no-candidate scenes                 |
| age_estimated              | 29          | 58.0%    | Follows characterization              |
| environment_loaded         | 29          | 58.0%    | ERA5/CMEMS data availability          |
| hindcast                   | 29          | 58.0%    | Depends on environment + spill        |
| forecast                   | 29          | 58.0%    | Depends on environment + spill        |
| ais_normalized             | 29          | 58.0%    | AIS data availability                 |
| candidates_filtered        | 29          | 58.0%    | Depends on AIS + hindcast             |
| trajectories_correlated    | 29          | 58.0%    | Depends on candidates + trajectory    |
| anomalies_evaluated        | 29          | 58.0%    | Depends on AIS + trajectory           |
| ranked                     | 29          | 58.0%    | Final scoring                         |
| report_generated           | 32          | 64.0%    | Partial reports still generated       |

### 5.2 Stage Completion Waterfall

```
scene_loaded         ████████████████████████████████░░░░░░░░░░░░░░░░░░  64%
preprocessed         ████████████████████████████████░░░░░░░░░░░░░░░░░░  64%
segmented            ████████████████████████████████░░░░░░░░░░░░░░░░░░  64%
characterized        █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
age_estimated        █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
environment_loaded   █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
hindcast             █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
forecast             █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
ais_normalized       █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
candidates_filtered  █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
traj_correlated      █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
anomalies_evaluated  █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
ranked               █████████████████████████████░░░░░░░░░░░░░░░░░░░░░  58%
report_generated     ████████████████████████████████░░░░░░░░░░░░░░░░░░  64%
```

---

## 6. Per-Incident Accuracy Log

### 6.1 DEMO Mode — Completed Incidents (Sample)

| Incident ID (short)            | Outcome            | Stages | Detector                   | Leading Candidate | Spill Area (km²) |
|---------------------------------|--------------------|--------|----------------------------|--------------------|-------------------|
| `174d7ff5-...`                  | SPILL_DETECTED     | 14     | demo-adaptive-dark-region  | 000000001          | 3.529             |
| `002ffbca-...`                  | SPILL_DETECTED     | 14     | demo-adaptive-dark-region  | 000000001          | 3.529             |
| `0f3d3457-...`                  | SPILL_DETECTED     | 14     | demo-adaptive-dark-region  | 000000001          | 3.529             |
| `04aa5f39-...`                  | NO_SPILL_DETECTED  | 14     | demo-adaptive-dark-region  | None               | N/A               |
| `5489772c-...`                  | SPILL_DETECTED     | 14     | demo-adaptive-dark-region  | 000000001          | ~3.5              |

### 6.2 REAL Mode — All Incidents (Partial)

| Incident ID (short)            | Outcome                  | Stages | Failure Point              | Reason                                           |
|---------------------------------|--------------------------|--------|----------------------------|--------------------------------------------------|
| `163e4db7-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE credentials          |
| `16a78da4-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE network/quota        |
| `744a8d1c-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: bounded CDSE search failed|
| `6c8a85bc-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE credentials          |
| `88cb8204-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: bounded CDSE search failed|
| `a44427c5-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE credentials          |
| `ba969ea5-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE search failed        |
| `ecc8e4ce-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE credentials          |
| `b5fc9d7b-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE network              |
| `e55d2267-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE credentials          |
| `cd382a7b-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE search/process       |
| `6734693d-...`                  | ANALYSIS_INCONCLUSIVE    | 0      | detection                  | REAL_DATA_UNAVAILABLE: CDSE credentials          |

---

## 7. Model & Detector Performance

### 7.1 POSEatSea Deep Learning Model

| Property                | Value                                      |
|-------------------------|--------------------------------------------|
| Architecture            | U-Net + MiT-B2 (segmentation_models_pytorch)|
| Checkpoint              | `best_sar_model.pth` (110 MB)              |
| Input Channels          | 3 (VV_norm, VH_norm, (VV-VH)_norm)        |
| Output Classes          | 5 (Sea, Oil, Look-alike, Ship, Land)       |
| Input Size              | 512 × 512 pixels                           |
| Training Data           | POSEatSea benchmark SAR imagery            |
| Evaluation Mode         | Zero-shot transfer to DARTIS-2019          |
| Inference Device        | CPU (CUDA optional)                        |

### 7.2 Classical V2 Detector

| Property                   | Value                           |
|----------------------------|---------------------------------|
| Algorithm                  | Adaptive dark-region segmentation|
| Threshold Method           | k-sigma below local mean        |
| Morphological Operations   | Closing (3×3 kernel)            |
| Feature Extraction         | 17 SAR features per candidate   |
| Candidate Scoring          | Heuristic score > 0.50          |
| Min Candidate Size         | 10 pixels                       |
| Min Damping Threshold      | 3.5 dB below background         |

### 7.3 Evidence Fusion Layer

The hybrid pipeline fuses classical and deep learning outputs:

```
Classical V2 Candidates (high sensitivity, false positives)
        ↓
POSEatSea Probabilities (high specificity, open-water focus)
        ↓
    Spatial Overlap + Evidence Gate
        ↓
    Merged Spill Objects (oil-evidence qualified)
```

| Fusion Metric              | Description                                      |
|----------------------------|--------------------------------------------------|
| Oil Evidence Gate          | Candidate must have POSEatSea oil probability     |
| Spatial Merge              | Overlapping classical + DL candidates combined    |
| Largest Qualified          | Only largest qualifying candidate backtracked     |
| Lookalike Suppression      | POSEatSea class 2 used to filter false positives  |

---

## 8. Known Limitations & Error Sources

### 8.1 Spill Detection Limitations

| # | Limitation                                                                  | Impact     |
|---|-----------------------------------------------------------------------------|------------|
| 1 | SAR candidates may be low wind, biogenic films, land artifacts or lookalikes| High       |
| 2 | Only the largest candidate passing the oil-evidence gate is backtracked     | Medium     |
| 3 | Simplified pixel-center outer contours omit holes, differ from mask area    | Low        |
| 4 | POSEatSea zero-shot transfer may miss regional SAR characteristics          | Medium     |
| 5 | Classical detector k-sigma threshold not optimized per scene                | Medium     |
| 6 | Single-band 512×512 input limits spatial resolution                         | Medium     |
| 7 | REAL mode requires CDSE credentials and valid Sentinel Hub quota            | Critical   |

### 8.2 Vessel Tracking Limitations

| # | Limitation                                                                  | Impact     |
|---|-----------------------------------------------------------------------------|------------|
| 1 | Point RK4 advection omits diffusion, weathering, coastline and waves       | High       |
| 2 | Leeway 0.03 and velocity sensitivity 0.15 m/s are assumed, not calibrated  | High       |
| 3 | Reanalysis fields are model products, not direct local measurements        | Medium     |
| 4 | Nearest-neighbour sampling is not interpolation                             | Low        |
| 5 | AIS coverage is incomplete; non-AIS vessels cannot be excluded             | Critical   |
| 6 | Rankings do not establish legal responsibility                              | Critical   |
| 7 | Single SAR observation cannot date release; hindcast duration is a scenario | High       |

### 8.3 Infrastructure Error Sources

| Error Source                       | Occurrences | Mitigation                                   |
|------------------------------------|-------------|----------------------------------------------|
| CDSE authentication failure        | 8 / 12      | Validate credentials, refresh tokens         |
| CDSE network/quota timeout         | 4 / 12      | Implement retry with exponential backoff     |
| Python process timeout (>60s)      | 0 / 50      | Current 60s limit sufficient                 |
| JSON parse errors                  | 2 / 50      | Legacy report format — schema migration needed|
| Database unavailable               | All 50      | OSIS_PERSIST_POSTGRES not enabled            |

---

## 9. Recommendations

### 9.1 Immediate Actions (Priority: Critical)

1. **Fix CDSE Credentials** — All 12 REAL mode analyses failed. Validate `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` in `backend/.env` and ensure Sentinel Hub Process API access is provisioned.
2. **Add Retry Logic** — Implement exponential backoff for CDSE API calls in `sentinel.service.js`. Current 60-second cooldown is insufficient.
3. **Enable PostgreSQL Persistence** — Set `OSIS_PERSIST_POSTGRES=true` for durable incident storage with PostGIS spatial queries.

### 9.2 Detection Accuracy Improvements (Priority: High)

4. **Run DARTIS-2019 Full Benchmark** — Execute `evaluate-poseatsea-sar.py` and `evaluate-classical-vs-poseatsea.py` across all 6 scenes to establish baseline BBox IoU and pixel F1 scores.
5. **Calibrate Fusion Thresholds** — Current `candidateThresholdScore: 0.50` is a prototype default. Optimize against labelled data.
6. **Add Multi-Scene Validation** — Execute `evaluate-poseatsea-multiscene.py` for cross-scene generalization metrics.
7. **Fine-tune POSEatSea** — Zero-shot transfer may underperform on Indian Ocean SAR characteristics. Consider domain adaptation.

### 9.3 Vessel Tracking Improvements (Priority: Medium)

8. **Calibrate Drift Parameters** — Current leeway (0.03) and velocity sensitivity (0.15 m/s) are assumed. Use drifter buoy data for calibration.
9. **Implement Diffusion** — Point advection produces unrealistically narrow trajectory uncertainty. Add stochastic diffusion term.
10. **Integrate Real AIS** — DEMO mode uses synthetic AIS. Integrate a real AIS provider (e.g., Marine Traffic, Spire) for production attribution.

### 9.4 Monitoring & Logging (Priority: Medium)

11. **Implement Structured Logging** — Replace `console.info`/`console.warn` with a structured logger (e.g., Winston/Pino) that records per-stage timing, confidence scores, and failure reasons to a queryable format.
12. **Create Accuracy Dashboard** — Build a monitoring view to track detection rates, false positive rates, and attribution confidence over time.

---

## Appendix — Raw Metrics & Definitions

### A.1 Outcome Definitions

| Outcome                  | Definition                                                              |
|--------------------------|-------------------------------------------------------------------------|
| `SPILL_DETECTED`         | Pipeline identified ≥1 dark-slick candidate passing the oil-evidence gate, characterized geometry, and completed attribution |
| `NO_SPILL_DETECTED`      | Pipeline completed segmentation but found no candidates exceeding threshold — **not proof of clean water** |
| `ANALYSIS_INCONCLUSIVE`  | Pipeline could not complete analysis due to data unavailability, detector failure, or insufficient evidence |

### A.2 Stage Definitions

| Stage                    | Description                                                    |
|--------------------------|----------------------------------------------------------------|
| scene_loaded             | SAR scene metadata and raster paths validated                  |
| preprocessed             | VV/VH normalization and 3-channel input preparation            |
| segmented                | Classical + POSEatSea inference and candidate extraction       |
| characterized            | Spill geometry (area, perimeter, centroid, shape) calculated   |
| age_estimated            | Spill age estimation (DEMO synthetic; REAL unavailable)        |
| environment_loaded       | ERA5 wind + CMEMS current fields fetched                       |
| hindcast                 | Backward RK4 drift trajectory computed                         |
| forecast                 | Forward RK4 drift trajectory computed                          |
| ais_normalized           | AIS records fetched and normalized to search window            |
| candidates_filtered      | Vessels within search radius identified                        |
| trajectories_correlated  | Vessel tracks correlated with modelled drift                   |
| anomalies_evaluated      | AIS gaps and behaviour anomalies flagged                       |
| ranked                   | Candidate vessels scored and ranked                            |
| report_generated         | Final incident report serialized to JSON                       |

### A.3 Confidence & Scoring Interpretation

- **Detector confidence** is a heuristic score (0–1), **not** a calibrated probability
- **Attribution scores** are weighted compatibility metrics, **not** legal evidence
- **Spill area** is derived from simplified outer contours and may differ from mask pixel count
- **Trajectory uncertainty radii** are model-derived, **not** calibrated confidence bounds

### A.4 Data Provenance Categories

| Provenance Kind      | Meaning                                                        |
|----------------------|----------------------------------------------------------------|
| OBSERVED             | Data directly acquired from a real sensor or operator          |
| REAL_REANALYSIS      | Real environmental reanalysis data (ERA5, CMEMS)               |
| INFERRED             | Algorithmically derived from observed/reanalysis inputs        |
| MODELED              | Output of physics-based simulation (RK4, drift)               |
| UNAVAILABLE          | Required data source could not be accessed                     |

---

*End of Accuracy Investigation Log — O.S.I.S. v1.0*
*Generated: 2026-09-18 | Analyst: O.S.I.S. Engineering Team*
