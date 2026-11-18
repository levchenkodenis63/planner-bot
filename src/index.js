import { handleUpdate, morning, COMMANDS } from './bot.js';
import { tg } from './telegram.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (!env.WEBHOOK_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        await handleUpdate(await req.json(), env);
      } catch (e) {
        console.error('update failed', e?.stack || e);
      }
      // Always 200, otherwise Telegram keeps retrying the same broken update
      return new Response('ok');
    }

    if (req.method === 'GET' && url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      const webhook = await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      const commands = await tg(env, 'setMyCommands', { commands: COMMANDS });
      return Response.json({ webhook, commands });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(morning(env));
  },
};
