import { parseTime } from './dates.js';

export const DEFAULTS = {
  day_hours: '8',
  start_time: '10:00',
  poster_hours: '1.5',
  days_off: '',
  notify_time: '08:00',
  chat_id: '',
  last_notify: '',
};

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const raw = { ...DEFAULTS };
  for (const r of results) raw[r.key] = r.value;
  return {
    raw,
    day_hours: Number(raw.day_hours),
    start_min: parseTime(raw.start_time) ?? 600,
    poster_hours: Number(raw.poster_hours),
    days_off: raw.days_off ? raw.days_off.split(',').map(Number).filter(Boolean) : [],
    notify_time: raw.notify_time,
    chat_id: raw.chat_id,
    last_notify: raw.last_notify,
  };
}

export function setSetting(db, key, value) {
  return db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value))
    .run();
}

export async function listProjects(db, onlyActive = false) {
  const sql = onlyActive
    ? 'SELECT * FROM projects WHERE active = 1 ORDER BY id'
    : 'SELECT * FROM projects WHERE active >= 0 ORDER BY active DESC, id';
  return (await db.prepare(sql).all()).results;
}

// SQLite NOCASE/LIKE fold only ASCII, so Cyrillic names are matched in JS
async function findProjectByName(db, name, exactOnly) {
  const all = (await db.prepare('SELECT * FROM projects ORDER BY active DESC, id').all()).results;
  const q = name.trim().toLowerCase();
  return (
    all.find((p) => p.name.toLowerCase() === q) ||
    (exactOnly ? null : all.find((p) => p.active >= 0 && p.name.toLowerCase().startsWith(q))) ||
    null
  );
}

export async function upsertProject(db, name, hours, deadline) {
  const existing = await findProjectByName(db, name, true);
  if (existing) {
    return db
      .prepare('UPDATE projects SET daily_hours = ?, deadline = COALESCE(?, deadline), active = 1 WHERE id = ?')
      .bind(hours, deadline, existing.id)
      .run();
  }
  return db
    .prepare('INSERT INTO projects (name, daily_hours, deadline, active) VALUES (?, ?, ?, 1)')
    .bind(name, hours, deadline)
    .run();
}

export function findProject(db, ref) {
  if (/^\d+$/.test(ref)) return db.prepare('SELECT * FROM projects WHERE id = ?').bind(Number(ref)).first();
  return findProjectByName(db, ref, false);
}

// active: 1 = в работе, 0 = на паузе, -1 = завершён
export function setProjectActive(db, id, active) {
  return db.prepare('UPDATE projects SET active = ? WHERE id = ?').bind(active, id).run();
}

export async function listTasks(db, projectId = null) {
  const q = projectId
    ? db.prepare('SELECT * FROM project_tasks WHERE done = 0 AND project_id = ? ORDER BY id').bind(projectId)
    : db.prepare('SELECT * FROM project_tasks WHERE done = 0 ORDER BY id');
  return (await q.all()).results;
}

export function addTask(db, projectId, title) {
  return db.prepare('INSERT INTO project_tasks (project_id, title) VALUES (?, ?)').bind(projectId, title).run();
}

export function doneTask(db, id) {
  return db.prepare('UPDATE project_tasks SET done = 1 WHERE id = ?').bind(id).run();
}

export async function listPosters(db) {
  return (await db.prepare("SELECT * FROM posters WHERE status != 'done' ORDER BY id").all()).results;
}

export async function addPoster(db, p) {
  const r = await db
    .prepare('INSERT INTO posters (client, contact, details, hours, deadline) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(p.client, p.contact ?? null, p.details ?? null, p.hours, p.deadline ?? null)
    .first();
  return r.id;
}

export function getPoster(db, id) {
  return db.prepare('SELECT * FROM posters WHERE id = ?').bind(id).first();
}

export function recentPosterFrom(db, contact, client) {
  return db
    .prepare(
      `SELECT * FROM posters
       WHERE status = 'todo' AND created_at > datetime('now', '-3 minutes')
         AND ((? IS NOT NULL AND contact = ?) OR (? IS NULL AND client = ?))
       ORDER BY id DESC LIMIT 1`
    )
    .bind(contact, contact, contact, client)
    .first();
}

export function appendPosterDetails(db, id, text) {
  return db
    .prepare("UPDATE posters SET details = TRIM(COALESCE(details, '') || char(10) || ?) WHERE id = ?")
    .bind(text, id)
    .run();
}

export function setPosterStatus(db, id, status) {
  return db
    .prepare("UPDATE posters SET status = ?, done_at = CASE WHEN ? = 'done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?")
    .bind(status, status, id)
    .run();
}

export function setPosterDeadline(db, id, deadline) {
  return db.prepare('UPDATE posters SET deadline = ? WHERE id = ?').bind(deadline, id).run();
}

export function setPosterHours(db, id, hours) {
  return db.prepare('UPDATE posters SET hours = ? WHERE id = ?').bind(hours, id).run();
}

export function deletePoster(db, id) {
  return db.prepare('DELETE FROM posters WHERE id = ?').bind(id).run();
}

export async function listShoots(db, fromDate) {
  return (
    await db
      .prepare("SELECT * FROM shoots WHERE date(date_end, '+' || travel_after || ' days') >= ? ORDER BY date_start")
      .bind(fromDate)
      .all()
  ).results;
}

export function addShoot(db, s) {
  return db
    .prepare('INSERT INTO shoots (title, date_start, date_end, travel_before, travel_after) VALUES (?, ?, ?, ?, ?)')
    .bind(s.title, s.date_start, s.date_end, s.travel_before, s.travel_after)
    .run();
}

export function deleteShoot(db, id) {
  return db.prepare('DELETE FROM shoots WHERE id = ?').bind(id).run();
}
