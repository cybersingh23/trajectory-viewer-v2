import { Router } from 'express';
import { requireAdmin } from '../middleware.js';
import * as db from '../db.js';
import { generateRubrics, generationProgress } from '../services/rubrics.js';

const router = Router();
router.use(requireAdmin);

// List all tasks
router.get('/tasks', (req, res) => {
  res.json(db.getTasks());
});

// Upload a new task (client sends parsed JSON data)
router.post('/tasks', (req, res) => {
  const { name, taskJson, models } = req.body;
  if (!name || !models || !models.length) return res.status(400).json({ error: 'name and models required' });

  const taskId = db.createTask(name, taskJson);
  for (const m of models) {
    db.addTrajectory(taskId, m.name, m.trajectoryJson, m.opencodeJson, m.milestoneProgress);
  }
  const creds = db.createTaskUser(taskId, name);
  res.json({ taskId, credentials: creds });
});

// Get single task with trajectories
router.get('/tasks/:id', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const trajectories = db.getTrajectories(req.params.id);
  const rubrics = db.getRubrics(req.params.id);
  const user = db.getAllCredentials().find(c => {
    const t = db.getTask(req.params.id);
    return t && c.task_name === t.name;
  });
  res.json({ task, trajectories, rubrics, user });
});

// Delete task
router.delete('/tasks/:id', (req, res) => {
  db.deleteTask(req.params.id);
  res.json({ ok: true });
});

// Generate rubrics via LLM
router.post('/tasks/:id/generate-rubrics', async (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  try {
    const taskData = JSON.parse(task.task_json);
    const trajectories = db.getTrajectories(req.params.id);
    const result = await generateRubrics(taskData, trajectories, req.params.id);

    // Clear old rubrics and insert new ones
    db.clearRubrics(req.params.id);
    result.rubrics.forEach((r, i) => db.addRubric(req.params.id, { ...r, sort_order: i }));

    res.json({ rubrics: db.getRubrics(req.params.id), usage: result.usage });
  } catch (err) {
    generationProgress.delete(req.params.id);
    console.error('Rubric generation failed:', err);
    res.status(500).json({ error: 'Rubric generation failed: ' + err.message });
  }
});

router.get('/tasks/:id/generate-rubrics/progress', (req, res) => {
  const p = generationProgress.get(req.params.id);
  if (!p) return res.json({ active: false });
  res.json({ active: true, ...p });
});

// Update a rubric
router.put('/rubrics/:id', (req, res) => {
  db.updateRubric(req.params.id, req.body);
  res.json({ ok: true });
});

// Delete a rubric
router.delete('/rubrics/:id', (req, res) => {
  db.deleteRubric(req.params.id);
  res.json({ ok: true });
});

// Add a rubric manually
router.post('/tasks/:id/rubrics', (req, res) => {
  const id = db.addRubric(req.params.id, req.body);
  res.json({ id });
});

// Export grading data for a task
router.get('/tasks/:id/export', (req, res) => {
  const data = db.getTaskExport(req.params.id);
  if (!data) return res.status(404).json({ error: 'Task not found' });
  res.setHeader('Content-Disposition', 'attachment; filename=grading-export-' + req.params.id.slice(0, 8) + '.json');
  res.json(data);
});

// Export all credentials as CSV
router.get('/credentials/export', (req, res) => {
  const creds = db.getAllCredentials();
  let csv = 'Task Name,User ID,User Password\n';
  creds.forEach(c => {
    csv += `"${c.task_name}","${c.username}","${c.password}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=credentials.csv');
  res.send(csv);
});

export default router;
