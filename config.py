import os

# Discord Bot Configuration
TOKEN = os.getenv("DISCORD_TOKEN")

# YouTube Service Configuration (now in standby mode)
COOKIES_PATH = os.getenv("YTDLP_COOKIES")
YTDLP_PROXY = os.getenv("YTDLP_PROXY")

# Multi-Source Configuration
ENABLE_YOUTUBE = os.getenv("ENABLE_YOUTUBE", "false").lower() == "true"
ENABLE_INTERNET_ARCHIVE = os.getenv("ENABLE_INTERNET_ARCHIVE", "true").lower() == "true"
ENABLE_RADIO = os.getenv("ENABLE_RADIO", "true").lower() == "true"

# Service Priorities (lower number = higher priority)
YOUTUBE_PRIORITY = int(os.getenv("YOUTUBE_PRIORITY", "1"))
INTERNET_ARCHIVE_PRIORITY = int(os.getenv("INTERNET_ARCHIVE_PRIORITY", "2"))
RADIO_PRIORITY = int(os.getenv("RADIO_PRIORITY", "3"))

# Logging Configuration
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# Multi-Source Behavior Configuration
MAX_RESULTS_PER_SOURCE = int(os.getenv("MAX_RESULTS_PER_SOURCE", "3"))
SEARCH_TIMEOUT_SECONDS = int(os.getenv("SEARCH_TIMEOUT_SECONDS", "10"))
FALLBACK_TO_RADIO = os.getenv("FALLBACK_TO_RADIO", "true").lower() == "true"
