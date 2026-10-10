import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Radar, Navigation, Ship, Target } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      {
        title: "O.S.I.S. — Oil Spill Identification & Source Attribution System",
      },
      {
        name: "description",
        content:
          "Satellite SAR oil spill detection with hydrodynamic Lagrangian drift backtracking and AIS vessel attribution for maritime intelligence.",
      },
    ],
  }),
  component: LandingPage,
});

/* ── Pipeline steps for the four-step section ── */
const PIPELINE = [
  {
    num: "01",
    title: "DETECTION",
    desc: "Sentinel-1 SAR identifies anomalous surface signatures consistent with hydrocarbon slicks through deep-learning segmentation.",
    accent: "var(--accent-blue)",
    icon: Radar,
  },
  {
    num: "02",
    title: "DRIFT BACKTRACKING",
    desc: "Ocean-current and wind modelling via Lagrangian advection estimates where the spill originated hours before detection.",
    accent: "var(--accent-amber)",
    icon: Navigation,
  },
  {
    num: "03",
    title: "AIS CORRELATION",
    desc: "Vessel tracks are evaluated against the computed release corridor to identify ships present during the estimated discharge window.",
    accent: "var(--accent-emerald)",
    icon: Ship,
  },
  {
    num: "04",
    title: "SOURCE ATTRIBUTION",
    desc: "Evidence is combined into an explainable investigation dossier ranking candidate vessels by multi-factor proximity scoring.",
    accent: "var(--accent-rose)",
    icon: Target,
  },
] as const;

function LandingPage() {
  return (
    <div
      style={{
        /* full-bleed — override the root layout padding */
        margin: "0 -20px",
        width: "calc(100% + 40px)",
      }}
    >
      {/* ════════════════════════════════════════════════════════════
          CINEMATIC MARITIME BACKGROUND OVERLAY
         ════════════════════════════════════════════════════════════ */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: -1,
          pointerEvents: 'none',
          overflow: 'hidden',
          backgroundColor: '#02070E',
        }}
      >
        {/* Layer 1: Cinematic Ocean & Distant Tanker Environment Image */}
        <img
          src="/images/ocean-tanker-bg.jpg"
          alt=""
          aria-hidden="true"
          className="landing-bg-img"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: '52% 24%',
            filter: 'contrast(1.08) brightness(0.96) saturate(1.06)',
          }}
        />

        {/* Layer 2: Deep Blue Atmospheric Maritime Color Grading */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(180deg, rgba(3, 14, 24, 0.22) 0%, rgba(2, 9, 18, 0.12) 42%, rgba(2, 8, 15, 0.52) 100%)',
            mixBlendMode: 'multiply',
          }}
        />

        {/* Layer 3: Ambient Oceanic Depth Tint */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 110% 85% at 55% 25%, rgba(6, 36, 58, 0.15) 0%, rgba(3, 17, 28, 0.32) 55%, rgba(2, 7, 14, 0.65) 100%)',
          }}
        />

        {/* Layer 4: Left-Side Dark Gradient for Hero Typography Readability (Ocean visible beneath) */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(90deg, rgba(3, 8, 15, 0.76) 0%, rgba(3, 8, 15, 0.58) 35%, rgba(3, 8, 15, 0.2) 60%, transparent 80%)',
          }}
        />

        {/* Layer 5: SAR Visualization Panel Integration Darkening */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 70% 55% at 78% 46%, rgba(3, 14, 24, 0.28) 0%, transparent 75%)',
          }}
        />

        {/* Layer 6: Subtle Secondary SVG Bathymetric / Current Overlays (Framing Flanks) */}
        <svg
          className="landing-currents-svg"
          viewBox="0 0 3200 1100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '200%',
            height: '100%',
            opacity: 0.55,
            maskImage:
              'radial-gradient(ellipse 65% 65% at 50% 42%, transparent 20%, rgba(0,0,0,0.45) 55%, black 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 65% 65% at 50% 42%, transparent 20%, rgba(0,0,0,0.45) 55%, black 100%)',
          }}
        >
          <defs>
            {/* Faint cyan current highlight gradient */}
            <linearGradient id="osis-cyan-current-1" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#19B5E6" stopOpacity="0.04" />
              <stop offset="28%" stopColor="#19B5E6" stopOpacity="0.13" />
              <stop offset="65%" stopColor="#19B5E6" stopOpacity="0.06" />
              <stop offset="100%" stopColor="#19B5E6" stopOpacity="0.04" />
            </linearGradient>

            {/* Secondary cyan/teal current filament */}
            <linearGradient id="osis-cyan-current-2" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#19B5E6" stopOpacity="0.03" />
              <stop offset="45%" stopColor="#19B5E6" stopOpacity="0.11" />
              <stop offset="78%" stopColor="#2ECF8B" stopOpacity="0.07" />
              <stop offset="100%" stopColor="#19B5E6" stopOpacity="0.03" />
            </linearGradient>

            {/* Bathymetric contour gradient */}
            <linearGradient id="osis-contour-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#173B56" stopOpacity="0.18" />
              <stop offset="50%" stopColor="#225479" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#173B56" stopOpacity="0.18" />
            </linearGradient>

            {/* Seamless 1600px ocean current unit */}
            <g id="ocean-currents-tile">
              {/* Path 1: Upper Horizon Marine Swell — broad, gentle */}
              <path
                d="M0,65 C140,53 320,85 520,70 C720,55 940,95 1160,80 C1340,65 1460,77 1600,65"
                stroke="rgba(24,56,80,0.3)"
                strokeWidth="0.75"
              />

              {/* Path 2: Secondary Upper Current */}
              <path
                d="M0,140 C160,160 380,110 600,125 C820,140 1060,185 1280,165 C1420,150 1440,120 1600,140"
                stroke="rgba(20,50,74,0.25)"
                strokeWidth="0.9"
              />

              {/* Path 3: Sub-surface Bathymetric Contour */}
              <path
                d="M0,225 C150,200 360,255 580,240 C800,225 1040,180 1260,205 C1410,220 1450,250 1600,225"
                stroke="url(#osis-contour-grad)"
                strokeWidth="0.8"
              />

              {/* Path 4: Open Ocean Meander */}
              <path
                d="M0,310 C170,340 390,280 620,300 C850,320 1080,365 1300,340 C1430,325 1430,280 1600,310"
                stroke="rgba(28,66,94,0.32)"
                strokeWidth="1.1"
              />

              {/* Path 5: Primary Current Jet — with faint Cyan luminescence */}
              <path
                d="M0,395 C180,373 400,430 630,410 C860,390 1100,455 1320,430 C1440,415 1420,417 1600,395"
                stroke="url(#osis-cyan-current-1)"
                strokeWidth="1.4"
              />

              {/* Path 6: Companion Current Filament (faint cyan) */}
              <path
                d="M0,425 C170,405 390,460 620,440 C850,420 1090,485 1310,460 C1430,445 1430,445 1600,425"
                stroke="rgba(25,181,230,0.06)"
                strokeWidth="0.8"
              />

              {/* Path 7: Deep Pelagic Contour */}
              <path
                d="M0,515 C160,543 380,480 600,500 C820,520 1060,570 1280,545 C1420,530 1440,487 1600,515"
                stroke="rgba(22,58,84,0.28)"
                strokeWidth="1.0"
              />

              {/* Path 8: Sub-Surface Hydrodynamic Jet (faint cyan/emerald) */}
              <path
                d="M0,610 C190,578 410,650 640,625 C870,600 1110,675 1330,645 C1440,630 1410,642 1600,610"
                stroke="url(#osis-cyan-current-2)"
                strokeWidth="1.3"
              />

              {/* Path 9: Tactical Drift Vector Stream (dashed) */}
              <path
                d="M0,635 C180,607 400,675 630,650 C860,625 1100,700 1320,670 C1440,655 1420,663 1600,635"
                stroke="rgba(25,181,230,0.08)"
                strokeWidth="0.85"
                strokeDasharray="8 10"
              />

              {/* Path 10: Mid-Abyssal Shelf Line */}
              <path
                d="M0,725 C150,749 370,695 590,715 C810,735 1050,780 1270,755 C1410,740 1450,701 1600,725"
                stroke="url(#osis-contour-grad)"
                strokeWidth="1.0"
              />

              {/* Path 11: Deep Under-Trench Stream (faint cyan highlight) */}
              <path
                d="M0,820 C175,794 395,860 625,835 C855,810 1095,880 1315,850 C1435,835 1425,846 1600,820"
                stroke="rgba(25,181,230,0.07)"
                strokeWidth="1.1"
              />

              {/* Path 12: Lower Bathymetric Step */}
              <path
                d="M0,915 C160,935 380,885 600,905 C820,925 1060,970 1280,945 C1420,930 1440,895 1600,915"
                stroke="rgba(18,48,70,0.22)"
                strokeWidth="0.8"
              />

              {/* Path 13: Abyssal Floor Boundary */}
              <path
                d="M0,1005 C180,987 400,1040 630,1020 C860,1000 1100,1060 1320,1035 C1440,1020 1420,1023 1600,1005"
                stroke="rgba(15,40,60,0.18)"
                strokeWidth="0.7"
              />

              {/* Organic Ocean Gyre Swirls & Regional Boundary Currents (Negative space / Right-side) */}
              <path
                d="M 860,160 C 1040,110 1260,150 1420,250 C 1530,320 1580,440 1510,530 C 1430,620 1290,640 1180,590 C 1080,540 1060,430 1140,360 C 1210,300 1330,310 1400,370"
                stroke="rgba(25,181,230,0.05)"
                strokeWidth="0.9"
              />
              <path
                d="M 940,710 C 1080,660 1260,690 1390,770 C 1490,835 1530,925 1460,990"
                stroke="rgba(25,181,230,0.055)"
                strokeWidth="0.85"
                strokeDasharray="6 8"
              />
              <path
                d="M 520,35 C 700,95 940,65 1170,135 C 1370,195 1510,155 1600,185"
                stroke="rgba(24,60,88,0.22)"
                strokeWidth="0.75"
              />
            </g>
          </defs>

          {/* First tile (0 to 1600) */}
          <use href="#ocean-currents-tile" x="0" y="0" />
          {/* Second tile (1600 to 3200) — guaranteed seamless loop */}
          <use href="#ocean-currents-tile" x="1600" y="0" />
        </svg>

        {/* Layer 7: Atmospheric perimeter vignette & bottom section grounding */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 95% 85% at 50% 50%, transparent 55%, rgba(2, 6, 12, 0.35) 80%, rgba(1, 4, 8, 0.78) 100%), ' +
              'linear-gradient(180deg, transparent 65%, rgba(7, 11, 16, 0.45) 85%, rgba(7, 11, 16, 0.95) 100%)',
          }}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════
          HERO SECTION
         ════════════════════════════════════════════════════════════ */}
      <section
        style={{
          minHeight: "min(92vh, 860px)",
          display: "flex",
          alignItems: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Subtle radial vignette */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse 70% 60% at 70% 45%, rgba(25,181,230,0.04) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        <div
          style={{
            maxWidth: 1200,
            width: "100%",
            margin: "0 auto",
            padding: "80px 32px 64px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 64,
            alignItems: "center",
          }}
          className="landing-hero-grid"
        >
          {/* ── Left column: Text + CTAs ── */}
          <div style={{ maxWidth: 560 }}>
            {/* Eyebrow */}
            <div
              className="font-mono"
              style={{
                fontSize: 11,
                letterSpacing: "0.16em",
                color: "var(--primary)",
                marginBottom: 28,
                textTransform: "uppercase",
              }}
            >
              Maritime Intelligence · Oil Spill Response
            </div>

            {/* Headline */}
            <h1
              className="font-mono"
              style={{
                fontSize: "clamp(2.2rem, 5vw, 3.6rem)",
                fontWeight: 800,
                lineHeight: 1.08,
                color: "var(--foreground)",
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              DETECT.
              <br />
              TRACE.
              <br />
              ATTRIBUTE.
            </h1>

            {/* Sub-copy */}
            <p
              style={{
                fontSize: 15,
                lineHeight: 1.7,
                color: "var(--muted-foreground)",
                marginTop: 28,
                maxWidth: 480,
              }}
            >
              Satellite SAR, ocean-drift modelling and AIS vessel intelligence
              unified for oil-spill investigation.
            </p>

            {/* CTA row */}
            <div
              style={{
                display: "flex",
                gap: 14,
                marginTop: 40,
                flexWrap: "wrap",
              }}
            >
              <Link
                to="/overview"
                className="font-mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--primary)",
                  color: "var(--primary-foreground)",
                  padding: "13px 28px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textDecoration: "none",
                  transition: "opacity 0.15s",
                  border: "none",
                }}
                id="cta-explore"
              >
                EXPLORE O.S.I.S.
                <ArrowRight style={{ width: 15, height: 15 }} />
              </Link>

              <a
                href="#how-it-works"
                className="font-mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  color: "var(--foreground)",
                  padding: "13px 28px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textDecoration: "none",
                  border: "1px solid var(--border)",
                  transition: "border-color 0.15s, color 0.15s",
                }}
                id="cta-how"
              >
                HOW IT WORKS
              </a>
            </div>

            {/* Badge row */}
            <div
              className="font-mono"
              style={{
                display: "flex",
                gap: 20,
                marginTop: 48,
                fontSize: 10,
                letterSpacing: "0.1em",
                color: "var(--muted-foreground)",
                textTransform: "uppercase",
              }}
            >
              <span>SIH PS26143</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>Sentinel-1 SAR</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>INCOIS HyCOM</span>
            </div>
          </div>

          {/* ── Right column: O.S.I.S. Intelligence Visualization ── */}
          <div
            style={{
              position: "relative",
              width: "100%",
              aspectRatio: "1 / 0.9",
              borderRadius: 10,
              border: "1px solid rgba(25, 181, 230, 0.2)",
              background: "rgba(9, 15, 23, 0.72)",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              boxShadow: "0 12px 40px -10px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(25, 181, 230, 0.15)",
              overflow: "hidden",
            }}
            className="landing-hero-visual"
          >
            {/* Ocean grid background */}
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                backgroundImage:
                  "linear-gradient(to right, rgba(29,42,54,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(29,42,54,0.12) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
              }}
            />

            {/* SVG intelligence scene */}
            <svg
              viewBox="0 0 500 450"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
              }}
              aria-hidden="true"
            >
              <defs>
                {/* Spill fill gradient */}
                <radialGradient id="spillGrad" cx="0.5" cy="0.5" r="0.5">
                  <stop offset="0%" stopColor="#FF4D6D" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#FF4D6D" stopOpacity="0.06" />
                </radialGradient>
                {/* Origin uncertainty */}
                <radialGradient id="originGrad" cx="0.5" cy="0.5" r="0.5">
                  <stop offset="0%" stopColor="#F5B82E" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="#F5B82E" stopOpacity="0" />
                </radialGradient>
                {/* Pulse animation for spill */}
                <filter id="spillGlow">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
                </filter>
              </defs>

              {/* ── Coastline contour (top-right, subtle) ── */}
              <path
                d="M 500 0 L 500 85 Q 465 90, 440 105 Q 410 125, 395 115 Q 375 100, 360 110 Q 340 125, 330 118 Q 310 105, 295 115 Q 275 130, 260 125 L 260 0 Z"
                fill="#111A24"
                stroke="#1D2A36"
                strokeWidth="1"
                opacity="0.6"
              />
              {/* Coastline edge highlight */}
              <path
                d="M 500 85 Q 465 90, 440 105 Q 410 125, 395 115 Q 375 100, 360 110 Q 340 125, 330 118 Q 310 105, 295 115 Q 275 130, 260 125"
                fill="none"
                stroke="#1D2A36"
                strokeWidth="1.5"
                opacity="0.8"
              />

              {/* ── Lat/Lon reference lines ── */}
              <line x1="0" y1="200" x2="500" y2="200" stroke="#1D2A36" strokeWidth="0.5" strokeDasharray="4 8" opacity="0.4" />
              <line x1="250" y1="0" x2="250" y2="450" stroke="#1D2A36" strokeWidth="0.5" strokeDasharray="4 8" opacity="0.4" />

              {/* ════════════════════════════════════════
                  LAYER 1: VESSEL TRAJECTORIES (background)
                 ════════════════════════════════════════ */}

              {/* Vessel 1 trajectory: NW heading */}
              <polyline
                points="125,148 140,155 158,160 175,162 188,158"
                fill="none"
                stroke="#19B5E6"
                strokeWidth="0.8"
                strokeDasharray="3 4"
                opacity="0.25"
              />
              {/* Vessel 2 trajectory: ENE heading past spill */}
              <polyline
                points="80,235 110,228 145,220 180,215 210,218 240,225"
                fill="none"
                stroke="#19B5E6"
                strokeWidth="0.8"
                strokeDasharray="3 4"
                opacity="0.25"
              />
              {/* Vessel 3 trajectory: SE heading */}
              <polyline
                points="220,160 230,175 235,195 232,210"
                fill="none"
                stroke="#19B5E6"
                strokeWidth="0.8"
                strokeDasharray="3 4"
                opacity="0.2"
              />

              {/* ════════════════════════════════════════
                  LAYER 2: DRIFT TRAJECTORY (origin → spill)
                 ════════════════════════════════════════ */}

              {/* Backward drift path — curved, dashed */}
              <path
                d="M 195,210 Q 220,240 240,265 Q 265,295 280,320 Q 290,340 305,355"
                fill="none"
                stroke="#F5B82E"
                strokeWidth="1.8"
                strokeDasharray="6 5"
                opacity="0.7"
                className="landing-drift-path"
              />
              {/* Drift direction arrows along path */}
              <polygon points="260,282 265,275 270,283" fill="#F5B82E" opacity="0.45" />
              <polygon points="290,335 294,327 299,336" fill="#F5B82E" opacity="0.35" />

              {/* ════════════════════════════════════════
                  LAYER 3: ESTIMATED ORIGIN
                 ════════════════════════════════════════ */}

              {/* Origin uncertainty radius */}
              <circle cx="195" cy="210" r="28" fill="url(#originGrad)" />
              <circle cx="195" cy="210" r="28" fill="none" stroke="#F5B82E" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.4" />

              {/* Origin point */}
              <circle cx="195" cy="210" r="4" fill="#F5B82E" />
              <circle cx="195" cy="210" r="7" fill="none" stroke="#F5B82E" strokeWidth="1" opacity="0.5" />

              {/* ════════════════════════════════════════
                  LAYER 4: OIL SPILL DETECTION REGION
                 ════════════════════════════════════════ */}

              {/* Spill polygon — irregular shape */}
              <path
                d="M 290,340 Q 300,330 320,335 Q 340,340 350,355 Q 358,370 352,385 Q 342,400 325,405 Q 305,408 290,400 Q 275,390 272,375 Q 270,360 278,348 Z"
                fill="url(#spillGrad)"
                stroke="#FF4D6D"
                strokeWidth="1.5"
                opacity="0.85"
              />
              {/* Inner spill concentration */}
              <path
                d="M 305,355 Q 315,348 325,355 Q 335,365 330,378 Q 322,388 310,385 Q 298,380 300,368 Z"
                fill="#FF4D6D"
                fillOpacity="0.18"
                stroke="none"
              />
              {/* Spill pulse ring */}
              <circle cx="315" cy="370" r="18" fill="none" stroke="#FF4D6D" strokeWidth="0.8" opacity="0.35" className="landing-spill-pulse" />

              {/* ════════════════════════════════════════
                  LAYER 5: VESSEL MARKERS
                 ════════════════════════════════════════ */}

              {/* Vessel 1 — primary suspect, near origin */}
              <g>
                {/* Ship icon — small triangle */}
                <polygon points="188,158 184,165 192,165" fill="#19B5E6" opacity="0.85" />
                <circle cx="188" cy="161" r="8" fill="none" stroke="#19B5E6" strokeWidth="0.7" opacity="0.3" />
              </g>

              {/* Vessel 2 — secondary, passes nearby */}
              <g>
                <polygon points="240,225 236,232 244,232" fill="#19B5E6" opacity="0.6" />
                <circle cx="240" cy="228" r="7" fill="none" stroke="#19B5E6" strokeWidth="0.6" opacity="0.2" />
              </g>

              {/* Vessel 3 — further away, weaker signal */}
              <g>
                <polygon points="232,210 228,217 236,217" fill="#19B5E6" opacity="0.4" />
              </g>

              {/* ════════════════════════════════════════
                  LABELS (SVG text — positioned carefully)
                 ════════════════════════════════════════ */}

              {/* SAR DETECTION label — near spill */}
              <g>
                <rect x="340" y="343" width="86" height="18" rx="3" fill="#0A1018" fillOpacity="0.85" stroke="#FF4D6D" strokeWidth="0.6" opacity="0.8" />
                <text x="383" y="355" textAnchor="middle" fill="#FF4D6D" fontSize="8" fontFamily="ui-monospace, SFMono-Regular, monospace" letterSpacing="0.1em" opacity="0.9">
                  SAR DETECTION
                </text>
              </g>

              {/* EST. ORIGIN label */}
              <g>
                <rect x="130" y="188" width="54" height="16" rx="3" fill="#0A1018" fillOpacity="0.85" stroke="#F5B82E" strokeWidth="0.5" opacity="0.7" />
                <text x="157" y="199" textAnchor="middle" fill="#F5B82E" fontSize="7" fontFamily="ui-monospace, SFMono-Regular, monospace" letterSpacing="0.1em" opacity="0.85">
                  EST. ORIGIN
                </text>
              </g>

              {/* DRIFT BACKTRACK label — along path */}
              <g>
                <text x="228" y="290" fill="#F5B82E" fontSize="7" fontFamily="ui-monospace, SFMono-Regular, monospace" letterSpacing="0.08em" opacity="0.5" transform="rotate(-52, 228, 290)">
                  DRIFT BACKTRACK
                </text>
              </g>

              {/* AIS CORRELATION label — near vessels cluster */}
              <g>
                <rect x="100" y="135" width="80" height="16" rx="3" fill="#0A1018" fillOpacity="0.8" stroke="#19B5E6" strokeWidth="0.5" opacity="0.6" />
                <text x="140" y="146" textAnchor="middle" fill="#19B5E6" fontSize="7" fontFamily="ui-monospace, SFMono-Regular, monospace" letterSpacing="0.1em" opacity="0.7">
                  AIS CORRELATION
                </text>
              </g>

              {/* Vessel IDs */}
              <text x="197" y="155" fill="#19B5E6" fontSize="6.5" fontFamily="ui-monospace, SFMono-Regular, monospace" opacity="0.5">V-01</text>
              <text x="248" y="224" fill="#19B5E6" fontSize="6.5" fontFamily="ui-monospace, SFMono-Regular, monospace" opacity="0.4">V-02</text>
              <text x="240" y="209" fill="#19B5E6" fontSize="6.5" fontFamily="ui-monospace, SFMono-Regular, monospace" opacity="0.3">V-03</text>
            </svg>

            {/* ── Corner metadata overlays (HTML for crisp rendering) ── */}

            {/* Top-left: System label */}
            <span
              className="font-mono"
              style={{
                position: "absolute",
                top: 14,
                left: 14,
                fontSize: 9,
                color: "var(--muted-foreground)",
                letterSpacing: "0.12em",
                opacity: 0.55,
                textTransform: "uppercase",
              }}
            >
              Sentinel-1 SAR
            </span>

            {/* Top-right: Status indicator */}
            <span
              className="font-mono"
              style={{
                position: "absolute",
                top: 14,
                right: 14,
                fontSize: 9,
                letterSpacing: "0.1em",
                display: "flex",
                alignItems: "center",
                gap: 6,
                textTransform: "uppercase",
              }}
            >
              <span
                className="om-pulse-dot"
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "#2ECF8B",
                  display: "inline-block",
                }}
              />
              <span style={{ color: "#2ECF8B", opacity: 0.8 }}>Analysis Active</span>
            </span>

            {/* Bottom-left: Coordinates */}
            <span
              className="font-mono"
              style={{
                position: "absolute",
                bottom: 12,
                left: 14,
                fontSize: 9,
                color: "var(--muted-foreground)",
                letterSpacing: "0.06em",
                opacity: 0.5,
              }}
            >
              15.25°N &nbsp;72.45°E
            </span>

            {/* Bottom-right: Sector label */}
            <span
              className="font-mono"
              style={{
                position: "absolute",
                bottom: 12,
                right: 14,
                fontSize: 9,
                color: "var(--muted-foreground)",
                letterSpacing: "0.08em",
                opacity: 0.45,
                textTransform: "uppercase",
              }}
            >
              Arabian Sea Sector
            </span>
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════════
          HOW IT WORKS — Four-Step Pipeline
         ════════════════════════════════════════════════════════════ */}
      <section
        id="how-it-works"
        style={{
          borderTop: "1px solid var(--border)",
          padding: "80px 32px",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          {/* Section header */}
          <div style={{ marginBottom: 56, maxWidth: 520 }}>
            <div
              className="font-mono"
              style={{
                fontSize: 11,
                letterSpacing: "0.16em",
                color: "var(--primary)",
                marginBottom: 16,
                textTransform: "uppercase",
              }}
            >
              How It Works
            </div>
            <h2
              style={{
                fontSize: "clamp(1.4rem, 3vw, 2rem)",
                fontWeight: 700,
                color: "var(--foreground)",
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              End-to-End Oil Spill Intelligence Pipeline
            </h2>
            <p
              style={{
                fontSize: 14,
                lineHeight: 1.7,
                color: "var(--muted-foreground)",
                marginTop: 16,
              }}
            >
              From satellite acquisition to actionable attribution — four
              autonomous stages, one unified report.
            </p>
          </div>

          {/* Pipeline grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 20,
            }}
            className="landing-pipeline-grid"
          >
            {PIPELINE.map((step) => {
              const Icon = step.icon;
              return (
                <div
                  key={step.num}
                  style={{
                    padding: "28px 28px 28px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    borderTop: `2px solid ${step.accent}`,
                    background: "var(--card)",
                    position: "relative",
                    transition: "border-color 0.2s",
                  }}
                  className="landing-pipeline-card"
                >
                  {/* Step number */}
                  <div
                    className="font-mono"
                    style={{
                      fontSize: 32,
                      fontWeight: 800,
                      color: step.accent,
                      opacity: 0.12,
                      position: "absolute",
                      top: 18,
                      right: 20,
                      lineHeight: 1,
                    }}
                  >
                    {step.num}
                  </div>

                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: `color-mix(in srgb, ${step.accent} 10%, transparent)`,
                      marginBottom: 20,
                    }}
                  >
                    <Icon
                      style={{
                        width: 20,
                        height: 20,
                        color: step.accent,
                      }}
                    />
                  </div>

                  <h3
                    className="font-mono"
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--foreground)",
                      letterSpacing: "0.06em",
                      marginBottom: 12,
                      textTransform: "uppercase",
                    }}
                  >
                    {step.title}
                  </h3>
                  <p
                    style={{
                      fontSize: 13,
                      lineHeight: 1.65,
                      color: "var(--muted-foreground)",
                      margin: 0,
                    }}
                  >
                    {step.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════════
          FINAL CTA
         ════════════════════════════════════════════════════════════ */}
      <section
        style={{
          borderTop: "1px solid var(--border)",
          padding: "72px 32px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <h2
            className="font-mono"
            style={{
              fontSize: "clamp(1.2rem, 2.5vw, 1.6rem)",
              fontWeight: 700,
              color: "var(--foreground)",
              lineHeight: 1.25,
              letterSpacing: "0.02em",
              margin: 0,
            }}
          >
            Ready to investigate?
          </h2>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.7,
              color: "var(--muted-foreground)",
              marginTop: 14,
            }}
          >
            Access the full operational dashboard with live incident data,
            SAR detection, drift analysis, and vessel attribution.
          </p>
          <Link
            to="/overview"
            className="font-mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: "var(--primary)",
              color: "var(--primary-foreground)",
              padding: "14px 32px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textDecoration: "none",
              marginTop: 32,
              border: "none",
              transition: "opacity 0.15s",
            }}
            id="cta-dashboard"
          >
            OPEN OPERATIONAL DASHBOARD
            <ArrowRight style={{ width: 15, height: 15 }} />
          </Link>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════════
          LANDING FOOTER
         ════════════════════════════════════════════════════════════ */}
      <footer
        className="font-mono"
        style={{
          borderTop: "1px solid var(--border)",
          padding: "24px 32px",
          textAlign: "center",
          fontSize: 11,
          color: "var(--muted-foreground)",
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ opacity: 0.7 }}>O.S.I.S.</span>
        <span style={{ opacity: 0.3, margin: "0 8px" }}>·</span>
        <span>SIH PS26143</span>
        <span style={{ opacity: 0.3, margin: "0 8px" }}>·</span>
        <span style={{ opacity: 0.6 }}>
          Oil Spill Identification &amp; Source Attribution System
        </span>
      </footer>

      {/* ── Responsive overrides (injected as a style tag for self-containment) ── */}
      <style>{`
        /* Default: two-column hero on desktop */
        .landing-hero-grid {
          grid-template-columns: 1fr 1fr !important;
        }
        .landing-pipeline-grid {
          grid-template-columns: repeat(4, 1fr) !important;
        }

        /* Hero visual minimum height */
        .landing-hero-visual {
          min-height: 380px;
        }

        /* Tablet */
        @media (max-width: 960px) {
          .landing-hero-grid {
            grid-template-columns: 1fr !important;
            gap: 48px !important;
            padding-top: 56px !important;
            padding-bottom: 48px !important;
          }
          .landing-hero-visual {
            max-width: 520px;
            margin: 0 auto;
          }
          .landing-pipeline-grid {
            grid-template-columns: repeat(2, 1fr) !important;
          }
          .landing-bg-img {
            object-position: 52% 20% !important;
          }
        }

        /* Mobile */
        @media (max-width: 600px) {
          .landing-pipeline-grid {
            grid-template-columns: 1fr !important;
          }
          .landing-hero-visual {
            min-height: 300px;
          }
          .landing-bg-img {
            object-position: 52% 16% !important;
          }
        }

        /* Hover states */
        #cta-explore:hover {
          opacity: 0.9;
        }
        #cta-how:hover {
          border-color: var(--primary) !important;
          color: var(--primary) !important;
        }
        .landing-pipeline-card:hover {
          border-color: rgba(25, 181, 230, 0.25) !important;
        }
        #cta-dashboard:hover {
          opacity: 0.9;
        }

        /* Subtle spill pulse animation */
        .landing-spill-pulse {
          animation: landing-spill-pulse-k 3s ease-in-out infinite;
        }
        @keyframes landing-spill-pulse-k {
          0%, 100% { opacity: 0.35; r: 18; }
          50% { opacity: 0.12; r: 24; }
        }

        /* Subtle drift path animation */
        .landing-drift-path {
          animation: landing-drift-k 4s linear infinite;
        }
        @keyframes landing-drift-k {
          from { stroke-dashoffset: 0; }
          to { stroke-dashoffset: -22; }
        }

        /* Ocean current lines — majestic, ultra-subtle oceanic drift */
        .landing-currents-svg {
          animation: landing-currents-flow 120s linear infinite;
          will-change: transform;
        }
        @keyframes landing-currents-flow {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(-50%, 0, 0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .landing-currents-svg {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
