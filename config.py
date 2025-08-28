import os

TOKEN = os.getenv("DISCORD_TOKEN")
COOKIES_PATH = os.getenv("YTDLP_COOKIES")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
