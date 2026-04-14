import { Router } from 'express';
import { requireAuth } from '../middleware.js';
import * as db from '../db.js';

const router = Router();
router.use(requireAuth);

// Get the task assigned to this user + trajectories
router.get('/task', (req, res) => {
  if (req.session.isAdmin) return res.status(400).json({ error: 'Admin users do not have an assigned task' });

  const task = db.getTask(req.session.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const trajectories = db.getTrajectories(req.session.taskId);
  res.json({ task, trajectories });
});

// Get rubrics for this user's task
router.get('/rubrics', (req, res) => {
  if (!req.session.taskId) return res.status(400).json({ error: 'No task assigned' });
  res.json(db.getRubrics(req.session.taskId));
});

// Update a rubric (user can edit rubrics for their task)
router.put('/rubrics/:id', (req, res) => {
  db.updateRubric(req.params.id, req.body);
  res.json({ ok: true });
});

// Delete a rubric
router.delete('/rubrics/:id', (req, res) => {
  db.deleteRubric(req.params.id);
  res.json({ ok: true });
});

export default router;
