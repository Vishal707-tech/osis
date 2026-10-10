# O.S.I.S. Technical Deep-Dive & Cross-Questioning Defense Manual
## Oil Spill Identification, Drift Hindcasting & Source Attribution System
**Smart India Hackathon (SIH-PS26143)**

---

## Executive Summary & System Philosophy

**O.S.I.S.** is an end-to-end maritime environmental forensics platform designed to bridge the gap between spaceborne satellite observations and maritime law enforcement. When an oil slick is detected in ocean waters, the system answers three fundamental forensic questions:
1. **Detection & Verification:** Is this low-backscatter anomaly a genuine petroleum hydrocarbon slick, or a natural look-alike (algal bloom, low-wind zone, internal wave)?
2. **Trajectory & Origin Hindcasting:** Where and when was this slick originally discharged, given ocean surface currents and atmospheric wind forcing?
3. **Vessel Attribution:** Which maritime vessels were physically and temporally present at the discharge origin, and what is their forensic compatibility score?

### The Core Architectural Tenets
- **Strict Evidence Provenance:** The system strictly separates **DEMO** (synthetic fixtures), **REAL** (archived/on-demand Copernicus CDSE subsets), and **UPLOAD** (analyst-provided dual-pol GeoTIFFs). In REAL/UPLOAD modes, synthetic fixtures are **never** substituted for missing data.
- **Fail-Closed Deterministic Outcome Contract:** Every run produces exactly one forensic outcome:
  - `SPILL_DETECTED` — Verified slick confirmed by the hybrid detection engine.
  - `NO_SPILL_DETECTED` — Processed scene is free of candidate slicks above detection thresholds.
  - `ANALYSIS_INCONCLUSIVE` — Pipeline could not reach a sound forensic determination (e.g., missing data, invalid SAR coverage, sensor quality failure).
- **Decoupled Outcome vs. Completeness:** A run can have an outcome of `SPILL_DETECTED` while having a pipeline status of `partial` if downstream data (such as historical AIS or environmental reanalysis) is unavailable.
- **Forensic Objectivity (Compatibility vs. Guilt):** Candidate vessel rankings represent **kinematic and spatiotemporal compatibility indices**, *not* legal determinations of criminal liability. AIS gaps reduce evidence confidence rather than serving as standalone proof of guilt.

```
                                  O.S.I.S. PIPELINE ARCHITECTURE
                                  
    +-----------------------------------------------------------------------------------+
    |                                 INPUT SEGMENT                                     |
    |  - Sentinel-1 C-Band SAR (VV + VH GeoTIFF, EPSG:4326, FLOAT32 dB Calibrated)      |
    |  - Modes: DEMO (Synthetic) | REAL (Copernicus CDSE) | UPLOAD (Analyst Dual-Pol)   |
    +-----------------------------------------------------------------------------------+
                                            │
                                            ▼
    +-----------------------------------------------------------------------------------+
    |                         HYBRID DETECTION ENGINE (Dual-Path)                       |
    |                                                                                   |
    |   [Path A: Classical Physics V2]                [Path B: Deep Learning (DL)]      |
    |   - Local Clutter Filter (R=25, k=2.0)          - POSEatSea U-Net + MiT-B2        |
    |   - Damping Threshold (>= 3.5 dB)               - 5 Semantic Classes              |
    |   - 17 Morphological & Radiometric Features     - 3-Channel Normalized Tensor     |
    |   - Heuristic Scoring (Area, Elong, Damp, Pol)  - Softmax Probability Maps        |
    +-----------------------------------------------------------------------------------+
                                            │
                                            ▼
    +-----------------------------------------------------------------------------------+
    |                             EVIDENCE FUSION LAYER                                 |
    |   - Rule 1: Land Artifact Rejection (Overlap > 40% -> Rejection)                  |
    |   - Rule 2: Dynamic Coastal Preservation (Suppresses DL Look-alike Penalty)       |
    |   - Rule 3: Open-Water Dual Confirmation (Classical + DL Oil Agreement)          |
    |   - Rule 4: Open-Water Look-alike Suppression (Dampens Unconfirmed Candidates)    |
    |   - Spatial Merging (DBSCAN/Proximity <= 30 px, RDP Contour Simplification)       |
    +-----------------------------------------------------------------------------------+
                                            │
                                            ▼
    +-----------------------------------------------------------------------------------+
    |                         SPILL METRIC CHARACTERIZATION                             |
    |   - WGS-84 Ellipsoidal Local Transverse Tangent Projection (Exact M & N radii)     |
    |   - Green's Theorem Planar Metric Area & Centroid (Within 0.002% of PostGIS)      |
    |   - Inertia Tensor Area Moments (Ixx, Iyy, Ixy) -> PCA Major/Minor Axes & Elong   |
    |   - Minimum Bounding Rotated Box (OBB) via Rotating Calipers                      |
    |   - Compactness (Isoperimetric Quotient: 4*pi*Area / Perimeter^2)                 |
    +-----------------------------------------------------------------------------------+
                                            │
                                            ▼
    +-----------------------------------------------------------------------------------+
    |                     METOCEAN INGESTION & LAGRANGIAN DRIFT                         |
    |   - ECMWF ERA5 10m Wind Vectors (u10, v10) [28 km grid, 1h tolerance]            |
    |   - CMEMS GLORYS12 Ocean Currents (uo, vo) [9 km grid, 13h tolerance]            |
    |   - Advection Physics: V_total = V_current + 0.03 * V_wind (3% Leeway Rule)       |
    |   - Backward Hindcasting: V_bwd = -V_total via Runge-Kutta 4th Order (RK4)        |
    |   - Monte Carlo Ensemble (N=50 particles, Vogel Spiral, Stochastic Diffusion)     |
    |   - 95% Confidence Uncertainty Ellipse (Chi-Square critical value = 5.991)        |
    +-----------------------------------------------------------------------------------+
                                            │
                                            ▼
    +-----------------------------------------------------------------------------------+
    |                     HISTORICAL AIS CORRELATION & ATTRIBUTION                      |
    |   - Spatiotemporal Search Box: +/-15 km around Origin, +/-1 hr Release Window     |
    |   - AIS Anomaly / Dark Vessel Detection (Discontinuities > 1 hr)                  |
    |   - Multi-Factor Attribution Matrix (5 Weighted Features):                        |
    |       1. Origin Proximity (40%)        : exp(-d / 4 km)                           |
    |       2. Temporal Alignment (25%)      : exp(-dt / 2 h)                           |
    |       3. Trajectory Corridor (20%)     : exp(-d_corridor / 4 km)                  |
    |       4. Speed Plausibility (7.5%)     : exp(-mean_speed_error / 3 kn)            |
    |       5. Heading Consistency (7.5%)    : max(0, 1 - mean_heading_error / 90 deg)  |
    +-----------------------------------------------------------------------------------+
                                            │
                                            ▼
    +-----------------------------------------------------------------------------------+
    |                       PERSISTENCE & OPERATIONAL OUTPUT                            |
    |   - Immutable Cryptographic JSON Report Archive (SHA-256 asset hashes)            |
    |   - Transactional PostgreSQL + PostGIS Mirroring (002 & 003 Schemas)              |
    |   - Responsive Dashboard & SVG Map Visualizer (Independent of external map tiles) |
    +-----------------------------------------------------------------------------------+
```

---

## Segment 1: Satellite SAR Ingestion & Radar Physics

### 1.1 Why Synthetic Aperture Radar (SAR)?
Optical sensors (e.g., Sentinel-2, Landsat) rely on reflected solar radiation and are rendered completely blind by cloud cover, atmospheric haze, fog, and nighttime conditions. Marine oil spills frequently occur during adverse weather, rough seas, or under darkness.
SAR is an active microwave sensor (Sentinel-1 operates at **C-band, frequency 5.405 GHz, wavelength $\lambda \approx 5.6\text{ cm}$**). It emits coherent microwave pulses and measures the backscattered echo returned to the antenna, providing **24/7 all-weather, day-and-night imaging**.

### 1.2 The Physics of Ocean Radar Backscatter: Bragg Scattering
Clean ocean water surfaces are covered in high-frequency capillary waves (ripples driven by surface tension) and short gravity waves (driven by wind). When the radar microwave hits these periodic waves, coherent constructive interference occurs if the surface wave wavelength matches the radar wavelength according to the **Bragg Resonance Condition**:
$$\lambda_{\text{Bragg}} = \frac{\lambda_{\text{radar}}}{2 \sin(\theta_i)}$$
*Where $\theta_i$ is the incidence angle ($20^\circ - 46^\circ$ across the Sentinel-1 swath). At $\theta_i \approx 35^\circ$, $\lambda_{\text{Bragg}} \approx 4.8\text{ cm}$.*
This resonance causes strong diffuse microwave backscattering back to the satellite antenna, rendering the clean ocean as a bright-to-medium grey level in SAR imagery.

### 1.3 The Oil Damping Mechanism (Marangoni Effect)
When petroleum or biogenic oil forms a film on the ocean surface:
1. **Surface Tension Reduction:** The presence of surfactant molecules lowers the surface tension of the water.
2. **Marangoni Damping:** When surface capillary waves compress and dilate the oil film, surface tension gradients are induced. This causes viscoelastic resistance that exponentially dampens capillary and short gravity waves ($1\text{ cm} - 10\text{ cm}$).
3. **Specular Reflection:** Without capillary ripples, the ocean surface becomes aerodynamically and electromagnetically smooth. The incoming radar beam acts like light hitting a mirror: it undergoes **specular reflection** away from the satellite antenna.
4. **Dark Formation:** Virtually no microwave energy returns to the receiver, appearing as a distinct **dark formation (low backscatter patch)**.

```
       Radar Pulse                      Radar Pulse
          │                                │
          ▼ Clean Sea Surface              ▼ Oil-Covered Slick
      ~~~~~~~~~~~~                      ═════════════════════
      Capillary Waves Present           Capillary Waves Damped
      [Diffuse Bragg Scattering]        [Specular Mirror Reflection]
      ===> High Radar Backscatter       ===> Energy Reflects Away
      ===> Bright/Grey Ocean Pixels     ===> Dark Black Pixels
```

### 1.4 Polarimetry: VV vs. VH Channels
Sentinel-1 Interferometric Wide (IW) swath products provide dual polarization:
- **VV (Vertical transmit, Vertical receive):**
  - Electric field vectors oscillate vertically.
  - VV polarization is dominated by surface Bragg scattering.
  - Highly sensitive to surface roughness and sea clutter.
  - **Primary channel for oil slick detection** because the damping contrast ($\sigma^0_{\text{clean}} - \sigma^0_{\text{oil}}$) is maximum in VV ($3\text{ to }12\text{ dB}$).
- **VH (Vertical transmit, Horizontal receive):**
  - Cross-polarized channel measuring depolarized energy.
  - Highly sensitive to volume scattering, extreme wave breaking, and multiple-bounce corner reflectors.
  - Oil slicks have very low VH signal, often dropping near the sensor's Noise Equivalent Sigma Zero (NESZ $\approx -28\text{ dB}$).
  - **Vital for vessel and look-alike discrimination:** Metallic ships appear as brilliant point reflectors in VH due to dihedral and trihedral corner bounce, whereas oil slicks exhibit uniform low backscatter across both channels.

### 1.5 Radiometric Calibration: Linear to Decibel (dB) Conversion
Raw SAR Level-1 Ground Range Detected (GRD) products provide digital numbers (DN) or calibrated linear backscatter intensity $\sigma^0_{\text{linear}}$.
OSIS requires calibrated decibels ($\text{dB}$):
$$\sigma^0_{\text{dB}} = 10 \cdot \log_{10}(\sigma^0_{\text{linear}})$$
- Linear intensities are non-negative. Zero or negative raw values indicate missing data / no-data masks and are converted to `-9999.0` (flagged invalid).
- Normal marine backscatter ranges from $-24\text{ dB}$ (calm seas) to $-10\text{ dB}$ (windy seas). Severe oil damping drops backscatter below $-25\text{ dB}$ to $-32\text{ dB}$.

### 1.6 Input Raster Contract & Security Bounds
- Format: Single-band, single-page FLOAT32 GeoTIFF, EPSG:4326 (WGS-84), PixelIsArea, North-up.
- Grid: $512 \times 512$ pixels, spatial extent $\le 0.2^\circ$ per AOI side ($\approx 22\text{ km} \times 22\text{ km}$).
- Size Ceiling: Maximum $8\text{ MiB}$ per polarization file.
- Valid Data Gate: Joint valid mask requires $\ge 50\%$ finite, positive, valid ocean pixels.
- Copernicus CDSE Client: Bounded OAuth2 tokens, max 5 catalog records, 15-second request timeout, zero auto-retries, 60s cooldown.

---

## Segment 2: Classical Candidate Detection Engine

The Classical detector (`run_classical_candidates`) is an adaptive, high-sensitivity computer vision engine designed to isolate potential dark slicks without assuming prior neural network availability.

```
+------------------------------------------------------------------------------------+
|                         CLASSICAL DETECTION FLOWCHART                              |
|                                                                                    |
|   Calibrated VV (dB) ──> Moving Window Box Filter (R=25 px)                        |
|                                    │                                               |
|                                    ▼                                               |
|                 Compute Local Mean (μ) & Local StdDev (σ)                          |
|                                    │                                               |
|                                    ▼                                               |
|                 Adaptive Threshold: (μ - VV) >= 2.0*σ AND (μ - VV) >= 3.5 dB       |
|                                    │                                               |
|                                    ▼                                               |
|                 3x3 Morphological Rectangular Closing                              |
|                                    │                                               |
|                                    ▼                                               |
|                 8-Way Connected Components (Filter Area < 10 px)                   |
|                                    │                                               |
|                                    ▼                                               |
|                 Extract 17 Physical Features & Heuristic Score                     |
|                                    │                                               |
|                                    ▼                                               |
|                 Retain Candidates with Heuristic Score >= 0.50                     |
+------------------------------------------------------------------------------------+
```

### 2.1 Adaptive Local Clutter Thresholding (k-Sigma)
Global intensity thresholds fail across SAR scenes due to:
1. Antenna gain patterns and radar incidence angle decay across the swath (steep near-range vs. shallow far-range).
2. Regional sea-surface wind gradients (high wind creates brighter sea clutter; low wind creates darker sea clutter).

OSIS implements an adaptive moving window filter:
- Window radius $R = 25\text{ pixels}$ (window size $W = 2R + 1 = 51\text{ pixels}$).
- Using integral images (`cv2.boxFilter`), the local mean $\mu_{\text{VV}}(x,y)$ and variance $\sigma^2_{\text{VV}}(x,y)$ of ocean clutter are computed in $O(1)$ time per pixel:
$$\mu_{\text{VV}} = \frac{1}{N} \sum_{i,j \in W} \text{VV}_{i,j}, \quad \sigma_{\text{VV}} = \sqrt{\frac{1}{N}\sum_{i,j \in W} \text{VV}_{i,j}^2 - \mu_{\text{VV}}^2}$$
- **Damping Ratio:** $\text{Damping}(x,y) = \mu_{\text{VV}}(x,y) - \text{VV}(x,y)$
- **Dark Slick Selection Criterion:**
$$\text{Pixel is Dark} \iff \begin{cases} \text{Damping}(x,y) \ge k \cdot \sigma_{\text{VV}}(x,y) & (k = 2.0) \\ \text{Damping}(x,y) \ge 3.5\text{ dB} & (\text{Minimum Physical Damping}) \\ \text{Valid Ocean Pixel} = \text{True} & (N \ge 20 \text{ window pixels}) \end{cases}$$

### 2.2 Morphological Filtering & Connected Components
- **Speckle Noise:** SAR images suffer from multiplicative granular speckle noise caused by random interference among sub-resolution scatterers.
- **Closing Operator:** A $3 \times 3$ rectangular structuring element performs morphological closing ($\text{Dilation} \to \text{Erosion}$):
$$A \bullet B = (A \oplus B) \ominus B$$
This fills intra-slick speckle holes and bridges tiny fragmentation gaps while preserving outer boundaries.
- **Connected Components:** 8-connectivity component labeling isolates discrete candidate blobs. Any candidate with $\text{Area} < 10\text{ pixels}$ is rejected as speckle noise.

### 2.3 Extraction of the 17 Physical & Radiometric Features
For each candidate blob, an **11x11 dilation collar** is computed around the blob (excluding the blob itself) to measure pristine surrounding ocean clutter:
1. `area`: Total pixel count.
2. `centroid`: Coordinate $(\bar{x}, \bar{y})$ in raster space.
3. `bbox`: Extents $[x_{\min}, y_{\min}, x_{\max}, y_{\max}]$.
4. `mean_vv_c`: Mean backscatter of slick in VV (dB).
5. `mean_vh_c`: Mean backscatter of slick in VH (dB).
6. `collar_vv`: Mean background clutter in surrounding collar (VV dB).
7. `collar_vh`: Mean background clutter in surrounding collar (VH dB).
8. `vvDampingDb`: $\text{collar\_vv} - \text{mean\_vv\_c}$ (primary damping strength).
9. `vhDampingDb`: $\text{collar\_vh} - \text{mean\_vh\_c}$ (cross-pol damping).
10. `dampingDiffDb`: $\text{vvDampingDb} - \text{vhDampingDb}$ (polarimetric damping difference).
11. `vvVhDifferenceDb`: $\text{mean\_vv\_c} - \text{mean\_vh\_c}$.
12. `mu20`: Second central horizontal moment.
13. `mu02`: Second central vertical moment.
14. `mu11`: Second central cross moment.
15. `elongation`: Ratio of principal moments of inertia ($\sqrt{\lambda_1 / \lambda_2}$).
16. `boundaryGradient`: Mean Sobel edge gradient magnitude along candidate perimeter:
    $$\nabla I = \sqrt{\left(\frac{\partial I}{\partial x}\right)^2 + \left(\frac{\partial I}{\partial y}\right)^2}$$
    *Physical rationale: Fresh oil slicks have steep, sharp damping boundaries; weathered biogenic films have diffuse gradients.*
17. `heuristicScore`: Multi-attribute composite score.

### 2.4 Classical Heuristic Scoring Function
The composite heuristic score $S_{\text{classical}} \in [0.0, 1.0]$ is computed as:
$$S_{\text{classical}} = 0.15 S_{\text{area}} + 0.20 S_{\text{elong}} + 0.25 S_{\text{vv}} + 0.15 S_{\text{pol}} + 0.10 S_{\text{vh}} + 0.15 S_{\text{grad}}$$
- $S_{\text{area}}$: Scaled linearly: $\ge 100\text{ px} \to 1.0$; $30-100\text{ px} \to [0.5, 1.0]$.
- $S_{\text{elong}}$: Scaled linearly: $\ge 2.5 \to 1.0$; $1.5-2.5 \to [0.5, 1.0]$. (Oil discharges from moving vessels form elongated trails).
- $S_{\text{vv}}$: Scaled linearly: $\ge 7.0\text{ dB} \to 1.0$; $5.0-7.0\text{ dB} \to [0.6, 1.0]$; $3.5-5.0\text{ dB} \to [0.2, 0.6]$.
- $S_{\text{pol}}$: Damping difference: $\ge 4.0\text{ dB} \to 1.0$; $1.5-4.0\text{ dB} \to [0.5, 1.0]$.
- $S_{\text{vh}}$: Penalizes high VH (which indicates ship superstructures or volume clutter).
- $S_{\text{grad}}$: Boundary sharpness: $\ge 5.0 \to 1.0$; $2.5-5.0 \to [0.5, 1.0]$.
- **Retention Gate:** Candidates with $S_{\text{classical}} \ge 0.50$ are forwarded to the Evidence Fusion Layer.

---

## Segment 3: Deep Learning Segmentation Model (POSEatSea)

### 3.1 Model Architecture: U-Net + MiT-B2 Encoder
The deep learning component employs an advanced semantic segmentation network:
- **Architecture:** U-Net encoder-decoder topology.
- **Encoder Backbone:** **MiT-B2 (Mix-Transformer B2)** from SegFormer.
  - Unlike classical CNNs (ResNet) that use fixed receptive fields, MiT-B2 utilizes hierarchical self-attention with overlapping patch embeddings.
  - Generates multi-scale feature maps at $1/4, 1/8, 1/16, 1/32$ resolution.
  - Captures both local high-frequency boundary textures (slick edges) and broad spatial context (surrounding ocean vs. coastline vs. shipping lanes).
- **Decoder:** Standard U-Net progressive upsampling decoder with skip connections from the MiT-B2 stages to restore high-resolution spatial boundaries.

```
       [Input: 3 x 512 x 512 Normalized SAR Tensor]
                          │
         ┌────────────────┴────────────────┐
         ▼                                 ▼
   [Hierarchical Transformer]      [Skip Connections]
     MiT-B2 Stage 1 (1/4)   ──────> U-Net Decoder 4
     MiT-B2 Stage 2 (1/8)   ──────> U-Net Decoder 3
     MiT-B2 Stage 3 (1/16)  ──────> U-Net Decoder 2
     MiT-B2 Stage 4 (1/32)  ──────> U-Net Decoder 1
                                           │
                                           ▼
                            [Softmax Output: 5 x 512 x 512]
                            Class 0: Sea Surface
                            Class 1: Oil Spill
                            Class 2: Look-alike
                            Class 3: Ship / Vessel
                            Class 4: Land
```

### 3.2 Target Semantic Classes (5-Class Formulation)
1. **Class 0 — Sea Surface:** Baseline unpolluted ocean water under ambient wind conditions.
2. **Class 1 — Oil Spill:** Petroleum hydrocarbon releases (crude oil, heavy fuel oil, bunker discharge, bilge dumping).
3. **Class 2 — Look-alike:** Low-wind areas ($< 3\text{ m/s}$), natural biogenic surfactant films (phytoplankton secretions, fish oils), internal solitary waves, upwelling zones, rain cells.
4. **Class 3 — Ship:** Marine vessels appearing as bright multi-bounce radar targets.
5. **Class 4 — Land:** Terrestrial landmasses, islands, coastline, mudflats, and port facilities.

### 3.3 3-Channel Input Normalization Tensor
The raw SAR dB bands are normalized to $[0.0, 1.0]$ using robust 2nd-to-98th percentile clipping ($P_2, P_{98}$) to eliminate extreme outlier pixels:
$$\text{Channel}_0 = \text{clip}\left(\frac{\text{VV} - P_{2,\text{VV}}}{P_{98,\text{VV}} - P_{2,\text{VV}} + \epsilon}, 0, 1\right)$$
$$\text{Channel}_1 = \text{clip}\left(\frac{\text{VH} - P_{2,\text{VH}}}{P_{98,\text{VH}} - P_{2,\text{VH}} + \epsilon}, 0, 1\right)$$
$$\text{Channel}_2 = \text{clip}\left(\frac{(\text{VV} - \text{VH}) - P_{2,\text{diff}}}{P_{98,\text{diff}} - P_{2,\text{diff}} + \epsilon}, 0, 1\right)$$
- **Channel 2 (Cross-polarization difference):** Provides the model with direct physical information on depolarization and surface roughness ratio.

### 3.4 Runtime Execution & Security Constraints
- Device: CPU execution (`torch.device('cpu')`), strictly bounded to 2 threads (`torch.set_num_threads(2)`).
- Subprocess Guard: Spooled to temporary file; maximum 35-second hard execution deadline; max 4 MiB output.
- Checkpoint Security: `weights_only=True` prevents arbitrary code execution vulnerabilities via pickle deserialization. Maximum model file size ceiling: $200\text{ MiB}$ (local checkpoint `best_sar_model.pth` is $110\text{ MiB}$).

---

## Segment 4: Evidence Fusion Layer & Spatial Merging

### 4.1 The Fundamental Trade-off: Classical vs. Deep Learning
- **Classical V2 Strengths:** Extremely sensitive; retains thin, elongated trails and coastal slicks; directly computes physical radar damping; does not suffer from domain-shift artifacts near shorelines.
- **Classical V2 Weakness:** High false positive rate in open water due to natural look-alikes (low-wind zones).
- **POSEatSea DL Strengths:** Excellent open-water semantic discrimination; trained on large datasets to recognize the contextual footprint of biogenic slicks vs. mineral oil.
- **POSEatSea DL Weakness:** Can over-smooth narrow slicks; frequently misclassifies genuine coastal oil slicks as "look-alikes" or "land" due to complex coastal bathymetry, tidal currents, and land adjacency.

### 4.2 The 4 Fusion Rules

```
                      EVIDENCE FUSION DECISION TREE
                                    │
                                    ▼
                 Is Candidate Land Overlap > 40%?
                 ├─── YES ───> [RULE 1: land_artifact_rejected]
                 │             Fused Score = 0.0
                 └─── NO
                       │
                       ▼
                 Is Candidate within ~1 km of Land?
                 (Coastal Proximity > 0.10)
                 ├─── YES ───> [RULE 2: coastal_preserved]
                 │             Look-alike penalty suppressed
                 │             Classical sensitivity protected
                 └─── NO
                       │
                       ▼
                 Does DL confirm Oil? (P_oil >= 0.15 OR >= 10 local px)
                 ├─── YES ───> [RULE 3: open_water_dual_confirmed]
                 │             Dual-weight combination + Damping bonus
                 └─── NO ───> [RULE 4: open_water_suppressed]
                               Heavy look-alike damping (0.20x)
```

#### Rule 1: Land Artifact Rejection (`land_artifact_rejected`)
If the candidate's bounding area overlaps with the POSEatSea Land mask (Class 4) by more than 40%:
$$S_{\text{fused}} = 0.0$$
*Eliminates false detections caused by tidal flats, sandbars, mangrove fringes, and coastal breakwaters.*

#### Rule 2: Coastal Slick Preservation (`coastal_preserved`)
When candidate distance to land $d_{\text{land}} \le 60\text{ px} \approx 1\text{ km}$, coastal proximity index is:
$$\text{Prox}_{\text{coastal}} = \max\left(0, 1 - \frac{d_{\text{land}}}{60}\right)$$
Because neural networks routinely misclassify shallow-water coastal oil as look-alikes, the look-alike penalty is dampened:
$$\text{eff\_la} = e_{\text{la}} \cdot \max(0, 1 - \text{Prox}_{\text{coastal}} \cdot 1.0)$$
$$S_{\text{fused}} = S_{\text{classical}} \cdot (1.0 - 0.15 \cdot \text{eff\_la}) + 0.15 \cdot e_{\text{oil}} + 0.05 \cdot \text{Prox}_{\text{coastal}}$$
*Preserves genuine oil slicks entering coastal waters and ports.*

#### Rule 3: Open-Water Dual Confirmation (`open_water_dual_confirmed`)
Active when in open water and the DL model confirms oil presence ($e_{\text{oil}} \ge 0.15$ or $\ge 10$ confirmed DL oil pixels nearby):
$$S_{\text{fused}} = 0.45 \cdot S_{\text{classical}} + 0.45 \cdot e_{\text{oil}} + 0.10 \cdot \min\left(1.0, \frac{\text{Damping}_{\text{VV}}}{6.0}\right) - 0.05 \cdot e_{\text{la}}$$
*High confidence state: both physics-based damping and neural representation agree.*

#### Rule 4: Open-Water Look-alike Suppression (`open_water_suppressed`)
Active when in open water but DL fails to detect oil ($e_{\text{oil}} < 0.15$):
$$S_{\text{fused}} = S_{\text{classical}} \cdot 0.20 \cdot (1.0 - e_{\text{la}})$$
*Suppresses false alarms from calm water and algal blooms by an 80% damping penalty.*

### 4.3 Spatial Slick Merging & Contour Simplification
Discharge slicks frequently fragment into clusters of disconnected droplets and streamers due to surface wave turbulence.
- **Clustering:** Retained candidates with centroids within $30\text{ pixels}$ ($\approx 500\text{ m}$) are spatially aggregated.
- **Polygon Extraction:** Binary mask union is contoured using `cv2.findContours`.
- **Ramer-Douglas-Peucker (RDP) Simplification:** Contour vertices are simplified using `cv2.approxPolyDP` with tolerance $\epsilon = 0.01 \times \text{ArcLength}$, yielding lightweight, topologically valid GeoJSON polygon rings.

---

## Segment 5: Spill Metric Characterization & Geometrical Math

To provide defensible legal and environmental evidence, OSIS performs precise metric characterization (`characterize_spill.py`) using Riemannian differential geometry.

### 5.1 WGS-84 Ellipsoidal Local Tangent Plane Projection
Spherical Earth approximations induce significant distortions when measuring areas and lengths. OSIS projects geodetic coordinates $(\lambda, \phi)$ onto a local metric tangent plane centered at the slick centroid $(\lambda_0, \phi_0)$ using the **WGS-84 Ellipsoid** ($a = 6378137.0\text{ m}$, $f = 1/298.257223563$, $e^2 = 2f - f^2$):
1. **Meridional Radius of Curvature (North-South):**
   $$M(\phi_0) = \frac{a(1 - e^2)}{(1 - e^2 \sin^2\phi_0)^{3/2}} \implies \text{Scale}_{\text{Lat}} = \frac{\pi}{180} M(\phi_0) \quad (\text{meters/degree})$$
2. **Prime Vertical Radius of Curvature (East-West):**
   $$N(\phi_0) = \frac{a}{\sqrt{1 - e^2 \sin^2\phi_0}} \implies \text{Scale}_{\text{Lon}} = \frac{\pi}{180} N(\phi_0) \cos\phi_0 \quad (\text{meters/degree})$$
3. **Metric Coordinates:**
   $$x_i = (\lambda_i - \lambda_0) \cdot \text{Scale}_{\text{Lon}}, \quad y_i = (\phi_i - \phi_0) \cdot \text{Scale}_{\text{Lat}}$$
*Accuracy: This metric projection matches PostGIS spheroidal `ST_Area(geom::geography)` within **0.002%**.*

### 5.2 Exact Metric Area & Planar Centroid (Green's Theorem)
Using the Shoelace formula derived from Green's Theorem ($\iint_D dA = \frac{1}{2} \oint_{\partial D} (x dy - y dx)$):
$$A = \frac{1}{2} \left| \sum_{i=0}^{n-1} (x_i y_{i+1} - x_{i+1} y_i) \right| = \frac{1}{2} \left| \sum_{i=0}^{n-1} C_i \right|$$
Where $C_i = x_i y_{i+1} - x_{i+1} y_i$ represents the cross product of adjacent vertices.
The planar centroid $(\bar{x}, \bar{y})$ is:
$$\bar{x} = \frac{1}{6A} \sum_{i=0}^{n-1} (x_i + x_{i+1}) C_i, \quad \bar{y} = \frac{1}{6A} \sum_{i=0}^{n-1} (y_i + y_{i+1}) C_i$$
The centroid is unprojected back to geodetic WGS-84: $\lambda_{\text{centroid}} = \lambda_0 + \bar{x}/\text{Scale}_{\text{Lon}}$, $\phi_{\text{centroid}} = \phi_0 + \bar{y}/\text{Scale}_{\text{Lat}}$.

### 5.3 Second Central Area Moments (Inertia Tensor & PCA)
To compute orientation, elongation, and principal axes without bounding box orientation bias, OSIS computes the exact polynomial moments of area:
$$I_{xx} = \iint y^2 dA = \frac{1}{12} \sum_{i=0}^{n-1} (y_i^2 + y_i y_{i+1} + y_{i+1}^2) C_i$$
$$I_{yy} = \iint x^2 dA = \frac{1}{12} \sum_{i=0}^{n-1} (x_i^2 + x_i x_{i+1} + x_{i+1}^2) C_i$$
$$I_{xy} = \iint xy dA = \frac{1}{24} \sum_{i=0}^{n-1} (2x_i y_i + x_i y_{i+1} + x_{i+1} y_i + 2x_{i+1} y_{i+1}) C_i$$
Central moments (variances and covariance):
$$\mu_{xx} = \frac{I_{yy}}{A} - \bar{x}^2, \quad \mu_{yy} = \frac{I_{xx}}{A} - \bar{y}^2, \quad \mu_{xy} = \frac{I_{xy}}{A} - \bar{x}\bar{y}$$
The eigenvalues of the $2 \times 2$ covariance matrix $\mathbf{\Sigma} = \begin{bmatrix} \mu_{xx} & \mu_{xy} \\ \mu_{xy} & \mu_{yy} \end{bmatrix}$ are:
$$\lambda_{1,2} = \frac{\text{tr}(\mathbf{\Sigma})}{2} \pm \sqrt{\frac{\text{tr}(\mathbf{\Sigma})^2}{4} - \det(\mathbf{\Sigma})}$$
- **Major Axis Length:** $L_{\text{major}} = 4 \sqrt{\lambda_1}$
- **Minor Axis Length:** $L_{\text{minor}} = 4 \sqrt{\lambda_2}$
- **Elongation Ratio:** $E = \sqrt{\frac{\lambda_1}{\lambda_2}} \ge 1.0$
- **Orientation:** Direction of principal eigenvector corresponding to $\lambda_1$, measured clockwise from True North ($0^\circ - 180^\circ$):
  $$\theta = \text{atan2}(v_x, v_y) \pmod{180^\circ}$$

### 5.4 Minimum Bounding Rotated Box (OBB) & Compactness
- **Oriented Bounding Box (OBB):** Rotating Calipers algorithm on the Monotone Chain 2D Convex Hull finds the absolute minimum enclosing rectangle ($L_{\text{OBB}}, W_{\text{OBB}}$).
- **Compactness (Isoperimetric Quotient):**
  $$\Psi = \frac{4 \pi \cdot \text{Area}}{\text{Perimeter}^2} \in (0, 1]$$
  *A perfect circle has $\Psi = 1.0$. Highly elongated, sinuous ship-trail slicks have $\Psi \ll 0.1$.*

---

## Segment 6: Environmental Metocean Data Ingestion

Oil slick drift is governed by surface ocean dynamics and boundary layer wind shear.

```
+------------------------------------------------------------------------------------+
|                         METOCEAN ADVECTION PHYSICS                                 |
|                                                                                    |
|       Wind Vector (U_10, V_10)                    Surface Current (U_c, V_c)       |
|       Source: ECMWF ERA5                          Source: CMEMS GLORYS12           |
|       Grid: 0.25° (~28 km)                        Grid: 0.083° (~9 km)             |
|       Max Time Offset: 1 hour                     Max Time Offset: 13 hours        |
|                  │                                           │                     |
|                  ▼                                           ▼                     |
|         Scale by Leeway (3%)                        100% Direct Advection          |
|         0.03 * V_wind                               1.00 * V_current               |
|                  │                                           │                     |
|                  └───────────────────┬───────────────────────┘                     |
|                                      │                                             |
|                                      ▼                                             |
|                     V_total = V_current + 0.03 * V_wind                            |
|                                      │                                             |
|                                      ▼                                             |
|                     Lagrangian Backward Hindcasting (-V_total)                     |
+------------------------------------------------------------------------------------+
```

### 6.1 Atmospheric Wind: ECMWF ERA5 Reanalysis
- Source: European Centre for Medium-Range Weather Forecasts (ECMWF) ERA5 atmospheric reanalysis.
- Variables: `u10` (eastward 10m wind velocity in m/s), `v10` (northward 10m wind velocity in m/s).
- Spatial Resolution: $0.25^\circ \times 0.25^\circ$ ($\approx 28\text{ km}$).
- Tolerance Gate: Nearest-neighbor temporal offset $\le 1\text{ hour}$; spatial distance $\le 0.3^\circ$.

### 6.2 Ocean Surface Currents: CMEMS GLORYS12 Reanalysis
- Source: Copernicus Marine Environment Monitoring Service (CMEMS) GLOBAL_MULTIYEAR_PHY_001_030 (GLORYS12V1).
- Variables: `uo` (surface eastward velocity in m/s), `vo` (surface northward velocity in m/s).
- Depth Selection: Surface layer only ($\text{depth} \le 1.0\text{ m}$; nominal layer at $0.49\text{ m}$).
- Spatial Resolution: $0.083^\circ \times 0.083^\circ$ ($\approx 9\text{ km}$ / $1/12^\circ$).
- Tolerance Gate: Nearest-neighbor temporal offset $\le 13\text{ hours}$ (daily reanalysis product); spatial distance $\le 0.15^\circ$.

### 6.3 Fail-Closed Real Ingestion Architecture
Unlike naive systems that fill missing data with zeros or static averages:
- NetCDF files are validated for rectilinear, monotonic, CF-compliant datetime64 dimensions.
- If either ERA5 or CMEMS fails, encounters a missing data mask (NaN), or exceeds spatial/temporal tolerances along **any point** of the RK4 trajectory, the system throws an explicit `Unavailable` exception.
- This produces a transparent `ANALYSIS_INCONCLUSIVE` or `partial` report rather than computing a corrupted drift trajectory.

---

## Segment 7: Lagrangian Drift Modeling (RK4 Integration & Monte Carlo Ensemble)

### 7.1 Governing Equations of Oil Slick Motion
The total advection velocity $\vec{V}_{\text{total}}$ of a floating oil parcel is governed by direct surface current transport combined with wind drag:
$$\vec{V}_{\text{total}} = \vec{V}_{\text{current}} + \alpha \cdot \vec{V}_{\text{wind}}$$
- **Leeway Factor ($\alpha = 0.03$):** The empirical **3% wind leeway rule** is an international standard adopted by the International Maritime Organization (IMO) and U.S. Coast Guard Search and Rescue (SAR) modeling. It accounts for:
  1. Direct aerodynamic drag on the oil slick surface.
  2. Wind-induced Stokes drift in the upper wave boundary layer.
- **Backward Advection (Hindcasting):**
  To trace where the oil came from at time $t - \Delta t$, the velocity vector is negated:
  $$\vec{V}_{\text{hindcast}} = -\vec{V}_{\text{total}}$$

### 7.2 Runge-Kutta 4th Order (RK4) Integration Scheme
Euler integration ($y_{n+1} = y_n + \Delta t \cdot v$) suffers from $O(\Delta t)$ accumulation error, causing trajectories to diverge over 12-48 hour simulations. OSIS implements **Runge-Kutta 4th Order (RK4)** integration with time step $\Delta t = 3600\text{ s}$ (1 hour):
$$k_1 = f(t_n, \vec{x}_n)$$
$$k_2 = f\left(t_n - \frac{\Delta t}{2}, \vec{x}_n + \frac{\Delta t}{2} k_1\right)$$
$$k_3 = f\left(t_n - \frac{\Delta t}{2}, \vec{x}_n + \frac{\Delta t}{2} k_2\right)$$
$$k_4 = f(t_n - \Delta t, \vec{x}_n + \Delta t k_3)$$
$$\vec{x}_{n+1} = \vec{x}_n + \frac{\Delta t}{6} (k_1 + 2 k_2 + 2 k_3 + k_4)$$
- **Velocity conversion:** Velocities in $\text{m/s}$ are converted to spherical angular velocities:
  $$\frac{d\phi}{dt} = \frac{v}{R_{\text{Earth}}}, \quad \frac{d\lambda}{dt} = \frac{u}{R_{\text{Earth}} \cos\phi}$$
- **Accuracy:** RK4 provides local truncation error of $O(\Delta t^5)$ and global truncation error of $O(\Delta t^4)$, maintaining sub-kilometer precision over multiple days.

### 7.3 Monte Carlo Ensemble Dispersion
A single deterministic particle trajectory cannot account for turbulent ocean diffusion or sub-gridscale shear. OSIS deploys a **Monte Carlo particle ensemble ($N = 50$ particles)**:
1. **Initial Seeding:** Particles are initialized across the slick geometry using either interior polygon uniform rejection sampling or a **Vogel Spiral** (Golden Ratio $\Phi = \frac{1+\sqrt{5}}{2}$):
   $$\theta_i = \frac{2\pi i}{\Phi}, \quad r_i = R_{\text{seed}} \sqrt{\frac{i + 0.5}{N}}$$
2. **Stochastic Turbulent Diffusion:** At each RK4 step, a Gaussian random walk perturbation is added to simulate horizontal eddy diffusivity:
   $$\sigma_{\text{turb}} = 0.08\text{ km} \quad (80\text{ meters per hour})$$

### 7.4 95% Confidence Uncertainty Ellipse & Mathematical Origin
At the terminal hindcast step ($t_{\text{origin}}$), the 50 dispersed particles form a spatial scatter cloud:
1. Centroid $(\bar{\lambda}, \bar{\phi})$ is computed.
2. Metric covariance matrix $\mathbf{C} = \begin{bmatrix} \sigma_{\lambda\lambda} & \sigma_{\lambda\phi} \\ \sigma_{\lambda\phi} & \sigma_{\phi\phi} \end{bmatrix}$ is evaluated.
3. Eigenvalues $e_1, e_2$ and eigenvectors are extracted.
4. **The 95% Confidence Factor (5.991):**
   For a two-dimensional bivariate Gaussian distribution, the cumulative distribution function follows a Chi-Square ($\chi^2$) distribution with 2 degrees of freedom:
   $$P\left(\mathbf{x}^T \mathbf{C}^{-1} \mathbf{x} \le c^2\right) = 1 - e^{-c^2 / 2} = 0.95 \implies c^2 = -2 \ln(0.05) \approx \mathbf{5.991}$$
   - **Semi-Major Axis:** $a = \sqrt{5.991 \cdot e_1}$
   - **Semi-Minor Axis:** $b = \sqrt{5.991 \cdot e_2}$
   - **Convex Hull:** A Graham Scan algorithm computes the bounding envelope of the particle cloud.

---

## Segment 8: Historical AIS Ingestion & Vessel Attribution Matrix

Once the release origin $(\lambda_{\text{orig}}, \phi_{\text{orig}})$ and release time window $[T_{\text{start}}, T_{\text{end}}]$ are established, OSIS correlates historical Automatic Identification System (AIS) tracks.

```
+------------------------------------------------------------------------------------+
|                       VESSEL ATTRIBUTION SCORING MATRIX                            |
|                                                                                    |
|   Candidate AIS Track in Search Window (+/-15 km, +/-1 hr)                         |
|                           │                                                        |
|   ┌───────────────────────┼───────────────────────┬────────────────────┐           |
|   ▼                       ▼                       ▼                    ▼           |
| [Origin Proximity]   [Temporal Align]     [Trajectory Align]   [Kinematics]        |
|  d = dist to origin  dt = time difference  d_corr = min dist   Speed & Heading     |
|  Weight: 40%         Weight: 25%           to hindcast path    Weight: 7.5% + 7.5% |
|  exp(-d / 4 km)      exp(-dt / 2 h)        exp(-d_corr / 4 km) Consistency checks  |
|   │                       │                       │                    │           |
|   └───────────────────────┼───────────────────────┴────────────────────┘           |
|                           ▼                                                        |
|     Total Compatibility Score = 100 * Sum(Weight_i * Feature_i)                    |
|     [Score in 0 - 100]: Measures Kinematic Compatibility, NOT Legal Guilt          |
+------------------------------------------------------------------------------------+
```

### 8.1 AIS Data Cleaning & Normalization Contract
- Canonical Headers: `mmsi` (9-digit Maritime Mobile Service Identity), `timestamp` (UTC), `latitude`, `longitude`, `speed` (knots), `course` (degrees), `heading`.
- Validation Filters: Rejects non-9-digit MMSIs, coordinates outside $[-90, 90]$ and $[-180, 180]$, speeds $> 80\text{ knots}$, courses outside $[0, 360)$.
- Deduplication: Drops duplicate identical `(mmsi, timestamp)` fixes.

### 8.2 Spatiotemporal Search Bounds
- **Spatial Bounding Box:** Origin centroid $\pm 15\text{ km}$ latitude and longitude:
  $$\Delta\phi = \frac{15\text{ km}}{111.32\text{ km/deg}}, \quad \Delta\lambda = \frac{\Delta\phi}{\cos\phi_{\text{orig}}}$$
- **Temporal Release Window:** Center hindcast timestamp $\pm 1\text{ hour}$ (or expanded by the slick age uncertainty interval).

### 8.3 AIS Discontinuity / "Dark Vessel" Detection
Under IMO SOLAS Chapter V, Regulation 19, commercial vessels $\ge 300\text{ GT}$ are legally required to maintain operational AIS at all times.
- **Gap Threshold:** When consecutive fixes for a vessel exhibit a time gap $\Delta t > 1\text{ hour}$ within the search region, an **AIS Discontinuity Anomaly** is flagged.
- **Corridor Hypothesis:** A linear trajectory hypothesis is drawn between the pre-gap fix $A$ and post-gap fix $B$. The anomaly relevance score is:
  $$\text{Relevance} = \max\left(0, 1 - \frac{\min(\text{dist}(A), \text{dist}(B))}{15\text{ km}}\right)$$
- **Forensic Principle:** *An AIS gap does not legally prove intentional tampering (gaps can result from satellite shadow, VHF atmospheric fading, or transponder power glitches). Therefore, AIS gaps reduce evidence confidence rather than directly inflating guilt.*

### 8.4 The 5-Feature Attribution Scoring Matrix
For every candidate vessel entering the search window, a composite compatibility score $S \in [0, 100]$ is computed:
$$S = 100 \times \left( 0.40 F_{\text{dist}} + 0.25 F_{\text{time}} + 0.20 F_{\text{traj}} + 0.075 F_{\text{speed}} + 0.075 F_{\text{heading}} \right)$$

1. **Origin Proximity ($F_{\text{dist}}$, Weight: $40\%$):**
   $$F_{\text{dist}} = \exp\left(-\frac{d_{\text{min}}}{4.0\text{ km}}\right)$$
   *Where $d_{\text{min}}$ is the minimum Haversine distance from any vessel fix to the modeled origin centroid. A vessel directly on the origin receives $1.0$; at $4\text{ km}$ it drops to $0.37$; beyond $12\text{ km}$ it approaches $0.05$.*

2. **Temporal Alignment ($F_{\text{time}}$, Weight: $25\%$):**
   $$F_{\text{time}} = \exp\left(-\frac{|\Delta t|}{2.0\text{ hours}}\right)$$
   *Where $|\Delta t|$ is the absolute time difference between the closest vessel fix and the central modeled release timestamp.*

3. **Trajectory Corridor Alignment ($F_{\text{traj}}$, Weight: $20\%$):**
   $$F_{\text{traj}} = \exp\left(-\frac{d_{\text{corridor}}}{4.0\text{ km}}\right)$$
   *Where $d_{\text{corridor}}$ is the minimum distance between the vessel's track and any point along the historical backward hindcast trajectory path. Accounts for continuous discharges while cruising.*

4. **Speed Kinematic Plausibility ($F_{\text{speed}}$, Weight: $7.5\%$):**
   $$F_{\text{speed}} = \exp\left(-\frac{\overline{|\Delta v_{\text{speed}}|}}{3.0\text{ knots}}\right)$$
   *Where $\Delta v_{\text{speed}}$ compares the vessel's self-reported AIS Speed Over Ground (SOG) against the inferred Haversine displacement speed between consecutive fixes: $v_{\text{inferred}} = \frac{\text{Haversine}(p_1, p_2)}{\Delta t}$. Significant discrepancies flag spoofed or erratic AIS reports.*

5. **Heading Kinematic Consistency ($F_{\text{heading}}$, Weight: $7.5\%$):**
   $$F_{\text{heading}} = \max\left(0, 1 - \frac{\overline{|\Delta \theta_{\text{course}}|}}{90^\circ}\right)$$
   *Where $\Delta \theta$ is the angular discrepancy between reported Course Over Ground (COG) and the forward azimuth bearing between fixes.*

---

## Segment 9: System Architecture, Database & Security Guards

### 9.1 Multi-Tier Microservices Topology
- **API Orchestration Layer:** Node.js (v22.12+) Express server. Handles request admission, CORS, rate limiting, and child-process lifecycle.
- **Scientific Computing Layer:** Dedicated Python 3.10+ sub-engines. Decoupled via strictly typed JSON pipes over standard I/O (`stdin`/`stdout`).
- **Data Persistence Tier:**
  - Primary Read Store: Atomic local JSON archive (`backend/data/incidents/`).
  - Transactional Spatial Mirror: PostgreSQL with PostGIS extensions.
- **Presentation Tier:** React 19 + TypeScript (Vite). Native SVG map visualizer requiring no external map tile subscriptions (fully air-gapped capable).

### 9.2 PostGIS Database Schema (Migrations 002 & 003)
The database schema (`osis_incidents`) treats incident reports as immutable JSONB documents paired with first-class spatial geometry:

```sql
CREATE TABLE osis_incidents (
    id UUID PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL,
    image_at TIMESTAMPTZ,                -- Nullable for no-spill/inconclusive runs
    spill_geom geometry(Polygon, 4326),  -- Nullable
    origin_geom geometry(Point, 4326),   -- Nullable
    report JSONB NOT NULL
);

-- Spatial GiST indexes for millisecond geospatial intersection queries
CREATE INDEX osis_incidents_spill_gist ON osis_incidents USING gist(spill_geom);
CREATE INDEX osis_incidents_origin_gist ON osis_incidents USING gist(origin_geom);

-- Outcome validation constraint (Migration 003)
ALTER TABLE osis_incidents ADD CONSTRAINT osis_incidents_outcome_check CHECK (
    (report->>'outcome' IN ('SPILL_DETECTED', 'NO_SPILL_DETECTED', 'ANALYSIS_INCONCLUSIVE'))
    OR (NOT report ? 'outcome' AND report->>'status' = 'completed')
);
```

#### Normalized Relational Views:
1. `osis_spills`: Unpacks `spill_geom`, PostGIS centroid `ST_Centroid(spill_geom)`, and metric characterization.
2. `osis_origins`: Exposes modeled origin Point and backward trajectory.
3. `osis_drift`: Unpacks forward prediction trajectory points via `jsonb_array_elements`.
4. `osis_candidates` & `osis_candidate_compatibility`: Unrolls candidate vessel MMSIs, names, compatibility scores, and feature breakdowns.
5. `osis_ais_positions`: Reconstructs vessel tracks as PostGIS geometries `ST_SetSRID(ST_MakePoint(lon, lat), 4326)`.
6. `osis_ais_anomalies`: Unrolls AIS discontinuity events.

### 9.3 Laptop Safety & Resource Bounding Guards
To ensure rock-solid stability during live hackathon demos on single-machine environments:
1. **Concurrency Ceiling:** Hard maximum of **2 concurrent Python analyses** (`OSIS_MAX_ANALYSES = 2`). Excess requests receive HTTP 429.
2. **Admission Rate Limit:** Hard maximum of 20 requests/minute.
3. **Execution Timeouts:** 35-second hard timeout for SAR child processes; 60-second total pipeline timeout.
4. **Memory/Payload Ceilings:** 8 MiB max per upload/download file; 128 MiB max decoded NetCDF component; 20,000 rows max AIS CSV.
5. **No Automatic Retries:** Prevents retry-storms if remote CDSE services are unreachable.
6. **Graceful Degradation:** If PostgreSQL is down, the system transparently persists to local JSON archives and reports `unavailable_local_fallback`.

---

## Segment 10: Technical Cross-Questioning Defense Guide

This section equips your team to confidently answer aggressive technical questions from jury members, radar scientists, machine learning researchers, and software architects.

---

### Category A: Radar Physics & Remote Sensing

#### Q1: "How do you prove that a dark formation on SAR is actual petroleum oil and not a biogenic slick or a low-wind area?"
**Defense:**
> "That is the classical look-alike challenge in radar oceanography. Low wind ($< 3\text{ m/s}$) allows the sea to flatten, and natural biogenic films secreted by plankton or fish damp capillary waves just like oil. OSIS tackles this through three distinct physical and computational layers:
> 1. **Cross-Polarization Analysis:** Biogenic films are monomolecular (one molecule thick) and primarily affect short capillary waves, whereas mineral oil slicks have viscoelastic bulk thickness and damp both capillary and short gravity waves. This produces higher damping in VV and distinct polarization differences $(\text{Damping}_{\text{VV}} - \text{Damping}_{\text{VH}})$.
> 2. **Boundary Gradient Steepness:** Mineral oil has high surface tension gradients, creating sharp, steep Sobel edge gradients ($\ge 5\text{ dB/px}$), whereas low-wind zones feather out into gradual, diffuse gradients.
> 3. **The POSEatSea Neural Classifier:** Our deep learning model is explicitly trained on 5 classes, including a dedicated 'Look-alike' class. Furthermore, in our Evidence Fusion layer, Rule 4 severely penalizes open-water candidates that lack deep learning confirmation, applying an 80% score suppression."

#### Q2: "Why do you use C-band SAR rather than X-band (TerraSAR-X) or L-band (ALOS PALSAR)?"
**Defense:**
> "C-band ($\lambda \approx 5.6\text{ cm}$) is the international operational standard for maritime surveillance because of the Sentinel-1 constellation's open-access, systematic 6-to-12-day revisit rate and wide $250\text{ km}$ swath (Interferometric Wide mode).
> While X-band ($\approx 3.1\text{ cm}$) offers higher spatial resolution, its coverage swaths are smaller and it suffers from atmospheric rain attenuation. L-band ($\approx 23.6\text{ cm}$) has too long a wavelength; it interacts with longer gravity waves that require thicker, heavy emulsions to damp. C-band Bragg resonance occurs at $\approx 4.8\text{ cm}$ waves, which are instantly damped by both sheen and crude oil, making it optimal for detection."

#### Q3: "What are the wind speed operating limits for your SAR spill detection?"
**Defense:**
> "SAR oil spill detection is physically bounded by surface wind speeds between **$2-3\text{ m/s}$ (lower bound)** and **$12-14\text{ m/s}$ (upper bound)**:
> - Below $2\text{ m/s}$, calm sea produces zero Bragg scattering everywhere; the entire ocean appears black, making slicks indistinguishable from clean water.
> - Above $12-14\text{ m/s}$, intense wave breaking and turbulent mixing tear the oil film apart, mixing droplets into the water column and regenerating surface roughness, masking the slick.
> OSIS directly checks ambient wind from ERA5 reanalysis before evaluating detection reliability."

---

### Category B: Machine Learning & Evidence Fusion

#### Q4: "Why did you choose a U-Net with a Mix-Transformer (MiT-B2) encoder instead of standard CNNs like ResNet-50 or YOLOv8?"
**Defense:**
> "Standard object detectors like YOLO generate axis-aligned bounding boxes, which are inadequate for oil slicks because slicks are irregular, fragmented, non-convex fluid shapes requiring pixel-level semantic segmentation.
> Between CNNs and Transformers: Standard CNNs (ResNet) rely on localized convolution kernels with limited receptive fields, making it difficult to capture long-range contextual dependencies. The MiT-B2 encoder uses hierarchical self-attention. It observes both fine boundary details (at $1/4$ resolution) and vast contextual relationships (at $1/32$ resolution), enabling the network to realize that a dark patch is aligned with a shipping corridor or situated along an island lee."

#### Q5: "If POSEatSea is so good, why do you need the Classical V2 algorithm at all?"
**Defense:**
> "Relying purely on a neural network is dangerous in operational maritime domains for two reasons:
> 1. **Domain Shift & Coastal Hallucinations:** Deep learning models trained on open-water imagery frequently misclassify coastal slicks as 'land' or 'look-alikes' due to sediment runoff and bathymetry. Our Classical V2 detector preserves genuine coastal slicks through physical damping metrics.
> 2. **Interpretability & Legal Accountability:** A neural network's softmax output is a black-box probability. The Classical detector extracts 17 verifiable physical measurements (decibel damping, elongation, Sobel edge sharpness). In court or regulatory proceedings, physical decibel contrast is legally admissible evidence; a deep learning prediction alone is not."

#### Q6: "How do your 4 Evidence Fusion rules prevent false alarms near the shoreline?"
**Defense:**
> "Shorelines are notorious for false alarms due to tidal mudflats, wind shadowing behind coastal cliffs, and sandbars. We protect against this with a two-tier rule:
> - **Rule 1 (Land Artifact Filter):** If a candidate overlaps by $> 40\%$ with the classified Land mask, it is immediately discarded ($S_{\text{fused}} = 0.0$).
> - **Rule 2 (Dynamic Coastal Preservation):** If the candidate is legitimate water within $1\text{ km}$ of the shore, we dampen the neural network's look-alike penalty and blend the classical physical score. This prevents the system from blindly discarding real slicks threatening beaches or ports."

---

### Category C: Oceanography & Lagrangian Drift Modeling

#### Q7: "Why do you use a leeway factor of 0.03? Isn't oil drift governed purely by surface currents?"
**Defense:**
> "No. A common misconception is that oil drifts solely with ocean currents. Floating oil sits directly at the air-sea interface.
> Extensive empirical studies (ASMB, IMO, and NOAA Hazmat standards) demonstrate that oil moves via a combination of surface currents and direct wind forcing. The 3% leeway factor ($\alpha = 0.03$) represents the downwind drift component. Physically, it accounts for:
> 1. Form drag of wind pushing against surface oil lens thickness.
> 2. Surface wave Stokes drift (the net mass transport of water in the direction of wave propagation), which is typically $1.5\% - 2.0\%$ of wind speed.
> Adding $\vec{V}_{\text{current}} + 0.03 \vec{V}_{\text{wind}}$ is the accepted global standard in operational search-and-rescue and oil spill trajectory modeling."

#### Q8: "Why did you implement Runge-Kutta 4th Order (RK4) instead of a simple forward/backward Euler method?"
**Defense:**
> "Euler integration computes next positions linearly: $x_{t+\Delta t} = x_t + v(x_t) \cdot \Delta t$. Its local truncation error is $O(\Delta t^2)$ and global error is $O(\Delta t)$. In rotational current fields like coastal eddies or tidal gyres, Euler integration introduces artificial outward numerical dispersion, causing simulated particles to spiral away from reality.
> RK4 samples four velocity vectors across each 1-hour step ($k_1$ at the start, $k_2$ and $k_3$ at midpoints, and $k_4$ at the end). Its global error is $O(\Delta t^4)$. This ensures that particle trajectories remain stable, conserving vorticity and trajectory geometry even across 48-hour backward hindcasts."

#### Q9: "Where does the factor 5.991 come from in your uncertainty ellipse calculation?"
**Defense:**
> "The 5.991 constant is mathematically derived from the Chi-Square distribution ($\chi^2$).
> The spatial distribution of our 50 Monte Carlo particles in the local metric plane is modeled as a bivariate normal distribution $(X, Y) \sim \mathcal{N}_2(\boldsymbol{\mu}, \mathbf{\Sigma})$.
> The squared Mahalanobis distance $(\mathbf{x} - \boldsymbol{\mu})^T \mathbf{\Sigma}^{-1} (\mathbf{x} - \boldsymbol{\mu})$ follows a $\chi^2$ distribution with $k = 2$ degrees of freedom.
> The cumulative distribution function for $k = 2$ is:
> $$F(x) = 1 - e^{-x/2}$$
> To establish a **95% confidence region** ($F(x) = 0.95$):
> $$1 - e^{-x/2} = 0.95 \implies e^{-x/2} = 0.05 \implies -\frac{x}{2} = \ln(0.05) \implies x = -2 \ln(0.05) \approx \mathbf{5.99146}$$
> Multiplying the eigenvalues of the sample covariance matrix by $5.991$ gives the exact semi-major and semi-minor axes of the 95% probability contour."

#### Q10: "Why does OSIS report slick release age as `null` in REAL mode?"
**Defense:**
> "This is a deliberate, scientifically honest design decision. A single satellite SAR image provides an instantaneous snapshot in time.
> While slick morphology and elongation give clues about continuous discharge, **one static image cannot physically date the release time without an unverified assumption about oil evaporation and spreading rates**.
> In our DEMO pipeline, we demonstrate age estimation using a synthetic multi-pass interval ($T_{\text{clear}}$ vs. $T_{\text{detected}}$). But in REAL mode, asserting a specific release hour from one SAR image would be scientifically fraudulent and legally indefensible. Instead, we allow the analyst to run bounded hindcast scenarios (e.g., 6h, 12h, 24h) and explicitly report release age as `null`."

---

### Category D: AIS & Vessel Attribution

#### Q11: "If a vessel turns off its AIS transponder to hide an illegal discharge, how can OSIS detect it?"
**Defense:**
> "This is the 'dark vessel' problem. OSIS detects this through **AIS Discontinuity Correlation**:
> 1. We scan all historical tracks within our spatiotemporal search corridor.
> 2. If a vessel transmits regularly, then goes dark for $> 1\text{ hour}$ exactly when crossing the modeled spill origin window, and resumes broadcasting on the other side, OSIS flags an **AIS Discontinuity Anomaly**.
> 3. We draw a linear gap corridor hypothesis between the last fix before transmission ceased and the first fix after it resumed.
> However, we maintain legal objectivity: an AIS gap alone is not proof of illegal dumping, as AIS signals can be blocked by terrain or satellite blind spots. It is flagged as high-priority circumstantial evidence for coast guard patrol inspection."

#### Q12: "How did you determine the weights in your Vessel Attribution Formula (40% Origin, 25% Time, 20% Trajectory, 7.5% Speed, 7.5% Heading)?"
**Defense:**
> "The weights reflect physical causality in forensic collision and discharge reconstruction:
> - **Spatial Origin Proximity (40%) & Temporal Alignment (25%):** Spatiotemporal co-location dominates. A ship cannot discharge a spill if it was not physically present at the discharge origin during the release window. These two factors constitute 65% of the score.
> - **Trajectory Corridor Alignment (20%):** Operational bilge dumping is almost always executed while underway at sea over a prolonged heading. If the vessel's track mirrors the backward hindcast path, compatibility increases.
> - **Speed & Heading Consistency (15% total):** These are kinematic sanity checks. They verify that the vessel's self-reported AIS telemetry matches physical displacement, penalizing GPS spoofing or corrupted AIS records."

---

### Category E: System Engineering & Production Architecture

#### Q13: "Why did you use a hybrid Node.js + Python architecture instead of building everything in pure Python (FastAPI)?"
**Defense:**
> "This separation follows the **Asynchronous I/O vs. Synchronous Compute separation pattern**:
> 1. **Node.js:** Excellent for high-concurrency, non-blocking I/O, managing WebSocket connections, streaming raw binary GeoTIFF uploads, enforcing atomic JSON file writes, and communicating with PostgreSQL/PostGIS.
> 2. **Python:** Dedicated to vectorized matrix math, raster processing, and PyTorch inference.
> By keeping Python isolated in bounded subprocesses, an out-of-memory error or PyTorch crash in a Python script **never brings down the API server or drops client connections**. The Node.js parent traps errors and immediately returns a clean, structured `ANALYSIS_INCONCLUSIVE` response."

#### Q14: "How does OSIS prevent Denial-of-Service (DoS) and memory exhaustion when large GeoTIFFs or NetCDF files are processed?"
**Defense:**
> "We enforce multi-tiered resource guards:
> - **Upload Limits:** Hard cap of $8\text{ MiB}$ per GeoTIFF polarization file. Max AOI bounding box is $0.2^\circ$ ($512 \times 512$ pixels).
> - **Subprocess Timeouts:** Python SAR processes are killed after 35 seconds; overall pipelines after 60 seconds.
> - **Memory Ceilings:** Environmental NetCDF components are capped at $128\text{ MiB}$; historical AIS CSVs are capped at $8\text{ MiB}$ or 20,000 rows.
> - **Concurrency Throttling:** Maximum of 2 concurrent Python analysis jobs. If a 3rd arrives, it receives an instant HTTP 429."

#### Q15: "What is your disaster recovery and fallback plan if the PostgreSQL database crashes?"
**Defense:**
> "OSIS uses a **File-First Local JSON Archive as the Primary Read Store**.
> Every completed analysis is atomically written to an immutable JSON report file in `backend/data/incidents/`.
> PostgreSQL with PostGIS serves as a synchronized mirror for spatial indexing. If the database goes offline, the Node.js backend detects the outage, flags `unavailable_local_fallback`, and continues serving reports, searches, and visualizations seamlessly from the local JSON store."

---

## Technical Cross-Questioning Quick Reference Matrix

| Domain | Parameter / Feature | Value | Mathematical / Physical Basis |
| :--- | :--- | :--- | :--- |
| **Radar** | Sensor Frequency | $5.405\text{ GHz}$ (C-Band) | $\lambda \approx 5.6\text{ cm}$; optimum Bragg resonance ($\approx 4.8\text{ cm}$ waves) |
| **Radar** | Polarization | VV + VH Dual-Pol | VV provides max oil damping contrast; VH identifies ships/metallic structures |
| **Classical** | Window Radius ($R$) | $25\text{ pixels}$ ($51 \times 51$ box) | Captures local sea clutter without being corrupted by the slick itself |
| **Classical** | k-Sigma Factor | $k = 2.0$ | Thresholds pixels $\ge 2$ standard deviations below local ocean clutter |
| **Classical** | Minimum Damping | $3.5\text{ dB}$ | Physical floor to reject natural wave modulation |
| **Classical** | Closing Kernel | $3 \times 3$ Rectangular | Bridges speckle gaps without expanding slick boundaries |
| **DL Model** | Backbone | U-Net + MiT-B2 | Hierarchical Mix-Transformer capturing multi-scale context |
| **DL Model** | Classes | 5 Classes | Sea, Oil Spill, Look-alike, Ship, Land |
| **Fusion** | Land Overlap Gate | $> 40\%$ Overlap | Discards coastal false alarms, mudflats, and sandbars |
| **Fusion** | Coastal Radius | $60\text{ px} \approx 1\text{ km}$ | Suppresses DL look-alike penalty to preserve genuine nearshore slicks |
| **Drift** | Leeway Factor | $\alpha = 0.03$ (3%) | IMO/ASMB standard accounting for surface wind drag and wave Stokes drift |
| **Drift** | Numerical Scheme | Runge-Kutta 4th Order | Truncation error $O(\Delta t^5)$; prevents numerical eddy dispersion |
| **Drift** | Ensemble Size | $N = 50$ Particles | Monte Carlo simulation with stochastic turbulent diffusion ($\sigma = 80\text{ m/h}$) |
| **Drift** | Uncertainty Factor | $\mathbf{5.991}$ | Critical value of $\chi^2_2$ distribution at $95\%$ confidence interval |
| **AIS** | Search Buffer | $\pm 15\text{ km}, \pm 1\text{ hr}$ | Accounts for current/wind variability around modeled origin |
| **Attribution**| Scoring Weights | 40% Dist, 25% Time, 20% Traj, 7.5% Speed, 7.5% Heading | Spatiotemporal proximity dominates; kinematics verify integrity |
| **Attribution**| AIS Discontinuity | Gaps $> 1\text{ hour}$ | Detects transponder deactivation; reduces confidence rather than proving guilt |
| **System** | Concurrency Limit | 2 Python processes | Hard limit to guarantee single-machine stability during live operations |
