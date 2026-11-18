import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { buildPlan } from '../src/planner.js';
import { parseDate, parseRange, fmtHours, todayLocal, addDays, fmtShort } from '../src/dates.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('ok -', name);
};

// ---------- dates ----------
await test('parseDate', () => {
  const t = '2026-11-18';
  assert.equal(parseDate('25.11', t), '2026-11-25');
  assert.equal(parseDate('завтра', t), '2026-11-19');
  assert.equal(parseDate('+3', t), '2026-11-21');
  assert.equal(parseDate('31.02', t), null);
  assert.equal(parseDate('05.01', '2026-12-20'), '2027-01-05');
  assert.equal(parseDate('2026-12-01', t), '2026-12-01');
  assert.deepEqual(parseRange('29.11-30.11', t), ['2026-11-29', '2026-11-30']);
  assert.deepEqual(parseRange('22.11', t), ['2026-11-22', '2026-11-22']);
  assert.equal(parseRange('30.11-29.11', t), null);
  assert.equal(fmtHours(1.5), '1ч 30м');
});

// ---------- planner ----------
const settings = { day_hours: 8, start_min: 600, poster_hours: 1.5, days_off: [] };
const projects = [
  { id: 1, name: 'A', daily_hours: 3, active: 1 },
  { id: 2, name: 'B', daily_hours: 3, active: 1 },
];
const mkPoster = (id, extra = {}) => ({ id, client: 'C' + id, hours: 1.5, status: 'todo', created_at: `2026-11-1${id % 10}`, ...extra });

await test('8h day: 3+3 projects + poster + buffer', () => {
  const plan = buildPlan({ start: '2026-11-18', days: 1, settings, projects, posters: [mkPoster(1)], shoots: [] });
  const items = plan.days[0].items;
  assert.deepEqual(items.map((i) => [i.kind, i.hours]), [['project', 3], ['project', 3], ['poster', 1.5], ['free', 0.5]]);
  assert.equal(items[2].from, 600 + 360);
  assert.equal(items.at(-1).to, 600 + 480);
});

await test('local shoot day and away trip with travel days block everything', () => {
  const shoots = [
    { id: 1, title: 'Кубок', date_start: '2026-11-19', date_end: '2026-11-19', travel_before: 0, travel_after: 0 },
    { id: 2, title: 'Казань', date_start: '2026-11-22', date_end: '2026-11-23', travel_before: 1, travel_after: 1 },
  ];
  const plan = buildPlan({ start: '2026-11-18', days: 8, settings, projects, posters: [], shoots });
  assert.deepEqual(plan.days.map((d) => d.type), ['work', 'shoot', 'work', 'travel_to', 'shoot', 'shoot', 'travel_back', 'work']);
  for (const d of plan.days) if (d.type !== 'work') assert.equal(d.items.length, 0);
});

await test('poster due before a shoot squeezes projects on the last working day', () => {
  const shoots = [{ id: 1, title: 'X', date_start: '2026-11-19', date_end: '2026-11-19', travel_before: 0, travel_after: 0 }];
  const posters = [1, 2, 3, 4].map((i) => mkPoster(i, { deadline: '2026-11-19' }));
  const plan = buildPlan({ start: '2026-11-18', days: 1, settings, projects, posters, shoots });
  const d = plan.days[0];
  const ph = d.items.filter((i) => i.kind === 'poster').reduce((s, i) => s + i.hours, 0);
  const pr = d.items.filter((i) => i.kind === 'project');
  assert.equal(ph, 6);
  assert.equal(pr.reduce((s, i) => s + i.hours, 0), 2);
  assert.ok(pr.every((i) => i.reduced));
  assert.ok(plan.posters.every((p) => !p.late));
});

await test('impossible deadline is flagged late', () => {
  const posters = [1, 2, 3, 4, 5, 6].map((i) => mkPoster(i, { deadline: '2026-11-18' }));
  const plan = buildPlan({ start: '2026-11-18', days: 2, settings, projects, posters, shoots: [] });
  const late = plan.posters.filter((p) => p.late).map((p) => p.id);
  assert.ok(late.includes(6), 'last poster should be late');
  assert.ok(!late.includes(1));
});

await test('days off are skipped and paused projects ignored', () => {
  const plan = buildPlan({
    start: '2026-11-21', days: 3, settings: { ...settings, days_off: [6, 7] },
    projects: [projects[0], { ...projects[1], active: 0 }], posters: [], shoots: [],
  });
  assert.deepEqual(plan.days.map((d) => d.type), ['off', 'off', 'work']);
  assert.equal(plan.days[2].items.filter((i) => i.kind === 'project').length, 1);
});

await test('large poster splits across days', () => {
  const plan = buildPlan({ start: '2026-11-18', days: 2, settings, projects, posters: [mkPoster(1, { hours: 3 })], shoots: [] });
  assert.equal(plan.days[0].items.find((i) => i.kind === 'poster').hours, 2);
  assert.equal(plan.days[1].items.find((i) => i.kind === 'poster').hours, 1);
  assert.equal(plan.posters[0].finish, '2026-11-19');
});

// ---------- end-to-end through handleUpdate ----------
function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } }),
  });
  return { prepare: (sql) => stmt(sql) };
}

const sqlite = new Database(':memory:');
sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const env = { DB: d1(sqlite), BOT_TOKEN: 'T', ALLOWED_USER_ID: '42', TZ_OFFSET_MIN: '240' };

const calls = [];
globalThis.fetch = async (url, init) => {
  const method = url.split('/').pop();
  calls.push({ method, body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: {} }) };
};
const { handleUpdate, morning } = await import('../src/bot.js');
const say = async (text, from = 42) => {
  calls.length = 0;
  await handleUpdate({ message: { message_id: 1, from: { id: from }, chat: { id: from }, text } }, env);
  return calls.map((c) => c.body.text).join('\n---\n');
};

await test('stranger gets their ID, nothing else', async () => {
  const r = await say('/today', 7);
  assert.match(r, /Ваш Telegram ID: <code>7<\/code>/);
});

await test('full flow', async () => {
  await say('/start');
  assert.match(await say('/project Сайт Альфа | 3 | 31.01'), /Сайт Альфа/);
  const r2 = await say('/project CRM Бета | 3');
  assert.match(r2, /На постеры остаётся до 2ч/);
  assert.match(await say('/task сайт | Авторизация\nКорзина'), /задач: 2/);

  const r3 = await say('/poster Иванов | марафон 10км | завтра\nПетрова | полумарафон | 25.11 | 2\n | без имени');
  assert.match(r3, /Добавлено постеров: 2/);
  assert.match(r3, /нет имени клиента/);

  // forwarded order + same-client follow-up within the merge window
  calls.length = 0;
  const fwd = (text) => handleUpdate({
    message: { message_id: 2, from: { id: 42 }, chat: { id: 42 }, text,
      forward_origin: { type: 'user', sender_user: { id: 555, first_name: 'Сидор', username: 'sidor' } } },
  }, env);
  await fwd('Здравствуйте, хочу постер с забега');
  assert.match(calls[0].body.text, /Постер <b>#3<\/b>/);
  assert.ok(calls[0].body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'pdl:3:1'));
  calls.length = 0;
  await fwd('номер 128');
  assert.match(calls[0].body.text, /Добавлено к постеру #3/);
  assert.match(sqlite.prepare('SELECT details FROM posters WHERE id=3').get().details, /номер 128/);

  // deadline button
  calls.length = 0;
  await handleUpdate({ callback_query: { id: 'q', from: { id: 42 }, data: 'pdl:3:2', message: { message_id: 9, chat: { id: 42 } } } }, env);
  assert.ok(calls.some((c) => c.method === 'editMessageText' && /Срок:/.test(c.body.text)));

  const tl = todayLocal(240);
  const dm = (n) => fmtShort(addDays(tl, n));
  const shootRes = await say(`/trip ${dm(3)}-${dm(4)} | Казань | 1 | 1`);
  assert.match(shootRes, /Выезд/);
  assert.match(await say(`/shoot ${dm(10)} | Кубок Самары`), /Съёмка/);
  const shoots = await say('/shoots');
  assert.match(shoots, /Казань/);
  assert.match(shoots, /дорога 1\+1/);

  const today = await say('📅 Сегодня');
  console.log('\n===== /today =====\n' + today + '\n');
  assert.match(today, /10:00–13:00 💼 <b>Сайт Альфа<\/b>/);
  assert.match(today, /Авторизация/);

  const week = await say('/week');
  console.log('===== /week =====\n' + week + '\n');
  assert.match(week, /Дорога на съёмку: Казань/);
  assert.match(week, /Дорога обратно: Казань/);

  const posters = await say('/posters');
  console.log('===== /posters =====\n' + posters + '\n');
  assert.match(posters, /@sidor/);

  // mark done via button, list is refreshed
  calls.length = 0;
  await handleUpdate({ callback_query: { id: 'q', from: { id: 42 }, data: 'pd:1', message: { message_id: 9, chat: { id: 42 } } } }, env);
  const edited = calls.find((c) => c.method === 'editMessageText');
  assert.doesNotMatch(edited.body.text, /#1<\/b>/);

  assert.match(await say('/done 2'), /Готово: #2 Петрова/);
  assert.match(await say('/set off сб,вс'), /Выходные: сб, вс/);
  assert.match(await say('/set hours 9'), /Рабочий день: 9ч/);
  assert.match(await say('/delshoot 1'), /удалена/);
  assert.match(await say('/delshoot 99'), /нет/);
  assert.match(await say('/plan 31.12'), /31\.12/);
  assert.match(await say('/qwe'), /Неизвестная команда/);

  // project pause via button
  calls.length = 0;
  await handleUpdate({ callback_query: { id: 'q', from: { id: 42 }, data: 'pp:2', message: { message_id: 9, chat: { id: 42 } } } }, env);
  assert.match(calls.find((c) => c.method === 'editMessageText').body.text, /на паузе/);
});

await test('morning notification: once, only near the set time', async () => {
  const at = (iso) => Date.parse(iso);
  calls.length = 0;
  await morning(env, at('2026-11-18T03:30:00Z')); // 07:30 local — too early
  assert.equal(calls.length, 0);
  await morning(env, at('2026-11-18T04:00:00Z')); // 08:00 local
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Доброе утро/);
  await morning(env, at('2026-11-18T05:00:00Z')); // already sent today
  assert.equal(calls.length, 1);
});


await test('planner: tasks by deadline, project with nearest task goes first, overdue flagged', () => {
  const tasks = [
    { id: 1, project_id: 1, title: 'a-late', deadline: '2026-11-30', done: 0 },
    { id: 2, project_id: 1, title: 'a-none', deadline: null, done: 0 },
    { id: 3, project_id: 2, title: 'b-soon', deadline: '2026-11-17', done: 0 },
    { id: 4, project_id: 1, title: 'a-soon', deadline: '2026-11-20', done: 0 },
  ];
  const plan = buildPlan({ start: '2026-11-18', days: 1, settings, projects, tasks, posters: [], shoots: [] });
  const pr = plan.days[0].items.filter((i) => i.kind === 'project');
  assert.deepEqual(pr.map((i) => i.project.name), ['B', 'A']);
  assert.deepEqual(pr[1].nextTasks.map((t) => t.title), ['a-soon', 'a-late']);
  assert.equal(pr[0].nextTasks[0].overdue, true);
  assert.equal(pr[1].nextTasks[0].overdue, false);
});

await test('bot: task deadlines (default +7, explicit, multi-line, /taskdate)', async () => {
  const t0 = todayLocal(240);
  sqlite.exec('DELETE FROM project_tasks');
  const r = await say(`/task crm | Схема БД\nАPI заказов | ${fmtShort(addDays(t0, 2))}\nЛоманая | 32.13`);
  assert.match(r, /добавлено задач: 2/);
  assert.match(r, /не понял дату/);
  const rows = sqlite.prepare('SELECT id, title, deadline FROM project_tasks ORDER BY id').all();
  assert.equal(rows[0].deadline, addDays(t0, 7));
  assert.equal(rows[1].deadline, addDays(t0, 2));

  sqlite.exec("UPDATE projects SET active = 1");
  const today = await say('/today');
  assert.ok(today.indexOf('АPI заказов') < today.indexOf('Схема БД'), 'nearest task first');
  assert.match(today, /<b>CRM Бета<\/b>[^\n]*\n\s+↳ АPI заказов \(до/);

  assert.match(await say(`/taskdate ${rows[0].id} ${fmtShort(addDays(t0, -1))}`), /до/);
  const list = await say('/tasks');
  assert.match(list, /Схема БД \(⚠️ до/);
  assert.ok(list.indexOf('Схема БД') < list.indexOf('АPI заказов'));
  assert.match(await say('/taskdate 999 25.11'), /нет/);
  console.log('\n===== /tasks =====\n' + list + '\n\n===== /today =====\n' + today + '\n');
});

await test('migration upgrades an old database', () => {
  const old = new Database(':memory:');
  const oldSchema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace('  deadline TEXT,\n  done INTEGER', '  done INTEGER');
  old.exec(oldSchema);
  old.exec("INSERT INTO projects (name, daily_hours) VALUES ('P', 3)");
  old.exec("INSERT INTO project_tasks (project_id, title, created_at) VALUES (1, 'old', '2026-11-10 09:00:00')");
  old.exec(fs.readFileSync(new URL('../migrations/0001_task_deadline.sql', import.meta.url), 'utf8'));
  assert.equal(old.prepare('SELECT deadline FROM project_tasks').get().deadline, '2026-11-17');
});

console.log(`\nВсе тесты пройдены: ${passed}`);
