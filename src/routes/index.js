const { Router } = require('express');
const taskController = require('../controllers/taskController');

const router = Router();

router.get('/', taskController.healthCheck);
router.get('/cluster/info', taskController.clusterInfo);
router.post('/worker/task', taskController.runWorkerTask);
router.get('/worker/delay/:duration', taskController.delayTask);

module.exports = router;
