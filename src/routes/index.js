const { Router } = require('express');
const taskController  = require('../controllers/taskController');
const queueController = require('../controllers/queueController');

const router = Router();

router.get('/',                          taskController.healthCheck);
router.get('/cluster/info',              taskController.clusterInfo);
router.post('/worker/task',              taskController.runWorkerTask);
router.get('/worker/delay/:duration',    taskController.delayTask);

router.post('/queue/task',               queueController.addTask);
router.get('/queue/job/:id',             queueController.getJob);
router.get('/queue/job/:id/events',      queueController.streamJob);
router.get('/queue/status',              queueController.getStatus);

module.exports = router;
