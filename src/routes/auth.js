import { Router } from 'express';
import { authenticate } from '../db.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = !!user.is_admin;
  req.session.taskId = user.task_id;

  res.json({ ok: true, isAdmin: !!user.is_admin });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ username: req.session.username, isAdmin: req.session.isAdmin });
});

export default router;
