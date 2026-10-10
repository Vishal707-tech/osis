const express = require('express');
const router = express.Router();
const vesselsController = require('../controllers/vessels.controller');

router.get('/', vesselsController.getVessels);
router.get('/:id', vesselsController.getVesselById);

module.exports = router;
