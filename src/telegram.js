export async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) console.error(`Telegram ${method} failed`, JSON.stringify(json));
  return json;
}

export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LIMIT = 4000;

export async function send(env, chatId, text, extra = {}) {
  const chunks = [];
  let cur = '';
  for (const block of text.split('\n\n')) {
    const next = cur ? cur + '\n\n' + block : block;
    if (next.length > LIMIT && cur) {
      chunks.push(cur);
      cur = block;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    last = await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: chunks[i].slice(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(isLast ? extra : {}),
    });
  }
  return last;
}
