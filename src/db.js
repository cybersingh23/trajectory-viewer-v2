import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'app.db');

let db;

// ── Password hashing ──
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return salt + ':' + hash;
}

export function verifyPassword(plain, stored) {
  // Support legacy plaintext passwords (no colon = unhashed)
  if (!stored.includes(':') || stored.length < 50) return plain === stored;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(plain, salt, 64).toString('hex');
  return test === hash;
}

export function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      task_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trajectories (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      trajectory_json TEXT,
      opencode_json TEXT,
      milestone_progress TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plain_password TEXT,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rubrics (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      milestone_id TEXT,
      criterion TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'correctness',
      is_positive INTEGER NOT NULL DEFAULT 1,
      importance TEXT NOT NULL DEFAULT 'MUST_FOLLOW',
      rationale TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS grades (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      rubric_id TEXT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'unset',
      rationale TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, rubric_id, model_name)
    );

    CREATE TABLE IF NOT EXISTS final_scores (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      score INTEGER,
      rationale TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, model_name)
    );
  `);

  // Migrate: add plain_password column if missing
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('plain_password')) {
    db.exec("ALTER TABLE users ADD COLUMN plain_password TEXT");
  }

  // Seed admin user if not exists
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
    db.prepare('INSERT INTO users (id, username, password, is_admin) VALUES (?, ?, ?, 1)')
      .run(genId(), 'admin', hashPassword(adminPassword));
    console.log('[DB] Admin user created (username: admin, password: ' + (process.env.ADMIN_PASSWORD ? '***' : 'admin') + ')');
  }
}

export function getDb() { return db; }

export function genId() { return crypto.randomUUID(); }

export function genPassword() {
  return crypto.randomBytes(4).toString('base64url').slice(0, 8);
}

// ── Task operations ──

export function createTask(name, taskJson) {
  const id = genId();
  db.prepare('INSERT INTO tasks (id, name, task_json) VALUES (?, ?, ?)').run(id, name, JSON.stringify(taskJson));
  return id;
}

export function getTasks() {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  return tasks.map(t => {
    const models = db.prepare('SELECT id, model_name FROM trajectories WHERE task_id = ?').all(t.id);
    const user = db.prepare('SELECT username, COALESCE(plain_password, password) as password FROM users WHERE task_id = ? AND is_admin = 0').get(t.id);
    const rubricCount = db.prepare('SELECT COUNT(*) as cnt FROM rubrics WHERE task_id = ?').get(t.id).cnt;
    return { ...t, models, user, rubricCount };
  });
}

export function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// ── Trajectory operations ──

export function addTrajectory(taskId, modelName, trajectoryJson, opencodeJson, milestoneProgress) {
  const id = genId();
  db.prepare('INSERT INTO trajectories (id, task_id, model_name, trajectory_json, opencode_json, milestone_progress) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, taskId, modelName, trajectoryJson ? JSON.stringify(trajectoryJson) : null, opencodeJson ? JSON.stringify(opencodeJson) : null, milestoneProgress || null);
  return id;
}

export function getTrajectories(taskId) {
  return db.prepare('SELECT * FROM trajectories WHERE task_id = ?').all(taskId);
}

// ── User operations ──

export function createTaskUser(taskId, taskName) {
  const username = taskName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
  // Ensure unique
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  const finalUsername = existing ? username + '_' + Date.now().toString(36).slice(-4) : username;
  const plainPassword = genPassword();
  const id = genId();
  db.prepare('INSERT INTO users (id, username, password, plain_password, task_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, finalUsername, hashPassword(plainPassword), plainPassword, taskId);
  return { username: finalUsername, password: plainPassword };
}

export function authenticate(username, password) {
  const user = db.prepare('SELECT id, username, password, is_admin, task_id FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password)) return null;
  return { id: user.id, username: user.username, is_admin: user.is_admin, task_id: user.task_id };
}

export function getAllCredentials() {
  return db.prepare(`
    SELECT u.username, COALESCE(u.plain_password, u.password) as password, t.name as task_name
    FROM users u JOIN tasks t ON u.task_id = t.id
    WHERE u.is_admin = 0
    ORDER BY t.name
  `).all();
}

// ── Rubric operations ──

export function getRubrics(taskId) {
  return db.prepare('SELECT * FROM rubrics WHERE task_id = ? ORDER BY sort_order, created_at').all(taskId);
}

export function addRubric(taskId, rubric) {
  const id = genId();
  db.prepare(`INSERT INTO rubrics (id, task_id, milestone_id, criterion, type, is_positive, importance, rationale, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, taskId, rubric.milestone_id || null, rubric.criterion, rubric.type || 'correctness',
    rubric.is_positive ? 1 : 0, rubric.importance || 'MUST_FOLLOW', rubric.rationale || '', rubric.sort_order || 0
  );
  return id;
}

export function updateRubric(id, fields) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (['criterion', 'type', 'is_positive', 'importance', 'rationale', 'milestone_id', 'sort_order'].includes(k)) {
      sets.push(`${k} = ?`);
      vals.push(k === 'is_positive' ? (v ? 1 : 0) : v);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE rubrics SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteRubric(id) {
  db.prepare('DELETE FROM rubrics WHERE id = ?').run(id);
}

export function clearRubrics(taskId) {
  db.prepare('DELETE FROM rubrics WHERE task_id = ?').run(taskId);
}

// ── Grade operations ──

export function upsertGrade(taskId, rubricId, modelName, verdict, rationale) {
  const id = genId();
  db.prepare(`INSERT INTO grades (id, task_id, rubric_id, model_name, verdict, rationale)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, rubric_id, model_name) DO UPDATE SET
      verdict = excluded.verdict,
      rationale = excluded.rationale,
      updated_at = datetime('now')
  `).run(id, taskId, rubricId, modelName, verdict, rationale || '');
}

export function getGrades(taskId) {
  return db.prepare('SELECT * FROM grades WHERE task_id = ?').all(taskId);
}

// ── Final score operations ──

export function upsertFinalScore(taskId, modelName, score, rationale) {
  const id = genId();
  db.prepare(`INSERT INTO final_scores (id, task_id, model_name, score, rationale)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id, model_name) DO UPDATE SET
      score = excluded.score,
      rationale = excluded.rationale,
      updated_at = datetime('now')
  `).run(id, taskId, modelName, score, rationale || '');
}

export function getFinalScores(taskId) {
  return db.prepare('SELECT * FROM final_scores WHERE task_id = ?').all(taskId);
}

// ── Export ──

export function getTaskExport(taskId) {
  const task = getTask(taskId);
  if (!task) return null;
  const rubrics = getRubrics(taskId);
  const grades = getGrades(taskId);
  const finalScores = getFinalScores(taskId);
  const trajectories = getTrajectories(taskId).map(t => ({
    id: t.id, model_name: t.model_name
  }));
  return { task: { id: task.id, name: task.name }, rubrics, grades, finalScores, trajectories };
}
