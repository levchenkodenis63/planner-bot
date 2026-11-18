import { addDays, isoWeekday } from './dates.js';

const STEP = 0.25;
const roundStep = (h) => Math.round(h / STEP) * STEP;
const EPS = 1e-9;

export function blockedDays(shoots) {
  const map = new Map();
  for (const s of shoots) {
    const from = addDays(s.date_start, -(s.travel_before || 0));
    const to = addDays(s.date_end, s.travel_after || 0);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const kind = d < s.date_start ? 'travel_to' : d > s.date_end ? 'travel_back' : 'shoot';
      const prev = map.get(d);
      if (!prev || (prev.kind !== 'shoot' && kind === 'shoot')) map.set(d, { kind, shoot: s });
    }
  }
  return map;
}

/**
 * Day fill order: posters whose deadline can't wait (last working day before deadline),
 * then project quotas (scaled down if there is not enough time), then other posters,
 * the rest is buffer.
 */
export function buildPlan({ start, days, settings, projects, tasks = [], posters, shoots, horizon = 120 }) {
  const blocked = blockedDays(shoots);
  const daysOff = new Set(settings.days_off || []);
  const isWork = (d) => !blocked.has(d) && !daysOff.has(isoWeekday(d));

  const effDeadline = (dl) => {
    if (!dl) return null;
    let d = dl;
    for (let i = 0; i < 366 && d >= start && !isWork(d); i++) d = addDays(d, -1);
    return d;
  };

  const queue = posters
    .filter((p) => p.status !== 'done')
    .map((p) => ({
      ...p,
      left: p.hours ?? settings.poster_hours,
      eff: effDeadline(p.deadline),
      finish: null,
      late: false,
    }))
    .sort((a, b) => {
      if (a.eff !== b.eff) {
        if (!a.eff) return 1;
        if (!b.eff) return -1;
        return a.eff < b.eff ? -1 : 1;
      }
      if (a.status !== b.status) return a.status === 'doing' ? -1 : 1;
      return (a.created_at || '') < (b.created_at || '') ? -1 : a.id - b.id;
    });

  const active = projects.filter((p) => p.active);
  const openTasks = (pid) => tasks.filter((t) => t.project_id === pid && !t.done);

  const take = (p, cap, d, urgent, items) => {
    const h = Math.min(p.left, cap);
    if (h <= EPS) return 0;
    p.left -= h;
    const done = p.left <= EPS;
    if (done) {
      p.finish = d;
      if (p.eff && d > p.eff) p.late = true;
    }
    items.push({ kind: 'poster', poster: p, hours: h, urgent, finishes: done });
    return h;
  };

  const total = Math.max(days, horizon);
  const out = [];
  for (let i = 0; i < total; i++) {
    const d = addDays(start, i);
    const b = blocked.get(d);
    if (b) {
      out.push({ date: d, type: b.kind, shoot: b.shoot, items: [] });
      continue;
    }
    if (daysOff.has(isoWeekday(d))) {
      out.push({ date: d, type: 'off', items: [] });
      continue;
    }

    let cap = settings.day_hours;
    const items = [];

    for (const p of queue) {
      if (cap <= EPS) break;
      if (p.left > EPS && p.eff && p.eff <= d) cap -= take(p, cap, d, true, items);
    }
    for (const p of queue) {
      if (p.left > EPS && p.eff && p.eff <= d) p.late = true;
    }

    const quota = active.reduce((s, p) => s + p.daily_hours, 0);
    const scale = quota > 0 ? Math.min(1, cap / quota) : 0;
    for (const pr of active) {
      const h = Math.min(cap, roundStep(pr.daily_hours * scale));
      if (h <= EPS) continue;
      cap -= h;
      items.push({
        kind: 'project',
        project: pr,
        hours: h,
        reduced: h + EPS < pr.daily_hours,
        overdue: !!(pr.deadline && d > pr.deadline),
        nextTasks: openTasks(pr.id).slice(0, 2),
      });
    }

    for (const p of queue) {
      if (cap <= EPS) break;
      if (p.left > EPS) cap -= take(p, cap, d, false, items);
    }

    if (cap > EPS) items.push({ kind: 'free', hours: cap });

    let t = settings.start_min;
    for (const it of items) {
      it.from = t;
      t += it.hours * 60;
      it.to = t;
    }
    out.push({ date: d, type: 'work', items });
  }

  for (const p of queue) if (p.left > EPS && p.eff) p.late = true;

  return {
    days: out.slice(0, days),
    posters: queue,
    unscheduled: queue.filter((p) => p.left > EPS),
  };
}
