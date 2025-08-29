import os

TOKEN = os.getenv("DISCORD_TOKEN")
COOKIES_PATH = os.getenv("YTDLP_COOKIES")
YTDLP_PROXY = os.getenv("YTDLP_PROXY")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
