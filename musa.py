# Importing libraries and modules
import os
import discord
from discord.ext import commands
from discord import app_commands
import yt_dlp
from collections import deque
import asyncio
from typing import Optional

async def _safe_reply(interaction: discord.Interaction, content: str, ephemeral: bool = True):
    try:
        if interaction.response.is_done():
            try:
                await interaction.edit_original_response(content=content)
            except discord.NotFound:
                await interaction.followup.send(content, ephemeral=ephemeral)
        else:
            await interaction.response.send_message(content, ephemeral=ephemeral)
    except Exception as e:
        try:
            await interaction.channel.send(content)
        except Exception:
            print("Reply error:", e)

TOKEN = os.getenv("DISCORD_TOKEN")
COOKIES_PATH = os.getenv("YTDLP_COOKIES")

SONG_QUEUES = {}

async def search_ytdlp_async(query, ydl_opts):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: _extract(query, ydl_opts))

def _extract(query, ydl_opts):
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(query, download=False)

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True 

bot = commands.Bot(command_prefix="!", intents=intents)

@bot.event
async def on_ready():
    await bot.tree.sync()
    print(f"{bot.user} is online!")


@bot.tree.command(name="skip", description="Skips the current playing song")
async def skip(interaction: discord.Interaction):
    if interaction.guild.voice_client and (interaction.guild.voice_client.is_playing() or interaction.guild.voice_client.is_paused()):
        interaction.guild.voice_client.stop()
        await _safe_reply(interaction, "Skipped the current song.")
    else:
        await _safe_reply(interaction, "Not playing anything to skip.")


@bot.tree.command(name="pause", description="Pause the currently playing song.")
async def pause(interaction: discord.Interaction):
    voice_client = interaction.guild.voice_client

    # Check if the bot is in a voice channel
    if voice_client is None:
        return await _safe_reply(interaction, "I'm not in a voice channel.")

    # Check if something is actually playing
    if not voice_client.is_playing():
        return await _safe_reply(interaction, "Nothing is currently playing.")
    
    # Pause the track
    voice_client.pause()
    await _safe_reply(interaction, "Playback paused!")


@bot.tree.command(name="resume", description="Resume the currently paused song.")
async def resume(interaction: discord.Interaction):
    voice_client = interaction.guild.voice_client

    # Check if the bot is in a voice channel
    if voice_client is None:
        return await _safe_reply(interaction, "I'm not in a voice channel.")

    # Check if it's actually paused
    if not voice_client.is_paused():
        return await _safe_reply(interaction, "I’m not paused right now.")
    
    # Resume playback
    voice_client.resume()
    await _safe_reply(interaction, "Playback resumed!")


@bot.tree.command(name="stop", description="Stop playback and clear the queue.")
async def stop(interaction: discord.Interaction):
    # Defer ASAP, mas não explodir se já tiver respondido
    if not interaction.response.is_done():
        try:
            await interaction.response.defer(ephemeral=True, thinking=False)
        except Exception:
            pass

    vc = interaction.guild.voice_client

    if not vc or not vc.is_connected():
        await _safe_reply(interaction, "I'm not connected to any voice channel.")
        return

    # Clear queue
    gid = str(interaction.guild_id)
    if gid in SONG_QUEUES:
        SONG_QUEUES[gid].clear()

    # Stop play if needed
    try:
        if vc.is_playing() or vc.is_paused():
            vc.stop()
    except Exception:
        pass

    # Disconnect with timeout
    try:
        await asyncio.wait_for(vc.disconnect(), timeout=5)
    except asyncio.TimeoutError:
        await _safe_reply(interaction, "Stopped playback but disconnect timed out. Try again.")
        return
    except Exception as e:
        await _safe_reply(interaction, f"Stopped playback but error on disconnect: `{e}`")
        return

    await _safe_reply(interaction, "Stopped playback and disconnected!")


@bot.tree.command(name="play", description="Play a song or add it to the queue.")
@app_commands.describe(song_query="Search query")
async def play(interaction: discord.Interaction, song_query: str):
    await interaction.response.defer()

    voice_channel = interaction.user.voice.channel

    if voice_channel is None:
        await interaction.followup.send("You must be in a voice channel.")
        return

    voice_client = interaction.guild.voice_client

    if voice_client is None:
        voice_client = await voice_channel.connect()
    elif voice_channel != voice_client.channel:
        await voice_client.move_to(voice_channel)

    ydl_options = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "default_search": "ytsearch1",
        "ignore_no_formats_error": True,
        "geo_bypass": True,
        "source_address": "0.0.0.0",
        "retries": 2,
        # use alternate clients when the web client yields only images/no formats
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "web", "tv"]
            }
        },
        # a UA helps with some edge cases
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        }
    }
    if COOKIES_PATH:
        ydl_options["cookiefile"] = COOKIES_PATH

    query = f"ytsearch1:{song_query}".strip()
    try:
        results = await search_ytdlp_async(query, ydl_options)
    except Exception:
        # first fallback: same query with permissive format (already set)
        fallback_opts = dict(ydl_options)
        results = await search_ytdlp_async(query, fallback_opts)

    # If we got a search result but it has no usable formats (common 'images only'),
    # retry using YouTube Music search (ytmsearch) which often returns playable m4a.
    def _has_formats(obj) -> bool:
        if isinstance(obj, dict):
            if obj.get("formats"):
                return True
            if obj.get("entries"):
                for e in obj["entries"]:
                    if e and e.get("formats"):
                        return True
        return False

    if not _has_formats(results):
        try:
            ytm_opts = dict(ydl_options)
            ytm_opts["default_search"] = "ytmsearch1"
            results = await search_ytdlp_async(f"ytmsearch1:{song_query}", ytm_opts)
        except Exception:
            pass

    tracks = []
    if isinstance(results, dict) and results.get("entries"):
        tracks = [e for e in results["entries"] if e]
    elif results:
        tracks = [results]

    if not tracks:
        await interaction.followup.send("No results found.")
        return

    first = tracks[0] or {}

    # Não suportar ao vivo
    if first.get("is_live"):
        await interaction.followup.send("Live streams are not supported.")
        return

    title = first.get("title") or first.get("webpage_url") or "Untitled"

    # 1) Tenta usar 'formats' para achar um stream de áudio válido
    audio_url = None
    fmts = first.get("formats") or []
    if fmts:
        # preferir áudio puro com opus/m4a e protocolo https
        def score(f):
            # discard if no url or has video
            if f.get("vcodec") not in (None, "none"):
                return -1
            if not f.get("url"):
                return -1
            s = 0
            # prefer common audio codecs/containers
            ac = (f.get("acodec") or "").lower()
            ext = (f.get("ext") or "").lower()
            proto = (f.get("protocol") or "")
            if ac.startswith(("opus", "vorbis")): s += 6
            if ac.startswith(("mp4a", "aac")): s += 5
            if ext in ("webm", "m4a"): s += 5
            if proto.startswith("https"): s += 3
            elif proto.startswith("http"): s += 1
            # higher abr is better
            try: s += int(f.get("abr") or 0)
            except Exception: pass
            return s

        best = sorted(fmts, key=score, reverse=True)
        for f in best:
            if f.get("vcodec") in (None, "none") and f.get("url"):
                audio_url = f["url"]
                break

    # 2) Fallback: usar 'url' direto que o yt-dlp já colocou (às vezes já é stream)
    if not audio_url:
        audio_url = first.get("url") or first.get("webpage_url")

    if not audio_url:
        await interaction.followup.send("Couldn't extract a playable stream (no audio formats).")
        return

    if "googleusercontent.com/thumbnail" in audio_url or "storyboard" in audio_url:
        await interaction.followup.send("Esse resultado do YouTube não expôs áudio (somente imagens). Tente outra faixa ou use 'ytmsearch1:' antes do termo.", ephemeral=True)
        return

    guild_id = str(interaction.guild_id)
    if SONG_QUEUES.get(guild_id) is None:
        SONG_QUEUES[guild_id] = deque()

    SONG_QUEUES[guild_id].append((audio_url, title))

    if voice_client.is_playing() or voice_client.is_paused():
        await interaction.followup.send(f"Added to queue: **{title}**")
    else:
        await interaction.followup.send(f"Now playing: **{title}**")
        await play_next_song(voice_client, guild_id, interaction.channel)


async def play_next_song(voice_client, guild_id, channel):
    if SONG_QUEUES[guild_id]:
        audio_url, title = SONG_QUEUES[guild_id].popleft()

        ffmpeg_options = {
            "before_options": "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
            "options": "-vn"
        }

        source = discord.FFmpegOpusAudio(audio_url, **ffmpeg_options, executable="ffmpeg")

        def after_play(error):
            if error:
                print(f"Error playing {title}: {error}")
            asyncio.run_coroutine_threadsafe(play_next_song(voice_client, guild_id, channel), bot.loop)

        voice_client.play(source, after=after_play)
        asyncio.create_task(channel.send(f"Now playing: **{title}**"))
    else:
        await voice_client.disconnect()
        SONG_QUEUES[guild_id] = deque()


@bot.tree.command(name="formats", description="(Debug) Lista alguns formatos de áudio para uma URL do YouTube")
@app_commands.describe(url="URL completa do vídeo")
async def formats(inter: discord.Interaction, url: str):
    await inter.response.defer(ephemeral=True)
    try:
        info = await search_ytdlp_async(url, {"quiet": True, "no_warnings": True, "extract_flat": False, "retries": 1, **({"cookiefile": COOKIES_PATH} if COOKIES_PATH else {})})
    except Exception as e:
        return await inter.followup.send(f"Erro ao extrair: `{e}`", ephemeral=True)
    fmts = (info or {}).get("formats") or []
    if not fmts:
        return await inter.followup.send("Sem formats retornados.", ephemeral=True)
    # mostre os 10 melhores candidatos segundo a mesma métrica
    def score(f):
        if f.get("vcodec") not in (None, "none"): return -1
        if not f.get("url"): return -1
        s = 0
        ac = (f.get("acodec") or "").lower()
        ext = (f.get("ext") or "").lower()
        proto = (f.get("protocol") or "")
        if ac.startswith(("opus", "vorbis")): s += 6
        if ac.startswith(("mp4a", "aac")): s += 5
        if ext in ("webm", "m4a"): s += 5
        if proto.startswith("https"): s += 3
        elif proto.startswith("http"): s += 1
        try: s += int(f.get("abr") or 0)
        except Exception: pass
        return s
    best = sorted(fmts, key=score, reverse=True)[:10]
    lines = []
    for f in best:
        lines.append(f"{f.get('format_id')} | {f.get('ext')} | {f.get('acodec')} | {f.get('abr')}kbps | {f.get('protocol')}")
    await inter.followup.send("Top formatos de áudio:\n```\n" + "\n".join(lines) + "\n```", ephemeral=True)


# Run the bot
bot.run(TOKEN)