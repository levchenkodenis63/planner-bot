import * as db from './db.js';
import { tg, send, esc } from './telegram.js';
import { buildPlan } from './planner.js';
import { renderPlan, renderDay, taskLabel } from './format.js';
import {
  todayLocal,
  localHourMinute,
  addDays,
  parseDate,
  parseRange,
  parseTime,
  fmtShort,
  fmtDate,
  fmtHours,
} from './dates.js';

const tzOffset = (env) => Number(env.TZ_OFFSET_MIN ?? 240);
const today = (env) => todayLocal(tzOffset(env));

const BUTTONS = {
  '📅 Сегодня': 'today',
  '➡️ Завтра': 'tomorrow',
  '🗓 Неделя': 'week',
  '🖼 Постеры': 'posters',
  '📸 Съёмки': 'shoots',
  '💼 Проекты': 'projects',
};

const MAIN_KB = {
  keyboard: [
    [{ text: '📅 Сегодня' }, { text: '➡️ Завтра' }, { text: '🗓 Неделя' }],
    [{ text: '🖼 Постеры' }, { text: '📸 Съёмки' }, { text: '💼 Проекты' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const HELP = `<b>Планировщик задач</b>

<b>План</b>
/today — на сегодня
/tomorrow — на завтра
/week [дней] — на неделю (или N дней)
/plan 25.11 — на конкретный день

<b>Проекты</b> (часы в день)
/project Название | 3 | 31.01 — добавить/изменить (срок необязателен)
/projects — список, пауза/завершение
/task Проект | задача | срок — задача (без срока — неделя)
  несколько задач: каждая с новой строки «задача | срок»
/tasks [проект] — открытые задачи по сроку
/taskdate 5 25.11 — изменить срок задачи

<b>Постеры</b>
Перешлите сообщение клиента — заказ создастся сам.
/poster Клиент | описание | срок | часы — вручную (каждая строка — отдельный постер)
/posters — очередь с кнопками
/done 12 13 — отметить готовыми
/deadline 12 25.11 — срок (или «нет»)
/hours 12 2 — оценка в часах
/delposter 12 — удалить

<b>Съёмки</b>
/shoot 22.11 | Кубок Самары — местная (весь день)
/shoot 22.11-23.11 | Турнир — несколько дней
/trip 29.11-30.11 | Казань, ЧР | 1 | 1 — выезд, дни дороги туда/обратно
/shoots — список
/delshoot 3 — удалить

<b>Настройки</b>
/settings — текущие
/set hours 8 — длина рабочего дня
/set start 10:00 — начало дня
/set poster 1.5 — часов на постер по умолчанию
/set off сб,вс — выходные (или «нет»)
/set notify 08:00 — утренний план (или «off»)

Даты: 25.11, 25.11.2026, сегодня, завтра, +3`;

export function isAllowed(env, userId) {
  return String(env.ALLOWED_USER_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(userId));
}

async function loadPlan(env, start, days) {
  const [settings, projects, tasks, posters, shoots] = await Promise.all([
    db.getSettings(env.DB),
    db.listProjects(env.DB, true),
    db.listTasks(env.DB),
    db.listPosters(env.DB),
    db.listShoots(env.DB, start),
  ]);
  return { settings, plan: buildPlan({ start, days, settings, projects, tasks, posters, shoots }) };
}

const num = (s) => {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

const contactHtml = (c) => {
  if (!c) return '';
  if (c.startsWith('@')) return ' ' + esc(c);
  const m = c.match(/^id(\d+)$/);
  return m ? ` <a href="tg://user?id=${m[1]}">написать</a>` : ' ' + esc(c);
};

// ---------- plan ----------

async function cmdPlanDays(env, chatId, start, days, detailed) {
  const { plan } = await loadPlan(env, start, days);
  await send(env, chatId, renderPlan(plan, { detailed }), { reply_markup: MAIN_KB });
}

// ---------- projects ----------

async function projectsView(env) {
  const [projects, tasks] = await Promise.all([db.listProjects(env.DB), db.listTasks(env.DB)]);
  if (!projects.length) return { text: 'Проектов нет. Добавьте: /project Название | 3 | 31.01' };
  const lines = projects.map((p) => {
    const open = tasks.filter((t) => t.project_id === p.id).length;
    let s = `${p.active ? '💼' : '⏸'} <b>${esc(p.name)}</b> · ${fmtHours(p.daily_hours)}/день`;
    if (p.deadline) s += ` · до ${fmtShort(p.deadline)}`;
    if (open) s += ` · задач: ${open}`;
    if (!p.active) s += ' · <i>на паузе</i>';
    return s;
  });
  const total = projects.filter((p) => p.active).reduce((s, p) => s + p.daily_hours, 0);
  const keyboard = projects.map((p) => [
    { text: `${p.active ? '⏸ Пауза' : '▶️ Возобновить'}: ${p.name}`, callback_data: `pp:${p.id}` },
    { text: '✅ Завершён', callback_data: `pc:${p.id}` },
  ]);
  return {
    text: `<b>Проекты</b> (в день: ${fmtHours(total)})\n\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

async function cmdProject(env, chatId, args) {
  if (!args) return sendView(env, chatId, await projectsView(env));
  const [name, h, dl] = args.split('|').map((s) => s.trim());
  const hours = num(h);
  if (!name || !(hours > 0 && hours <= 24)) {
    return send(env, chatId, 'Формат: /project Название | часов в день | срок\nНапример: /project Сайт для Альфы | 3 | 31.01');
  }
  let deadline = null;
  if (dl) {
    deadline = parseDate(dl, today(env));
    if (!deadline) return send(env, chatId, `Не понял дату «${esc(dl)}». Пример: 31.01`);
  }
  await db.upsertProject(env.DB, name, hours, deadline);
  const s = await db.getSettings(env.DB);
  const total = (await db.listProjects(env.DB, true)).reduce((acc, p) => acc + p.daily_hours, 0);
  let text = `✅ Проект <b>${esc(name)}</b>: ${fmtHours(hours)} в день${deadline ? `, до ${fmtShort(deadline)}` : ''}`;
  if (total > s.day_hours) {
    text += `\n⚠️ Сумма по проектам (${fmtHours(total)}) больше рабочего дня (${fmtHours(s.day_hours)}) — время будет урезаться пропорционально.`;
  } else {
    text += `\nНа постеры остаётся до ${fmtHours(s.day_hours - total)} в день.`;
  }
  return send(env, chatId, text);
}

async function tasksView(env, projectId) {
  const [tasks, projects] = await Promise.all([db.listTasks(env.DB, projectId || null), db.listProjects(env.DB)]);
  if (!tasks.length) return { text: 'Открытых задач нет. Добавьте: /task Проект | задача' };
  const name = (id) => projects.find((p) => p.id === id)?.name ?? '?';
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.project_id)) groups.set(t.project_id, []);
    groups.get(t.project_id).push(t);
  }
  const t0 = today(env);
  const text = [...groups]
    .map(
      ([pid, list]) =>
        `💼 <b>${esc(name(pid))}</b>\n` +
        list.map((t) => `  <b>#${t.id}</b> ${taskLabel({ ...t, overdue: !!(t.deadline && t.deadline < t0) })}`).join('\n')
    )
    .join('\n\n');
  const keyboard = tasks.slice(0, 50).map((t) => [
    { text: `✅ ${t.title}`.slice(0, 60), callback_data: `td:${t.id}:${projectId || 0}` },
  ]);
  return {
    text: `<b>Задачи</b> (по сроку)\n\n${text}\n\nИзменить срок: /taskdate номер 25.11`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

async function cmdTask(env, chatId, args) {
  const lines = args.split('\n');
  const first = lines.shift() || '';
  const idx = first.indexOf('|');
  if (idx < 0) {
    return send(
      env,
      chatId,
      'Формат: /task Проект | задача | срок\nСрок необязателен — по умолчанию неделя.\nНесколько задач — каждая с новой строки: «задача | срок».'
    );
  }
  const ref = first.slice(0, idx).trim();
  const project = await db.findProject(env.DB, ref);
  if (!project) return send(env, chatId, `Проект «${esc(ref)}» не найден. Список: /projects`);

  const t0 = today(env);
  const added = [];
  const errors = [];
  for (const line of [first.slice(idx + 1), ...lines].map((s) => s.trim()).filter(Boolean)) {
    const parts = line.split('|').map((s) => s.trim());
    const title = parts[0];
    const dl = parts[1];
    if (!title) continue;
    const deadline = dl ? parseDate(dl, t0) : addDays(t0, 7);
    if (!deadline) {
      errors.push(`«${esc(line)}» — не понял дату «${esc(dl)}»`);
      continue;
    }
    await db.addTask(env.DB, project.id, title, deadline);
    added.push(`• ${esc(title)} — до ${fmtDate(deadline)}`);
  }
  let text = added.length
    ? `✅ В «${esc(project.name)}» добавлено задач: ${added.length}\n${added.join('\n')}`
    : 'Ничего не добавлено.';
  if (errors.length) text += `\n\n⚠️ Пропущено:\n${errors.join('\n')}`;
  return send(env, chatId, text);
}

async function cmdTaskDate(env, chatId, args) {
  const m = args.match(/^#?(\d+)\s+(.+)$/);
  if (!m) return send(env, chatId, 'Формат: /taskdate 5 25.11 (номер задачи — в /tasks)');
  const task = await db.getTask(env.DB, Number(m[1]));
  if (!task || task.done) return send(env, chatId, `Открытой задачи #${m[1]} нет.`);
  const d = parseDate(m[2], today(env));
  if (!d) return send(env, chatId, `Не понял дату «${esc(m[2])}».`);
  await db.setTaskDeadline(env.DB, task.id, d);
  return send(env, chatId, `🗓 Задача #${task.id} «${esc(task.title)}»: до ${fmtDate(d)}`);
}

async function cmdTasks(env, chatId, args) {
  let pid = 0;
  if (args) {
    const p = await db.findProject(env.DB, args.trim());
    if (!p) return send(env, chatId, `Проект «${esc(args)}» не найден.`);
    pid = p.id;
  }
  return sendView(env, chatId, await tasksView(env, pid));
}

// ---------- posters ----------

async function postersView(env) {
  const { plan } = await loadPlan(env, today(env), 1);
  const posters = plan.posters;
  if (!posters.length) return { text: '🖼 Очередь постеров пуста.' };
  const byId = [...posters].sort((a, b) => a.id - b.id);
  const total = posters.reduce((s, p) => s + p.hours, 0);
  const lines = posters.map((p) => {
    let s = `${p.status === 'doing' ? '▶️' : '•'} <b>#${p.id}</b> ${esc(p.client)}${contactHtml(p.contact)}`;
    s += ` · ${fmtHours(p.hours)}`;
    if (p.deadline) s += ` · срок ${fmtShort(p.deadline)}`;
    s += p.finish ? ` · ≈ ${fmtShort(p.finish)}` : ' · не влезает';
    if (p.late) s += ' ⚠️';
    if (p.details) s += `\n    ${esc(p.details.replace(/\s+/g, ' ').slice(0, 100))}`;
    return s;
  });
  const keyboard = byId.slice(0, 45).map((p) => [
    { text: `✅ #${p.id} ${p.client}`.slice(0, 40), callback_data: `pd:${p.id}` },
    { text: p.status === 'doing' ? '⏸' : '▶️', callback_data: `pw:${p.id}` },
  ]);
  return {
    text: `<b>Постеры</b>: ${posters.length} шт, ≈${fmtHours(total)}\n<i>в порядке очереди, ≈ — когда будет готов</i>\n\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

function deadlineKeyboard(id) {
  const opts = [
    ['Сегодня', 0],
    ['Завтра', 1],
    ['+2', 2],
    ['+3', 3],
    ['+5', 5],
    ['+7', 7],
  ];
  return {
    inline_keyboard: [
      opts.slice(0, 3).map(([t, n]) => ({ text: t, callback_data: `pdl:${id}:${n}` })),
      opts.slice(3).map(([t, n]) => ({ text: t, callback_data: `pdl:${id}:${n}` })),
      [{ text: 'Без срока', callback_data: `pdl:${id}:-1` }],
    ],
  };
}

async function cmdPoster(env, chatId, args) {
  if (!args) return send(env, chatId, 'Формат: /poster Клиент | описание | срок | часы\nКаждая строка — отдельный постер. Или просто перешлите сообщение клиента.');
  const s = await db.getSettings(env.DB);
  const t = today(env);
  const added = [];
  const errors = [];
  for (const line of args.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [client, details, dl, h] = line.split('|').map((x) => x.trim());
    if (!client) {
      errors.push(`«${esc(line)}» — нет имени клиента`);
      continue;
    }
    const deadline = dl ? parseDate(dl, t) : null;
    if (dl && !deadline) {
      errors.push(`«${esc(line)}» — не понял дату «${esc(dl)}»`);
      continue;
    }
    const hours = h ? num(h) : s.poster_hours;
    if (!(hours > 0 && hours <= 24)) {
      errors.push(`«${esc(line)}» — странные часы «${esc(h)}»`);
      continue;
    }
    const id = await db.addPoster(env.DB, { client, details: details || null, hours, deadline });
    added.push(`#${id} ${esc(client)}${deadline ? ` · до ${fmtShort(deadline)}` : ''}`);
  }
  let text = added.length ? `✅ Добавлено постеров: ${added.length}\n${added.join('\n')}` : 'Ничего не добавлено.';
  if (errors.length) text += `\n\n⚠️ Пропущено:\n${errors.join('\n')}`;
  return send(env, chatId, text);
}

function parseIds(args) {
  return (args.match(/\d+/g) || []).map(Number);
}

async function cmdDone(env, chatId, args) {
  const ids = parseIds(args);
  if (!ids.length) return send(env, chatId, 'Укажите номера: /done 12 13');
  const done = [];
  for (const id of ids) {
    const p = await db.getPoster(env.DB, id);
    if (p) {
      await db.setPosterStatus(env.DB, id, 'done');
      done.push(`#${id} ${esc(p.client)}`);
    }
  }
  return send(env, chatId, done.length ? `✅ Готово: ${done.join(', ')}` : 'Таких постеров нет.');
}

async function cmdDeadline(env, chatId, args) {
  const m = args.match(/^#?(\d+)\s+(.+)$/);
  if (!m) return send(env, chatId, 'Формат: /deadline 12 25.11 (или «нет»)');
  const p = await db.getPoster(env.DB, Number(m[1]));
  if (!p) return send(env, chatId, `Постера #${m[1]} нет.`);
  const none = /^(нет|-|none)$/i.test(m[2].trim());
  const d = none ? null : parseDate(m[2], today(env));
  if (!none && !d) return send(env, chatId, `Не понял дату «${esc(m[2])}».`);
  await db.setPosterDeadline(env.DB, p.id, d);
  return send(env, chatId, `🗓 #${p.id} ${esc(p.client)}: ${d ? `срок ${fmtShort(d)}` : 'без срока'}`);
}

async function cmdHours(env, chatId, args) {
  const m = args.match(/^#?(\d+)\s+([\d.,]+)$/);
  const h = m ? num(m[2]) : NaN;
  if (!m || !(h > 0 && h <= 24)) return send(env, chatId, 'Формат: /hours 12 2');
  const p = await db.getPoster(env.DB, Number(m[1]));
  if (!p) return send(env, chatId, `Постера #${m[1]} нет.`);
  await db.setPosterHours(env.DB, p.id, h);
  return send(env, chatId, `⏱ #${p.id} ${esc(p.client)}: ${fmtHours(h)}`);
}

async function cmdDelPoster(env, chatId, args) {
  const [id] = parseIds(args);
  const p = id && (await db.getPoster(env.DB, id));
  if (!p) return send(env, chatId, 'Формат: /delposter 12');
  await db.deletePoster(env.DB, id);
  return send(env, chatId, `🗑 Постер #${id} ${esc(p.client)} удалён.`);
}

function forwardSender(msg) {
  const o = msg.forward_origin;
  const user = o?.sender_user || msg.forward_from;
  if (user) {
    return {
      client: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Без имени',
      contact: user.username ? '@' + user.username : `id${user.id}`,
    };
  }
  const hidden = o?.sender_user_name || msg.forward_sender_name;
  if (hidden) return { client: hidden, contact: null };
  const chat = o?.chat || o?.sender_chat || msg.forward_from_chat;
  if (chat) return { client: chat.title || chat.username || 'Чат', contact: chat.username ? '@' + chat.username : null };
  return { client: 'Без имени', contact: null };
}

async function onForward(env, chatId, msg) {
  const { client, contact } = forwardSender(msg);
  const text = (msg.text || msg.caption || '').trim();
  const recent = await db.recentPosterFrom(env.DB, contact, client);
  if (recent) {
    if (!text) return;
    await db.appendPosterDetails(env.DB, recent.id, text);
    return send(env, chatId, `➕ Добавлено к постеру #${recent.id} (${esc(client)}). Если это отдельный заказ — /poster ${esc(client)} | …`);
  }
  const s = await db.getSettings(env.DB);
  const id = await db.addPoster(env.DB, {
    client,
    contact,
    details: text || '(медиа без текста)',
    hours: s.poster_hours,
    deadline: null,
  });
  return send(
    env,
    chatId,
    `🖼 Постер <b>#${id}</b> — ${esc(client)}${contactHtml(contact)}\n${esc(text.slice(0, 200))}\n\nКакой срок?`,
    { reply_markup: deadlineKeyboard(id) }
  );
}

// ---------- shoots ----------

async function cmdShoot(env, chatId, args, away) {
  const [range, title, before, after] = (args || '').split('|').map((s) => s.trim());
  const usage = away
    ? 'Формат: /trip 29.11-30.11 | Казань, ЧР | 1 | 1\n(дней дороги туда и обратно, по умолчанию 1 и 1)'
    : 'Формат: /shoot 22.11 | Кубок Самары\nили /shoot 22.11-23.11 | Турнир';
  const dates = range && parseRange(range, today(env));
  if (!dates || !title) return send(env, chatId, usage);
  const tb = away ? (before ? parseInt(before, 10) : 1) : 0;
  const ta = away ? (after ? parseInt(after, 10) : 1) : 0;
  if (!(tb >= 0 && tb <= 7 && ta >= 0 && ta <= 7)) return send(env, chatId, 'Дней дороги — от 0 до 7.\n' + usage);
  await db.addShoot(env.DB, { title, date_start: dates[0], date_end: dates[1], travel_before: tb, travel_after: ta });
  const from = addDays(dates[0], -tb);
  const to = addDays(dates[1], ta);
  const span = from === to ? fmtDate(from) : `${fmtDate(from)} — ${fmtDate(to)}`;

  const { plan } = await loadPlan(env, today(env), 1);
  const lost = plan.posters.filter((p) => p.late);
  let text = `📸 ${away ? 'Выезд' : 'Съёмка'}: <b>${esc(title)}</b>\nЗанято: ${span}`;
  if (lost.length) text += `\n⚠️ Из-за этого не успевают постеры: ${lost.map((p) => `#${p.id}`).join(', ')} — см. /posters`;
  return send(env, chatId, text);
}

async function cmdShoots(env, chatId) {
  const list = await db.listShoots(env.DB, today(env));
  if (!list.length) return send(env, chatId, 'Предстоящих съёмок нет.\n/shoot 22.11 | Название — местная\n/trip 29.11-30.11 | Название | 1 | 1 — выезд');
  const lines = list.map((s) => {
    const dates = s.date_start === s.date_end ? fmtDate(s.date_start) : `${fmtDate(s.date_start)} — ${fmtDate(s.date_end)}`;
    const road = s.travel_before || s.travel_after ? ` · 🚗 дорога ${s.travel_before}+${s.travel_after} дн.` : '';
    return `<b>#${s.id}</b> ${dates} · ${esc(s.title)}${road}`;
  });
  return send(env, chatId, `<b>Съёмки</b>\n\n${lines.join('\n')}\n\nУдалить: /delshoot номер`);
}

async function cmdDelShoot(env, chatId, args) {
  const [id] = parseIds(args);
  if (!id) return send(env, chatId, 'Формат: /delshoot 3');
  const r = await db.deleteShoot(env.DB, id);
  return send(env, chatId, r.meta?.changes ? `🗑 Съёмка #${id} удалена.` : `Съёмки #${id} нет.`);
}

// ---------- settings ----------

const WEEKDAYS = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 7 };

async function cmdSettings(env, chatId) {
  const s = await db.getSettings(env.DB);
  const names = Object.keys(WEEKDAYS);
  const off = s.days_off.length ? s.days_off.map((d) => names[d - 1]).join(', ') : 'нет';
  return send(
    env,
    chatId,
    `<b>Настройки</b>
Рабочий день: ${fmtHours(s.day_hours)} с ${esc(s.raw.start_time)}
Постер по умолчанию: ${fmtHours(s.poster_hours)}
Выходные: ${off}
Утренний план: ${esc(s.notify_time)}

Изменить: /set hours 8 · /set start 10:00 · /set poster 1.5 · /set off сб,вс · /set notify 08:00`
  );
}

async function cmdSet(env, chatId, args) {
  const m = (args || '').match(/^(\S+)\s+(.+)$/);
  if (!m) return cmdSettings(env, chatId);
  const key = m[1].toLowerCase();
  const val = m[2].trim();
  if (key === 'hours' || key === 'day') {
    const h = num(val);
    if (!(h > 0 && h <= 24)) return send(env, chatId, 'Часов в дне: от 1 до 24');
    await db.setSetting(env.DB, 'day_hours', h);
  } else if (key === 'start') {
    if (parseTime(val) === null) return send(env, chatId, 'Время в формате 10:00');
    await db.setSetting(env.DB, 'start_time', val);
  } else if (key === 'poster') {
    const h = num(val);
    if (!(h > 0 && h <= 24)) return send(env, chatId, 'Часы на постер: например 1.5');
    await db.setSetting(env.DB, 'poster_hours', h);
  } else if (key === 'off') {
    if (/^(нет|none|-)$/i.test(val)) {
      await db.setSetting(env.DB, 'days_off', '');
    } else {
      const days = val
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((x) => WEEKDAYS[x.slice(0, 2)] ?? Number(x));
      if (!days.length || days.some((d) => !(d >= 1 && d <= 7))) return send(env, chatId, 'Пример: /set off сб,вс или /set off нет');
      await db.setSetting(env.DB, 'days_off', [...new Set(days)].sort().join(','));
    }
  } else if (key === 'notify') {
    const offv = /^(off|нет|выкл)$/i.test(val);
    if (!offv && parseTime(val) === null) return send(env, chatId, 'Пример: /set notify 08:00 или /set notify off');
    await db.setSetting(env.DB, 'notify_time', offv ? 'off' : val);
  } else {
    return send(env, chatId, 'Неизвестная настройка. Доступно: hours, start, poster, off, notify');
  }
  return cmdSettings(env, chatId);
}

// ---------- plumbing ----------

function sendView(env, chatId, view) {
  return send(env, chatId, view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
}

function editView(env, cq, view) {
  return tg(env, 'editMessageText', {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    text: view.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: view.reply_markup || { inline_keyboard: [] },
  });
}

async function onCallback(env, cq) {
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (!isAllowed(env, cq.from.id)) return answer('Нет доступа');
  const [kind, a, b] = String(cq.data || '').split(':');
  const id = Number(a);

  if (kind === 'pd' || kind === 'pw') {
    const p = await db.getPoster(env.DB, id);
    if (!p) return answer('Постер уже удалён');
    const status = kind === 'pd' ? 'done' : p.status === 'doing' ? 'todo' : 'doing';
    await db.setPosterStatus(env.DB, id, status);
    await answer(status === 'done' ? `#${id} готов ✅` : status === 'doing' ? `#${id} в работе` : `#${id} в очереди`);
    return editView(env, cq, await postersView(env));
  }
  if (kind === 'pdl') {
    const p = await db.getPoster(env.DB, id);
    if (!p) return answer('Постер уже удалён');
    const n = Number(b);
    const d = n < 0 ? null : addDays(today(env), n);
    await db.setPosterDeadline(env.DB, id, d);
    await answer(d ? `Срок ${fmtShort(d)}` : 'Без срока');
    const { plan } = await loadPlan(env, today(env), 1);
    const pp = plan.posters.find((x) => x.id === id);
    let text = `🖼 Постер <b>#${id}</b> — ${esc(p.client)}${contactHtml(p.contact)}\n${d ? `Срок: ${fmtDate(d)}` : 'Без срока'}`;
    if (pp?.finish) text += `\nПо плану готов: ${fmtDate(pp.finish)}`;
    if (pp?.late) text += '\n⚠️ К сроку не успевает — проверьте /posters';
    return editView(env, cq, { text });
  }
  if (kind === 'td') {
    await db.doneTask(env.DB, id);
    await answer('Задача выполнена ✅');
    return editView(env, cq, await tasksView(env, Number(b) || 0));
  }
  if (kind === 'pp' || kind === 'pc') {
    const p = await db.findProject(env.DB, String(id));
    if (!p) return answer('Проект не найден');
    const active = kind === 'pc' ? -1 : p.active ? 0 : 1;
    await db.setProjectActive(env.DB, id, active);
    await answer(active === -1 ? 'Проект завершён 🎉' : active ? 'Возобновлён' : 'На паузе');
    return editView(env, cq, await projectsView(env));
  }
  return answer('');
}

export async function handleUpdate(update, env) {
  if (update.callback_query) return onCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;

  if (!isAllowed(env, msg.from.id)) {
    return send(env, chatId, `Это личный бот. Ваш Telegram ID: <code>${msg.from.id}</code>\nВладелец может добавить его в ALLOWED_USER_ID.`);
  }

  if (msg.forward_origin || msg.forward_from || msg.forward_sender_name || msg.forward_from_chat) {
    return onForward(env, chatId, msg);
  }

  const text = (msg.text || '').trim();
  if (!text) return;
  let cmd;
  let args = '';
  if (BUTTONS[text]) {
    cmd = BUTTONS[text];
  } else {
    const m = text.match(/^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i);
    if (!m) return send(env, chatId, 'Не понял. Команды — /help. Чтобы добавить заказ постера, перешлите сообщение клиента.', { reply_markup: MAIN_KB });
    cmd = m[1].toLowerCase();
    args = m[2].trim();
  }

  const t = today(env);
  switch (cmd) {
    case 'start':
      await db.setSetting(env.DB, 'chat_id', chatId);
      return send(env, chatId, HELP, { reply_markup: MAIN_KB });
    case 'help':
      return send(env, chatId, HELP, { reply_markup: MAIN_KB });
    case 'today':
      return cmdPlanDays(env, chatId, t, 1, true);
    case 'tomorrow':
      return cmdPlanDays(env, chatId, addDays(t, 1), 1, true);
    case 'week': {
      const n = Math.min(Math.max(parseInt(args, 10) || 7, 1), 31);
      return cmdPlanDays(env, chatId, t, n, false);
    }
    case 'plan': {
      const d = parseDate(args, t);
      if (!d || d < t) return send(env, chatId, 'Формат: /plan 25.11 (сегодня или позже)');
      const { plan } = await loadPlan(env, t, Math.round((Date.parse(d) - Date.parse(t)) / 86400000) + 1);
      return send(env, chatId, renderDay(plan.days[plan.days.length - 1], true));
    }
    case 'project':
      return cmdProject(env, chatId, args);
    case 'projects':
      return sendView(env, chatId, await projectsView(env));
    case 'task':
      return cmdTask(env, chatId, args);
    case 'taskdate':
      return cmdTaskDate(env, chatId, args);
    case 'tasks':
      return cmdTasks(env, chatId, args);
    case 'poster':
      return cmdPoster(env, chatId, args);
    case 'posters':
      return sendView(env, chatId, await postersView(env));
    case 'done':
      return cmdDone(env, chatId, args);
    case 'deadline':
      return cmdDeadline(env, chatId, args);
    case 'hours':
      return cmdHours(env, chatId, args);
    case 'delposter':
      return cmdDelPoster(env, chatId, args);
    case 'shoot':
      return cmdShoot(env, chatId, args, false);
    case 'trip':
      return cmdShoot(env, chatId, args, true);
    case 'shoots':
      return cmdShoots(env, chatId);
    case 'delshoot':
      return cmdDelShoot(env, chatId, args);
    case 'settings':
      return cmdSettings(env, chatId);
    case 'set':
      return cmdSet(env, chatId, args);
    default:
      return send(env, chatId, 'Неизвестная команда. Список — /help');
  }
}

export async function morning(env, now = Date.now()) {
  const s = await db.getSettings(env.DB);
  if (!s.chat_id || s.notify_time === 'off') return;
  const target = parseTime(s.notify_time);
  const off = tzOffset(env);
  const { h, m } = localHourMinute(off, now);
  const cur = h * 60 + m;
  const d = todayLocal(off, now);
  if (target === null || s.last_notify === d || cur < target || cur - target >= 120) return;
  await db.setSetting(env.DB, 'last_notify', d);

  const { plan } = await loadPlan(env, d, 3);
  let text = `☀️ Доброе утро! План на сегодня:\n\n${renderPlan({ ...plan, days: plan.days.slice(0, 1) })}`;
  const ahead = plan.days.slice(1).filter((x) => x.type !== 'work' && x.type !== 'off');
  if (ahead.length) {
    text += '\n\n<b>Скоро:</b>\n' + ahead.map((x) => renderDay(x).replace('\n', ' — ')).join('\n');
  }
  await send(env, s.chat_id, text, { reply_markup: MAIN_KB });
}

export const COMMANDS = [
  ['today', 'План на сегодня'],
  ['tomorrow', 'План на завтра'],
  ['week', 'План на неделю'],
  ['posters', 'Очередь постеров'],
  ['poster', 'Добавить постер'],
  ['shoots', 'Съёмки'],
  ['shoot', 'Добавить местную съёмку'],
  ['trip', 'Добавить выездную съёмку'],
  ['projects', 'Проекты'],
  ['project', 'Добавить/изменить проект'],
  ['tasks', 'Задачи по проектам'],
  ['task', 'Добавить задачу в проект'],
  ['settings', 'Настройки'],
  ['help', 'Справка'],
].map(([command, description]) => ({ command, description }));
