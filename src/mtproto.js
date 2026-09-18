// mtproto.js — the only file in this service that talks to Telegram.
//
// It is deliberately thin. Everything it receives is handed straight to
// positions.fromMessage, which is pure and covered by the tests; what is left
// here is connection and event wiring, which can only really be exercised
// against Telegram itself.
//
// Why MTProto and not the Bot API: a bot is only told about live locations
// shared with the bot. A user account is told about live locations shared in
// any chat it is in. Neither can see a location nobody chose to share.

import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { fromMessage, chatOf } from './positions.js';

export async function connect(config, { onPosition, directory = null, log = console }) {
  const client = new TelegramClient(
    new StringSession(config.session),
    config.apiId,
    config.apiHash,
    { connectionRetries: 10, autoReconnect: true, retryDelay: 2000 }
  );
  client.setLogLevel('error');

  await client.start({
    // The session already carries the login; these only run if it is empty,
    // in which case the operator should have used `npm run login` instead.
    phoneNumber: async () => { throw new Error('session is empty — run `npm run login` first'); },
    password: async () => { throw new Error('session is empty — run `npm run login` first'); },
    phoneCode: async () => { throw new Error('session is empty — run `npm run login` first'); },
    onError: (e) => log.error('telegram:', e && e.message ? e.message : e),
  });

  const me = await client.getMe();
  log.info(`signed in as ${me.username ? '@' + me.username : me.firstName || me.id}`);

  // From here the dashboard can turn a sender id into a name and a photo.
  // Before this point it answers "unknown" rather than making the page wait.
  directory?.attach(client);

  const wanted = new Set(config.chats.map(String));
  const allowed = (message) => wanted.size === 0 || wanted.has(String(chatOf(message) ?? ''));

  // A live location is one message that is then edited, so both the first
  // message and every edit of it carry a position. Telegram delivers the
  // edits as UpdateEditMessage / UpdateEditChannelMessage.
  const handle = (message, via) => {
    if (!message || !allowed(message)) return;
    const position = fromMessage(message);
    if (!position) return;
    log.info(`${via}: ${position.id} ${position.stopped ? 'stopped sharing' : `${position.latitude},${position.longitude}`}`);
    try { onPosition(position); } catch (e) { log.error('handler:', e); }
  };

  client.addEventHandler((update) => {
    if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
      handle(update.message, 'edit');
      return;
    }
    if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
      handle(update.message, 'new');
    }
  });

  // What was already being shared before this process started: Telegram only
  // sends updates from now on, so without this a restart forgets everyone
  // until their next move.
  async function backfill() {
    for (const chat of config.chats) {
      try {
        const res = await client.invoke(new Api.messages.GetRecentLocations({
          peer: chat, limit: 50, hash: 0,
        }));
        for (const message of res.messages || []) handle(message, 'backfill');
      } catch (e) {
        log.error(`backfill ${chat}:`, e && e.message ? e.message : e);
      }
    }
  }
  await backfill();

  return {
    client,
    stop: () => client.destroy().catch(() => {}),
  };
}
