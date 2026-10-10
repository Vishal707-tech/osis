const checkHealth = (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Oil Spill API is running'
  });
};

module.exports = {
  checkHealth
};
