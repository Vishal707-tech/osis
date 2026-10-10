const getReportBySpillId = async (req, res) => {
  try {
    const { spillId } = req.params;
    
    const mockReport = {
      spillId: spillId,
      generatedAt: new Date().toISOString(),
      summary: "An oil spill was detected with 94% confidence. Based on drift analysis and AIS data, MV Ocean Star is the most likely candidate.",
      spillInfo: {
        areaKm2: 12.4,
        detectedAt: "2026-09-04T05:30:00Z"
      },
      probableOrigin: {
        latitude: 15.180,
        longitude: 72.390
      },
      topCandidateVessel: {
        vessel: "MV Ocean Star",
        mmsi: "123456789",
        responsibilityScore: 91
      },
      analysisSummary: "The backward trajectory intersects with the path of MV Ocean Star exactly 7 hours prior to detection, which matches the estimated age of the spill."
    };

    res.status(200).json(mockReport);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
};

module.exports = {
  getReportBySpillId
};
