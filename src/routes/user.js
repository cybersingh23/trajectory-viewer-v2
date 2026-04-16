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

// ── Grading ──

// Save a grade (PASS/FAIL per rubric per model) — auto-save
router.put('/grades', (req, res) => {
  if (!req.session.taskId) return res.status(400).json({ error: 'No task assigned' });
  const { rubricId, modelName, verdict, rationale } = req.body;
  if (!rubricId || !modelName) return res.status(400).json({ error: 'rubricId and modelName required' });
  if (verdict && !['pass', 'fail', 'unset'].includes(verdict)) return res.status(400).json({ error: 'verdict must be pass, fail, or unset' });
  db.upsertGrade(req.session.taskId, rubricId, modelName, verdict || 'unset', rationale);
  res.json({ ok: true });
});

// Get all grades for this task
router.get('/grades', (req, res) => {
  if (!req.session.taskId) return res.status(400).json({ error: 'No task assigned' });
  res.json(db.getGrades(req.session.taskId));
});

// Save final score (1-5 per model) — auto-save
router.put('/final-scores', (req, res) => {
  if (!req.session.taskId) return res.status(400).json({ error: 'No task assigned' });
  const { modelName, score, rationale } = req.body;
  if (!modelName) return res.status(400).json({ error: 'modelName required' });
  if (score != null && (score < 1 || score > 5)) return res.status(400).json({ error: 'score must be 1-5' });
  db.upsertFinalScore(req.session.taskId, modelName, score, rationale);
  res.json({ ok: true });
});

// Get all final scores for this task
router.get('/final-scores', (req, res) => {
  if (!req.session.taskId) return res.status(400).json({ error: 'No task assigned' });
  res.json(db.getFinalScores(req.session.taskId));
});

// Export grading data as JSON
router.get('/export', (req, res) => {
  if (!req.session.taskId) return res.status(400).json({ error: 'No task assigned' });
  const data = db.getTaskExport(req.session.taskId);
  if (!data) return res.status(404).json({ error: 'Task not found' });
  res.setHeader('Content-Disposition', 'attachment; filename=grading-export.json');
  res.json(data);
});

export default router;
