const express = require('express');
const router = express.Router();
const spillsController = require('../controllers/spills.controller');
const vesselsController = require('../controllers/vessels.controller');

router.get('/', spillsController.getAllSpills);
router.get('/:spillId/characterization', spillsController.getSpillCharacterization);
router.get('/:id', spillsController.getSpillById);
// Mount vessels for a specific spill here to match GET /api/spills/:spillId/vessels
router.get('/:spillId/vessels', vesselsController.getVesselsBySpill);

module.exports = router;

