import discord
from discord.ext import commands
from discord import app_commands
from collections import deque
import asyncio

from utils.logging import log_event
from utils.discord_utils import safe_reply
from services.youtube import extract_audio, search_ytdlp_async
from config import COOKIES_PATH

class MusicCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.song_queues = {}
        self.populate_tasks = {}

    async def _populate_queue(self, generator, guild_id):
        try:
            async for audio_url, title in generator:
                if guild_id not in self.song_queues:
                    break  # Stop if the queue has been cleared
                log_event("enqueue_background", guild_id=guild_id, title=title)
                self.song_queues[guild_id].append((audio_url, title))
        except Exception as e:
            log_event("populate_queue_error", error=str(e))
        finally:
            if guild_id in self.populate_tasks:
                del self.populate_tasks[guild_id]

    async def play_next_song(self, voice_client, guild_id, channel):
        if self.song_queues.get(guild_id):
            audio_url, title = self.song_queues[guild_id].popleft()
            log_event("dequeue", guild_id=guild_id, title=title, audio_url=audio_url)

            ffmpeg_options = {
                "before_options": (
                    "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 "
                    '-headers "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\nAccept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\r\n"'
                ),
                "options": "-vn"
            }
            log_event("ffmpeg_options", options=ffmpeg_options)

            source = discord.FFmpegOpusAudio(audio_url, **ffmpeg_options, executable="ffmpeg")

            def after_play(error):
                if error:
                    log_event("ffmpeg_error", title=title, error=str(error))
                asyncio.run_coroutine_threadsafe(self.play_next_song(voice_client, guild_id, channel), self.bot.loop)

            voice_client.play(source, after=after_play)
            log_event("now_playing_sent", title=title)
            await channel.send(f"Now playing: **{title}**")
        else:
            log_event("queue_empty_disconnect", guild_id=guild_id)
            await voice_client.disconnect()
            if guild_id in self.song_queues:
                self.song_queues[guild_id].clear()


    @app_commands.command(name="play", description="Play a song or add it to the queue.")
    @app_commands.describe(song_query="Search query or URL")
    async def play(self, interaction: discord.Interaction, song_query: str):
        await interaction.response.defer()
        log_event(
            "play_called",
            guild_id=interaction.guild_id,
            channel_id=getattr(interaction.channel, "id", None),
            user_id=getattr(interaction.user, "id", None),
            query=song_query,
        )

        voice_channel = interaction.user.voice.channel
        if voice_channel is None:
            await interaction.followup.send("You must be in a voice channel.")
            return

        voice_client = interaction.guild.voice_client
        if voice_client is None:
            voice_client = await voice_channel.connect()
        elif voice_channel != voice_client.channel:
            await voice_client.move_to(voice_channel)

        guild_id = str(interaction.guild_id)
        if self.song_queues.get(guild_id) is None:
            self.song_queues[guild_id] = deque()

        song_generator = extract_audio(song_query)

        try:
            first_song = await anext(song_generator)
        except StopAsyncIteration:
            await interaction.followup.send(f"No results found for: **{song_query}**")
            return

        self.song_queues[guild_id].append(first_song)
        log_event("enqueue", guild_id=guild_id, title=first_song[1])

        is_playlist = "list=" in song_query
        if is_playlist:
            # Cancel any previous populate task for this guild
            if guild_id in self.populate_tasks:
                self.populate_tasks[guild_id].cancel()
            
            self.populate_tasks[guild_id] = asyncio.create_task(self._populate_queue(song_generator, guild_id))
            await interaction.followup.send(f"Added playlist to queue. Starting with: **{first_song[1]}**")
        else:
            if voice_client.is_playing() or voice_client.is_paused():
                await interaction.followup.send(f"Added to queue: **{first_song[1]}**")
            else:
                await interaction.followup.send(f"Now playing: **{first_song[1]}**")

        if not (voice_client.is_playing() or voice_client.is_paused()):
            await self.play_next_song(voice_client, guild_id, interaction.channel)

    @app_commands.command(name="skip", description="Skips the current playing song")
    async def skip(self, interaction: discord.Interaction):
        if interaction.guild.voice_client and (interaction.guild.voice_client.is_playing() or interaction.guild.voice_client.is_paused()):
            log_event("skip", guild_id=interaction.guild_id, channel_id=getattr(interaction.channel, "id", None))
            interaction.guild.voice_client.stop()
            await safe_reply(interaction, "Skipped the current song.")
        else:
            log_event("skip_noop", guild_id=interaction.guild_id, reason="no_playback")
            await safe_reply(interaction, "Not playing anything to skip.")

    @app_commands.command(name="pause", description="Pause the currently playing song.")
    async def pause(self, interaction: discord.Interaction):
        voice_client = interaction.guild.voice_client
        if voice_client and voice_client.is_playing():
            voice_client.pause()
            log_event("paused", guild_id=interaction.guild_id)
            await safe_reply(interaction, "Playback paused!")
        else:
            log_event("pause_noop", guild_id=interaction.guild_id)
            await safe_reply(interaction, "Nothing is currently playing to pause.")

    @app_commands.command(name="resume", description="Resume the currently paused song.")
    async def resume(self, interaction: discord.Interaction):
        voice_client = interaction.guild.voice_client
        if voice_client and voice_client.is_paused():
            voice_client.resume()
            log_event("resumed", guild_id=interaction.guild_id)
            await safe_reply(interaction, "Playback resumed!")
        else:
            log_event("resume_noop", guild_id=interaction.guild_id)
            await safe_reply(interaction, "I’m not paused right now.")

    @app_commands.command(name="stop", description="Stop playback and clear the queue.")
    async def stop(self, interaction: discord.Interaction):
        if not interaction.response.is_done():
            try:
                await interaction.response.defer(ephemeral=True, thinking=False)
            except Exception:
                pass
        
        gid = str(interaction.guild_id)
        log_event("stop_called", guild_id=gid, channel_id=getattr(interaction.channel, "id", None))

        # Cancel any running populate task
        if gid in self.populate_tasks:
            self.populate_tasks[gid].cancel()
            del self.populate_tasks[gid]

        vc = interaction.guild.voice_client
        if not vc or not vc.is_connected():
            log_event("stop_no_voice", guild_id=gid)
            await safe_reply(interaction, "I'm not connected to any voice channel.")
            return

        # Clear queue
        if gid in self.song_queues:
            self.song_queues[gid].clear()
        log_event("queue_cleared", guild_id=gid)

        # Stop play if needed
        if vc.is_playing() or vc.is_paused():
            log_event("stopping_playback", guild_id=gid)
            vc.stop()

        # Disconnect
        try:
            await asyncio.wait_for(vc.disconnect(), timeout=5)
            log_event("disconnected", guild_id=gid)
        except asyncio.TimeoutError:
            log_event("disconnect_timeout", guild_id=gid)
            await safe_reply(interaction, "Stopped playback but disconnect timed out.")
            return
        except Exception as e:
            log_event("disconnect_error", guild_id=gid, error=str(e))
            await safe_reply(interaction, f"Stopped playback but error on disconnect: `{e}`")
            return

        await safe_reply(interaction, "Stopped playback and disconnected!")

    @app_commands.command(name="formats", description="(Debug) Lista alguns formatos de áudio para uma URL do YouTube")
    @app_commands.describe(url="URL completa do vídeo")
    async def formats(self, inter: discord.Interaction, url: str):
        await inter.response.defer(ephemeral=True)
        log_event("formats_called", url=url, guild_id=inter.guild_id)
        try:
            info = await search_ytdlp_async(url, {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": False,
                "retries": 1,
                "http_headers": {
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
                },
                "extractor_args": {
                    "youtube": { "player_client": ["android", "ios", "web", "tv"] }
                },
                **({"cookiefile": COOKIES_PATH} if COOKIES_PATH else {})
            })
        except Exception as e:
            return await inter.followup.send(f"Erro ao extrair: `{e}`", ephemeral=True)
        
        fmts = (info or {}).get("formats") or []
        if not fmts:
            return await inter.followup.send("Sem formats retornados.", ephemeral=True)

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
        log_event("formats_list", count=len(best))
        
        lines = []
        for f in best:
            lines.append(f"{f.get('format_id')} | {f.get('ext')} | {f.get('acodec')} | {f.get('abr')}kbps | {f.get('protocol')}")
        
        await inter.followup.send("Top formatos de áudio:\n```\n" + "\n".join(lines) + "\n```", ephemeral=True)

async def setup(bot):
    await bot.add_cog(MusicCog(bot))