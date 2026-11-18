const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

export function todayLocal(offsetMin, now = Date.now()) {
  return new Date(now + offsetMin * 60000).toISOString().slice(0, 10);
}

export function localHourMinute(offsetMin, now = Date.now()) {
  const d = new Date(now + offsetMin * 60000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isoWeekday(iso) {
  const w = new Date(iso + 'T00:00:00Z').getUTCDay();
  return w === 0 ? 7 : w;
}

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n) => String(n).padStart(2, '0');

export function parseDate(input, today) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'сегодня') return today;
  if (s === 'завтра') return addDays(today, 1);
  if (s === 'послезавтра') return addDays(today, 2);
  let m = s.match(/^\+(\d{1,3})$/);
  if (m) return addDays(today, Number(m[1]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y;
  if (m[3]) {
    y = Number(m[3]);
    if (y < 100) y += 2000;
  } else {
    y = Number(today.slice(0, 4));
    // "05.01" entered in late December most likely means next year
    if (validYmd(y, mo, d) && `${y}-${pad(mo)}-${pad(d)}` < addDays(today, -60)) y += 1;
  }
  return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

export function parseRange(input, today) {
  const s = String(input || '').trim();
  let parts = s.split(/\s*(?:—|–|\.\.|\s-\s)\s*/);
  if (parts.length === 1) {
    const m = s.match(/^(\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)-(\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)$/);
    if (m) parts = [m[1], m[2]];
  }
  if (parts.length > 2) return null;
  const a = parseDate(parts[0], today);
  const b = parts.length === 2 ? parseDate(parts[1], today) : a;
  if (!a || !b || b < a) return null;
  return [a, b];
}

export function fmtDate(iso) {
  const wd = WD[new Date(iso + 'T00:00:00Z').getUTCDay()];
  return `${wd} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

export function fmtShort(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

export function fmtHours(h) {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh && mm) return `${hh}ч ${mm}м`;
  if (hh) return `${hh}ч`;
  return `${mm}м`;
}

export function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function fmtTime(min) {
  const m = Math.round(min) % (24 * 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
