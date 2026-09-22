// bot.js — the same job as mtproto.js, done through a bot instead.
//
// Why both exist: a user account is told about live locations shared in any
// chat it is in, which is powerful and requires an account, an api_id, an
// api_hash and a session string that is as good as the password. A bot is
// told only about locations shared *with the bot*, which is less — and is
// exactly what you want when the people sharing are not in a group with you
// and should not have to be. They find the bot, press start, share. Nothing
// to log into on their side and nothing of yours on the line.
//
// It talks HTTPS to api.telegram.org rather than raw MTProto to a datacentre
// address, which is both easier to reach from a restricted network and the
// reason this could one day run on a Worker.
//
// Long polling rather than a webhook, deliberately: it needs no public URL, no
// certificate and no inbound port, so it works with the service bound to
// loopback exactly as it is today.

import { fromUpdate } from './positions.js';

const API = 'https://api.telegram.org';

// What the bot says when somebody starts it. This is the only place the people
// being mapped are told what is happening to them, so it says it plainly
// rather than warmly.
const WELCOME = [
  'This bot puts your live location on a private map.',
  '',
  'To share: Attach (📎) → Location → Share Live Location, and pick how long.',
  'Telegram stops on its own when that time runs out.',
  '',
  'While sharing, this records where you are and keeps the path you take.',
  'Whoever runs this map can see you. Anyone else, only if you /invite them;',
  '/circle shows who can.',
  'Send /stop to stop being shown and delete what is held about you.',
].join('\n');

const HELP = [
  'Attach (📎) → Location → Share Live Location.',
  '',
  '/login — a link to the map',
  '/invite — a link that lets one person see you',
  '/circle — who can see you, and whom you can see',
  '/pair — a code to connect a watch',
  '/stop — stop being shown, and delete the path held about you',
  '/start — this message',
].join('\n');

// ------------------------------------------------------------- circles
//
// Pure pieces of the circle conversation, exported for the tests: what an
// invite deep link carries, what a button press means, and what /circle
// shows. The decisions themselves — who may see whom — live in circles.js.

const INVITE_PREFIX = 'inv_';

// `/start inv_abc` is what Telegram sends when somebody taps an invite deep
// link. Returns the token, or null for a plain /start.
export function invitePayload(command) {
  if (!command || command.name !== '/start') return null;
  const arg = (command.args || '').trim();
  if (!arg.startsWith(INVITE_PREFIX)) return null;
  const token = arg.slice(INVITE_PREFIX.length);
  return /^[A-Za-z0-9_-]{8,64}$/.test(token) ? token : null;
}

export function inviteLink(botUsername, token) {
  return `https://t.me/${botUsername}?start=${INVITE_PREFIX}${token}`;
}

// A button's callback data: `rm:<id>` takes back what you gave, `leave:<id>`
// gives back what you were given. Anything else is ignored.
export function circleAction(data) {
  const m = /^(rm|leave):([0-9A-Za-z_-]{1,40})$/.exec(String(data || ''));
  return m ? { kind: m[1], id: m[2] } : null;
}

const nameOf = (u) => (u && (u.name || (u.username ? '@' + u.username : ''))) || 'someone';

// The /circle message: text plus one button per person, both directions.
export function circleView({ canSeeMe = [], iCanSee = [] } = {}) {
  const lines = [];
  lines.push(canSeeMe.length
    ? 'Can see you: ' + canSeeMe.map(nameOf).join(', ')
    : 'Nobody can see you. /invite makes a link for one person.');
  lines.push(iCanSee.length
    ? 'You can see: ' + iCanSee.map(nameOf).join(', ')
    : 'You cannot see anybody yet.');
  const keyboard = [
    ...canSeeMe.map((u) => [{ text: `Stop ${nameOf(u)} seeing me`, callback_data: `rm:${u.id}` }]),
    ...iCanSee.map((u) => [{ text: `Stop seeing ${nameOf(u)}`, callback_data: `leave:${u.id}` }]),
  ];
  return { text: lines.join('\n'), reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined };
}

export function makeApi(token, { fetch: f = fetch, base = API } = {}) {
  const root = String(base || API).replace(/\/+$/, '');
  return {
    async call(method, body = null, { signal = undefined } = {}) {
      const res = await f(`${root}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal,
      });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) {
        const e = new Error(data?.description || `${method} failed with ${res.status}`);
        e.code = data?.error_code ?? res.status;
        e.retryAfter = data?.parameters?.retry_after ?? null;
        throw e;
      }
      return data.result;
    },
    // Files are fetched from a different prefix to the methods, and the path
    // comes from getFile rather than being constructible.
    async file(path) {
      const res = await f(`${root}/file/bot${token}/${path}`);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// The shape directory.js already expects, so that file does not learn there
// are two kinds of Telegram connection. `photo` is a boolean there and bytes
// here, which is the same split the MTProto client has.
export function makeBotDirectoryClient(api) {
  return {
    async getEntity(id) {
      const chat = await api.call('getChat', { chat_id: Number(id) || id });
      return {
        firstName: chat.first_name || '',
        lastName: chat.last_name || '',
        username: chat.username || '',
        title: chat.title || '',
        photo: Boolean(chat.photo),
      };
    },
    async downloadProfilePhoto(id) {
      const chat = await api.call('getChat', { chat_id: Number(id) || id });
      const fileId = chat?.photo?.small_file_id;
      if (!fileId) return null;
      const file = await api.call('getFile', { file_id: fileId });
      if (!file?.file_path) return null;
      return api.file(file.file_path);
    },
  };
}

// Pure: which of an update's several shapes we act on. Exported because it is
// the one judgement here that is worth testing on its own — everything else in
// this file is a polling loop.
export function commandIn(update) {
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!text.startsWith('/')) return null;
  // `/stop@thebot` in a group is still /stop.
  const [first, ...rest] = text.split(/\s+/);
  const word = first.split('@')[0].toLowerCase();
  return { name: word, args: rest.join(' '), chat: message.chat?.id, from: message.from };
}

export async function connect(config, {
  onPosition,
  onForget = null,
  // Given a Telegram id, returns a link that will sign that person in, or
  // null if they are not somebody who may look. The bot does not know what
  // the list is or how a link is made; it only carries the answer.
  onLogin = null,
  // Circles, when there is a database to keep them in: { seen, invite,
  // redeem, circleOf, revoke }. Absent, the circle commands say so.
  circle = null,
  directory = null,
  log = console,
  fetch: f = fetch,
  // Exposed so a test can run the loop without waiting on a real long poll.
  poll = 50,
} = {}) {
  const api = makeApi(config.botToken, { fetch: f, base: config.telegramApi });

  const me = await api.call('getMe');
  log.info(`bot: signed in as @${me.username}`);

  // A webhook and getUpdates are mutually exclusive, and a webhook left over
  // from an experiment makes every poll fail with 409 and no obvious cause.
  await api.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});

  const wanted = new Set((config.chats || []).map(String));
  const allowed = (chatId) => wanted.size === 0 || wanted.has(String(chatId ?? ''));

  let offset = 0;
  let running = true;
  let inFlight = null;

  const say = (chat, text) =>
    api.call('sendMessage', { chat_id: chat, text, disable_notification: true })
      .catch((e) => log.error('bot: cannot reply —', e.message));

  const whoIs = (from) => ({
    id: String(from.id),
    name: [from.first_name, from.last_name].filter(Boolean).join(' '),
    username: from.username || '',
  });

  async function showCircle(chat, id, edit = null) {
    const view = circleView(circle.circleOf(id));
    if (edit) {
      await api.call('editMessageText', { chat_id: chat, message_id: edit, text: view.text, reply_markup: view.reply_markup })
        .catch(() => say(chat, view.text));
    } else {
      await api.call('sendMessage', { chat_id: chat, text: view.text, reply_markup: view.reply_markup, disable_notification: true })
        .catch((e) => log.error('bot: cannot reply —', e.message));
    }
  }

  // A button under /circle. Only ever acts for the person who pressed it:
  // `from` is Telegram's word for who that was, and a forwarded message's
  // buttons pressed by somebody else act for them, not for its author.
  async function pressed(query) {
    const action = circleAction(query.data);
    const me = String(query.from.id);
    if (circle && action) {
      if (action.kind === 'rm') await circle.revoke(me, action.id);
      else await circle.revoke(action.id, me);
    }
    await api.call('answerCallbackQuery', { callback_query_id: query.id, text: action ? 'Done.' : '' }).catch(() => {});
    if (circle && query.message) await showCircle(query.message.chat.id, me, query.message.message_id);
  }

  async function handle(update) {
    if (update.callback_query) {
      if (circle && update.callback_query.from && !update.callback_query.from.is_bot) {
        await circle.seen(whoIs(update.callback_query.from));
      }
      await pressed(update.callback_query);
      return;
    }

    // Everybody the bot hears from is recorded, which is what lets them sign
    // in and see themselves. Bots are not people.
    const from = (update.message || update.edited_message)?.from;
    if (circle && from && !from.is_bot) await circle.seen(whoIs(from));

    const command = commandIn(update);
    if (command) {
      const token = invitePayload(command);
      if (token) {
        const joiner = whoIs(command.from);
        const owner = circle ? await circle.redeem(token, joiner.id) : null;
        if (!owner) {
          await say(command.chat, 'That invite has been used or has expired. Ask for a new one.');
        } else if (owner.id === joiner.id) {
          await say(command.chat, 'That is your own invite — send it to the person who should see you.');
        } else {
          await say(command.chat, `You can now see ${nameOf(owner)}. /login opens the map.`);
          // The person who made the link is told who used it: an invite that
          // leaked should not add somebody silently.
          await say(owner.id, `${nameOf(joiner)} can now see you. /circle to change that.`);
        }
        return;
      }
      if (command.name === '/start' || command.name === '/help') {
        await say(command.chat, command.name === '/start' ? WELCOME : HELP);
        return;
      }
      if (command.name === '/invite') {
        if (!circle) { await say(command.chat, 'Sharing with other people needs the database this service is running without.'); return; }
        const t = await circle.invite(String(command.from.id));
        await say(command.chat, [
          'Send this to one person you want to be able to see you. It works once, for a day:',
          '',
          inviteLink(me.username, t),
          '',
          'They can see you until you take it back with /circle.',
        ].join('\n'));
        return;
      }
      if (command.name === '/pair') {
        const code = circle?.pair ? circle.pair(String(command.from.id)) : null;
        await say(command.chat, code
          ? `Enter ${code.slice(0, 3)} ${code.slice(3)} in the livegeo app on your watch. It works once, for five minutes.`
          : 'Pairing a watch needs the database this service is running without.');
        return;
      }
      if (command.name === '/circle') {
        if (!circle) { await say(command.chat, 'Circles need the database this service is running without.'); return; }
        await showCircle(command.chat, String(command.from.id));
        return;
      }
      if (command.name === '/login') {
        const link = onLogin ? await onLogin(String(command.from?.id ?? '')) : null;
        // Somebody not on the list is told no, rather than being given a link
        // that fails when they open it.
        await say(command.chat, link
          ? `${link}\n\nOpens once, and only for the next few minutes.`
          : 'Your account is not on the list of who may see the map.');
        return;
      }
      if (command.name === '/stop') {
        const id = String(command.from?.id ?? '');
        // Counted, not named, for the same reason the history cleaner counts:
        // these logs are read in places a Telegram id should not be.
        log.info('bot: someone asked to be forgotten');
        if (id && onForget) { try { await onForget(id); } catch (e) { log.error('forget:', e.message); } }
        await say(command.chat, 'Stopped. You are no longer shown, and the path held about you is deleted.');
        return;
      }
      return;
    }

    const position = fromUpdate(update);
    if (!position) return;
    if (!allowed(position.chat)) return;
    log.info(`bot: ${position.stopped ? 'someone stopped sharing' : 'a position arrived'}`);
    try { onPosition(position); } catch (e) { log.error('handler:', e.message); }
  }

  async function loop() {
    while (running) {
      try {
        // The long poll returns as soon as there is anything, and after
        // `poll` seconds otherwise — so this is not a busy wait even though
        // it reads like one.
        inFlight = api.call('getUpdates', {
          offset,
          timeout: poll,
          allowed_updates: ['message', 'edited_message', 'callback_query'],
        });
        const updates = await inFlight;
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handle(update);
        }
        // A turn of the event loop, unconditionally. Awaiting a promise that
        // is already resolved only drains the microtask queue, so if the API
        // ever answers instantly — a proxy returning an empty result, a
        // timeout of zero — this loop would spin at full speed and starve
        // every timer in the process, including the ones it needs itself.
        await new Promise((r) => setImmediate(r));
      } catch (e) {
        if (!running) return;
        // 429 carries how long to wait; anything else gets a flat pause so a
        // sustained outage does not turn into a request flood.
        const wait = e.retryAfter ? e.retryAfter * 1000 : 5000;
        log.error(`bot: ${e.message} — retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  const done = loop();

  return {
    api,
    client: makeBotDirectoryClient(api),
    me,
    // The bot can speak as well as listen, which is what makes an arrival
    // alert possible at all. A private chat's id is the person's own id, and
    // Telegram refuses a message to somebody who has never started the bot —
    // so this returns false rather than throwing, and the caller carries on.
    notify: async (chatId, text) => {
      try {
        await api.call('sendMessage', { chat_id: chatId, text });
        return true;
      } catch (e) {
        log.error('bot: cannot notify —', e.message);
        return false;
      }
    },
    inviteLink: (token) => inviteLink(me.username, token),
    stop: async () => { running = false; await Promise.allSettled([done, inFlight]); },
  };
}
