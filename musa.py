import discord
from discord.ext import commands
import asyncio

from config import TOKEN
from utils.logging import log_event

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True

bot = commands.Bot(command_prefix="!", intents=intents)

@bot.event
async def on_ready():
    await bot.tree.sync()
    print(f"{bot.user} is online!")
    log_event("ready", user=str(bot.user), user_id=getattr(bot.user, "id", None))
    await bot.change_presence(
        status=discord.Status.online,
        activity=discord.Activity(type=discord.ActivityType.listening, name="um silêncio ensurdecedor")
    )

async def main():
    async with bot:
        await bot.load_extension("cogs.music")
        await bot.start(TOKEN)

if __name__ == "__main__":
    asyncio.run(main())
