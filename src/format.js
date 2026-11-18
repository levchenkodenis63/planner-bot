import { esc } from './telegram.js';
import { fmtDate, fmtShort, fmtHours, fmtTime } from './dates.js';

const tripName = (s) => esc(s.title);

function dayHeader(day) {
  return `📅 <b>${fmtDate(day.date)}</b>`;
}

export function taskLabel(t) {
  if (!t.deadline) return esc(t.title);
  return `${esc(t.title)} (${t.overdue ? '⚠️ ' : ''}до ${fmtShort(t.deadline)})`;
}

function itemLine(it, detailed) {
  const time = `${fmtTime(it.from)}–${fmtTime(it.to)}`;
  if (it.kind === 'project') {
    let s = `${time} 💼 <b>${esc(it.project.name)}</b> · ${fmtHours(it.hours)}`;
    if (it.reduced) s += ' <i>(урезано)</i>';
    if (it.overdue) s += ' ⚠️ <i>дедлайн прошёл</i>';
    if (detailed && it.nextTasks.length) s += '\n      ↳ ' + it.nextTasks.map(taskLabel).join('; ');
    return s;
  }
  if (it.kind === 'poster') {
    const p = it.poster;
    let s = `${time} 🖼 #${p.id} ${esc(p.client)} · ${fmtHours(it.hours)}`;
    if (!it.finishes) s += ' <i>(часть)</i>';
    if (p.deadline) s += ` · до ${fmtShort(p.deadline)}`;
    if (it.urgent) s += ' 🔥';
    if (detailed && p.details) s += `\n      ↳ ${esc(p.details.split('\n')[0].slice(0, 80))}`;
    return s;
  }
  return `${time} ☕ Буфер · ${fmtHours(it.hours)}`;
}

export function renderDay(day, detailed = true) {
  const head = dayHeader(day);
  if (day.type === 'shoot') return `${head}\n📸 <b>Съёмка:</b> ${tripName(day.shoot)} — весь день`;
  if (day.type === 'travel_to') return `${head}\n🚗 Дорога на съёмку: ${tripName(day.shoot)}`;
  if (day.type === 'travel_back') return `${head}\n🚗 Дорога обратно: ${tripName(day.shoot)}`;
  if (day.type === 'off') return `${head}\n😴 Выходной`;
  if (!day.items.length) return `${head}\nНет задач`;
  return `${head}\n` + day.items.map((it) => itemLine(it, detailed)).join('\n');
}

export function renderSummary(plan) {
  const lines = [];
  const left = plan.posters.filter((p) => p.status !== 'done');
  if (left.length) {
    const hours = left.reduce((s, p) => s + (p.hours || 0), 0);
    lines.push(`🖼 Постеров в работе: ${left.length} (≈${fmtHours(hours)})`);
  }
  const late = plan.posters.filter((p) => p.late);
  if (late.length) {
    lines.push(
      '⚠️ Не успеваем к сроку:\n' +
        late
          .map((p) => {
            const when = p.finish ? `готов ${fmtShort(p.finish)}` : 'не влезает в план';
            return `  #${p.id} ${esc(p.client)} — срок ${fmtShort(p.deadline)}, ${when}`;
          })
          .join('\n')
    );
  }
  return lines.join('\n');
}

export function renderPlan(plan, { detailed = true, summary = true } = {}) {
  const parts = plan.days.map((d) => renderDay(d, detailed));
  const s = summary ? renderSummary(plan) : '';
  if (s) parts.push(s);
  return parts.join('\n\n');
}
