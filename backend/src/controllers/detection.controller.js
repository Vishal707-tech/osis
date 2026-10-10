const triggerDetection = async (req, res) => {
  try {
    res.status(202).json({
      jobId: "DET-001",
      status: "processing",
      message: "Satellite image processing started"
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start detection job' });
  }
};

const getDetectionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    res.status(200).json({
      jobId: id,
      status: "completed",
      resultsFound: 1,
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch detection status' });
  }
};

module.exports = {
  triggerDetection,
  getDetectionStatus
};
