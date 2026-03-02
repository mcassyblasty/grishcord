import { loadConfig } from './config.js';
import { GrishcordClient } from './grishcordClient.js';
import { OllamaClient } from './ollamaClient.js';
import { NotificationBot } from './notificationBot.js';

async function main() {
  const config = loadConfig();
  const client = new GrishcordClient(config.grishcordBaseUrl);
  await client.login(config.botUsername, config.botPassword);
  const me = await client.me();
  console.log(`[aibot] authenticated as ${me.username} (#${me.id})`);

  const desiredDisplayName = process.env.BOT_DISPLAY_NAME || '';
  const desiredColor = process.env.BOT_COLOR || '';
  if (desiredDisplayName && (desiredDisplayName !== me.display_name || (desiredColor && desiredColor !== me.display_color))) {
    try {
      await client.patchProfile(desiredDisplayName, desiredColor || me.display_color || null);
      console.log('[aibot] applied configured profile values via API');
    } catch (err) {
      console.warn('[aibot] could not update profile via API:', err.message);
    }
  }

  const ollama = new OllamaClient(config.ollamaBaseUrl, config.ollamaModel, config.ollamaTimeoutMs);
  const bot = new NotificationBot({ config, client, ollama, botUserId: me.id });
  await bot.start();
}

main().catch((err) => {
  console.error('[aibot] fatal startup error', err.message);
  process.exit(1);
});
