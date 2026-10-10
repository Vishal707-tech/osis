const express = require('express');
const router = express.Router();
const detectionController = require('../controllers/detection.controller');

router.post('/', detectionController.triggerDetection);
router.get('/:id', detectionController.getDetectionStatus);

module.exports = router;
