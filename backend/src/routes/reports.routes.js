const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/reports.controller');

router.get('/:spillId', reportsController.getReportBySpillId);

module.exports = router;
