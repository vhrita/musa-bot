import { Client, GatewayIntentBits, TextChannel, Events } from 'discord.js';
import 'dotenv/config';

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.MUSA_CHANNEL_ID;

  if (!token || !channelId) {
    console.error('DISCORD_TOKEN and MUSA_CHANNEL_ID are required in environment');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user?.tag}`);
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch || !ch.isTextBased()) {
        throw new Error('Channel is not text-based or not found');
      }
      const channel = ch as TextChannel;

      // Unpin ALL pinned messages first (we will delete everything, including pins)
      const pinnedAny: any = await (channel.messages as any).fetchPins();
      const pinsList: any[] = [];
      if (pinnedAny && typeof pinnedAny.forEach === 'function') {
        pinnedAny.forEach((m: any) => pinsList.push(m));
      } else if (Array.isArray(pinnedAny)) {
        pinsList.push(...pinnedAny);
      } else if (pinnedAny?.messages && typeof pinnedAny.messages.forEach === 'function') {
        pinnedAny.messages.forEach((m: any) => pinsList.push(m));
      }
      for (const m of pinsList) {
        try { await m.unpin?.(); } catch {}
      }

      let totalDeleted = 0;
      let batch = 0;
      let before: string | undefined = undefined;

      while (true) {
        // Fetch the latest 100 messages, optionally paginating before a cursor
        const fetchOpts: any = { limit: 100 };
        if (before) fetchOpts.before = before;
        const raw: any = await (channel.messages as any).fetch(fetchOpts);
        // Normalize to array of messages
        const list: any[] = raw && typeof raw.values === 'function' ? Array.from(raw.values())
          : Array.isArray(raw) ? raw
          : raw ? [raw] : [];
        if (list.length === 0) break;

        // Delete ALL messages individually (robust across API versions)
        const targets = list;
        for (const m of targets) {
          try {
            await m.delete();
            totalDeleted += 1;
            if (totalDeleted % 25 === 0) console.log(`Deleted ${totalDeleted} so far...`);
          } catch {}
          await sleep(300); // gentle pacing to avoid rate limits
        }

        batch += 1;
        // Advance cursor to the oldest message in this page
        const oldest = list[list.length - 1];
        if (!oldest?.id) break;
        before = oldest.id as string;
        // Small pause before next fetch
        await sleep(800);
      }

      console.log(`Cleanup complete. Deleted ${totalDeleted} user messages in channel ${channelId}.`);
    } catch (err) {
      console.error('Cleanup failed:', (err as Error).message);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  await client.login(token);
}

run().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
