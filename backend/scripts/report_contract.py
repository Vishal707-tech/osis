"""Versioned analysis outcomes, independent of downstream evidence completeness."""
OUTCOMES = ("SPILL_DETECTED", "NO_SPILL_DETECTED", "ANALYSIS_INCONCLUSIVE")


def finalize(report, mode):
    report["mode"] = mode
    report["schemaVersion"] = "2.0"
    for name in ("mask", "detections", "backward", "forward", "candidates", "anomalies", "stages", "uncertainty"):
        report.setdefault(name, [])
    for name in ("spill", "age", "origin", "leadingCandidate"):
        report.setdefault(name, None)
    report.setdefault("environment", {})
    report.setdefault("ais", {"source": "unavailable"})
    report.setdefault("scoring", {"weights": {}, "note": "Compatibility is not legal responsibility."})
    report.setdefault("provenance", {})
    report.setdefault("disclaimer", "Analytical compatibility is not legal proof. Correlation does not establish responsibility.")
    demo = mode == "DEMO"
    detector = report.setdefault("detector", {"name": "demo-adaptive-dark-region" if demo else "unavailable", "version": "1.0", "status": "synthetic" if demo else "unavailable"})
    stage = report.get("stageStatus", {}).get("detection", {})
    outcome = report.get("outcome") or detector.get("outcome")
    if not outcome:
        if stage.get("status") == "unavailable":
            outcome = "ANALYSIS_INCONCLUSIVE"
        elif not report["detections"] and not any(v is not None for row in report["scene"].get("pixels", []) for v in row):
            outcome = "ANALYSIS_INCONCLUSIVE"
        elif not report["detections"]:
            outcome = "NO_SPILL_DETECTED"
        else:
            outcome = "SPILL_DETECTED" if demo else "ANALYSIS_INCONCLUSIVE"
    if outcome not in OUTCOMES:
        raise ValueError("Invalid analysis outcome")
    report["outcome"] = outcome
    messages = {
        "SPILL_DETECTED": "Oil-like slick detected; analytical candidate, not laboratory confirmation of oil.",
        "NO_SPILL_DETECTED": "Analysis completed: no significant oil-like anomaly detected. This is not proof of clean water.",
        "ANALYSIS_INCONCLUSIVE": "Reliable oil detection was not possible; review diagnostics and provide compatible SAR data.",
    }
    report.setdefault("outcomeReason", detector.get("reason") or (stage.get("reason") if outcome == "ANALYSIS_INCONCLUSIVE" else None) or messages[outcome])
    report["outcomeMessage"] = messages[outcome]
    report.setdefault("availability", "REAL_DATA_UNAVAILABLE" if mode == "REAL" and stage.get("status") == "unavailable" else "AVAILABLE")
    scene = report["scene"]
    bbox = scene.get("bbox")
    scene["footprint"] = ({"type": "Polygon", "coordinates": [[[bbox[0], bbox[1]], [bbox[2], bbox[1]],
                          [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]]} if bbox else None)
    fields = {"imagery": any(v is not None for row in scene.get("pixels", []) for v in row), "detection": stage.get("status") != "unavailable",
              "geometry": bool(report["spill"]), "age": bool(report["age"]), "environment": bool(report["environment"]) and report["environment"].get("status") != "UNAVAILABLE",
              "origin": bool(report["origin"]), "drift": bool(report["forward"]), "ais": bool(report["ais"].get("records")),
              "vesselIdentity": bool(report["candidates"]), "vesselScore": bool(report["candidates"])}
    report["evidenceProvenance"] = {}
    for name, available in fields.items():
        kind = "DEMO/SYNTHETIC" if demo else ("OBSERVED" if name in ("imagery", "ais", "vesselIdentity") else
                "MODELED" if name in ("environment", "origin", "drift") else "INFERRED")
        report["evidenceProvenance"][name] = {"kind": kind if available else "UNAVAILABLE",
            "reason": report["provenance"].get(name, "See stage diagnostics and source metadata")}
    report["ageEvidence"] = {"kind": "DEMO/SYNTHETIC" if demo and report["age"] else "UNAVAILABLE",
                            "reason": "Synthetic observation interval" if report["age"] else "A single SAR observation cannot date a release."}
    report["limitations"] = report["uncertainty"]
    for candidate in report["candidates"]:
        candidate["provenance"] = {"track": "DEMO/SYNTHETIC" if demo else "OBSERVED",
            "identity": "DEMO/SYNTHETIC" if demo else "UNAVAILABLE" if candidate["name"] == "Unknown vessel" else "OBSERVED",
            "compatibilityScore": "DEMO/SYNTHETIC" if demo else "INFERRED", "gapInterpolation": "MODELED"}
    return report