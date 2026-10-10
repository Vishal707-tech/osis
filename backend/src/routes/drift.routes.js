const express = require('express');
const router = express.Router();
const driftController    = require('../controllers/drift.controller');
const hindcastController = require('../controllers/hindcast.controller');

// Phase 3: backward-hindcast trigger
// POST /api/drift/:spillId/hindcast
router.post('/:spillId/hindcast', hindcastController.runHindcastHandler);

// Existing: fetch persisted drift predictions for a spill
// GET /api/drift/:spillId
router.get('/:spillId', driftController.getDriftData);

module.exports = router;
