#!/usr/bin/env node
// login.mjs — run once, interactively, to turn a phone number into a session
// string. Everything after that is non-interactive, which is what lets the
// service run unattended.
//
//   TELEGRAM_API_ID=… TELEGRAM_API_HASH=… npm run login
//
// It prints a session string. Put it in TELEGRAM_SESSION and keep it as
// carefully as the account password: it *is* a logged-in session.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (my.telegram.org → API development tools).');
  process.exit(1);
}

const rl = createInterface({ input, output });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
client.setLogLevel('error');

await client.start({
  phoneNumber: () => rl.question('Phone number (with country code): '),
  phoneCode: () => rl.question('Code Telegram just sent you: '),
  password: () => rl.question('Two-step password (blank if none): '),
  onError: (e) => console.error(e && e.message ? e.message : e),
});

console.log('\nSigned in. Put this in TELEGRAM_SESSION:\n');
console.log(client.session.save());
console.log('\nTreat it like a password: anyone holding it is signed in as you.\n');

await rl.close();
await client.destroy();
process.exit(0);
