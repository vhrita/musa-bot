import discord
from discord.ext import commands
from discord import app_commands
from collections import deque
import asyncio
import random

from utils.logging import log_event
from utils.discord_utils import safe_reply
from services.multi_source_manager import MultiSourceManager
from config import (
    ENABLE_YOUTUBE, ENABLE_INTERNET_ARCHIVE, ENABLE_RADIO,
    YOUTUBE_PRIORITY, INTERNET_ARCHIVE_PRIORITY, RADIO_PRIORITY
)

class MusicCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.song_queues = {}
        self.current_song = {}
        
        # Initialize multi-source manager
        self.music_manager = MultiSourceManager()
        
        # Configure services based on environment variables
        self._configure_services()

    def _configure_services(self):
        """Configure services based on environment variables."""
        # Configure service availability
        if not ENABLE_YOUTUBE:
            self.music_manager.disable_service("youtube")
        if not ENABLE_INTERNET_ARCHIVE:
            self.music_manager.disable_service("internet_archive")
        if not ENABLE_RADIO:
            self.music_manager.disable_service("radio")
        
        # Configure service priorities
        self.music_manager.set_service_priority("youtube", YOUTUBE_PRIORITY)
        self.music_manager.set_service_priority("internet_archive", INTERNET_ARCHIVE_PRIORITY)
        self.music_manager.set_service_priority("radio", RADIO_PRIORITY)
        
        log_event("music_cog_configured",
                 enabled_services=len(self.music_manager.get_enabled_services()))

    async def _set_activity(self, song, channel):
        activity = discord.Activity(
            type=discord.ActivityType.listening,
            name=song['title'],
            details=f"In: {channel.name}"
        )
        await self.bot.change_presence(activity=activity)

    async def _clear_activity(self):
        activity = discord.Activity(
            type=discord.ActivityType.listening, 
            name="um silêncio ensurdecedor"
        )
        await self.bot.change_presence(activity=activity)

    async def play_next_song(self, voice_client, guild_id, channel):
        if self.song_queues.get(guild_id):
            unresolved_song = self.song_queues[guild_id].popleft()
            log_event("play_next_song_processing", 
                     title=unresolved_song.get("title"),
                     service=unresolved_song.get("service"),
                     song_keys=list(unresolved_song.keys()) if isinstance(unresolved_song, dict) else None)
            
            # Use multi-source manager to resolve the song
            song = await self.music_manager.resolve_song_url(unresolved_song)

            if not song:
                log_event("resolve_failed", guild_id=guild_id, info=unresolved_song)
                # Try next song
                return await self.play_next_song(voice_client, guild_id, channel)

            self.current_song[guild_id] = song
            log_event("dequeue", guild_id=guild_id, title=song['title'], service=song.get('service'))

            await self._set_activity(song, channel)

            ffmpeg_options = {
                "before_options": (
                    "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 "
                    '-headers "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\n'
                    'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\r\n"'
                ),
                "options": "-vn"
            }
            
            # For live streams (radio), add additional options
            if song.get('is_live_stream'):
                ffmpeg_options['options'] += " -reconnect_streamed 1 -reconnect_delay_max 2"
                log_event("ffmpeg_live_stream_options", title=song['title'])
            
            log_event("ffmpeg_starting", 
                     url_domain=song['url'].split('/')[2] if '/' in song['url'] else None,
                     service=song.get('service'),
                     is_live=song.get('is_live_stream', False))

            source = discord.FFmpegOpusAudio(song['url'], **ffmpeg_options, executable="ffmpeg")

            def after_play(error):
                if error:
                    log_event("ffmpeg_error", title=song['title'], error=str(error), service=song.get('service'))
                else:
                    log_event("ffmpeg_finished", title=song['title'], service=song.get('service'))
                self.current_song.pop(guild_id, None)
                asyncio.run_coroutine_threadsafe(self.play_next_song(voice_client, guild_id, channel), self.bot.loop)

            voice_client.play(source, after=after_play)
            log_event("playback_started", title=song['title'], service=song.get('service'))
            
            # Show queue status with now playing + upcoming songs
            embed = await self._create_queue_embed(guild_id, "🎶 Now Playing", discord.Color.green())
            embed.set_footer(text="Use /play to add more songs • /queue to see full list")
            await channel.send(embed=embed)
        else:
            log_event("queue_empty_disconnect", guild_id=guild_id)
            await self._clear_activity()
            await voice_client.disconnect()
            if guild_id in self.song_queues:
                self.song_queues[guild_id].clear()
            self.current_song.pop(guild_id, None)

    def _get_service_emoji(self, service_name: str) -> str:
        """Get emoji for service type."""
        emojis = {
            "youtube": "🎥",
            "internet_archive": "📚",
            "radio": "📻",
        }
        return emojis.get(service_name, "🎵")

    async def _create_queue_embed(self, guild_id: str, title: str = "🎵 Music Queue", 
                                 color: discord.Color = discord.Color.blue()) -> discord.Embed:
        """Create a standardized queue embed used across commands."""
        # Get current playing song
        current_song = self.current_song.get(guild_id)
        
        # Get queue
        queue = self.song_queues.get(guild_id, deque())
        
        # Create main embed
        embed = discord.Embed(
            title=title,
            description=f"**{len(queue)}** songs in queue",
            color=color
        )
        
        # Add currently playing section
        if current_song:
            service_emoji = self._get_service_emoji(current_song.get('service'))
            current_title = current_song.get('title', 'Unknown')[:60]
            if len(current_song.get('title', '')) > 60:
                current_title += "..."
            
            current_info = f"{service_emoji} **{current_title}**"
            if current_song.get('is_live_stream'):
                current_info += " 🔴 LIVE"
            
            embed.add_field(
                name="🎶 Now Playing",
                value=current_info,
                inline=False
            )
        
        # Add upcoming songs section
        if queue:
            upcoming_songs = []
            for i, song in enumerate(list(queue)[:10], 1):  # Show up to 10 upcoming songs
                service_emoji = self._get_service_emoji(song.get('service'))
                title = song.get('title', 'Unknown')[:45]
                if len(song.get('title', '')) > 45:
                    title += "..."
                upcoming_songs.append(f"{i}. {service_emoji} {title}")
            
            upcoming_text = "\n".join(upcoming_songs)
            if len(queue) > 10:
                upcoming_text += f"\n... and **{len(queue) - 10}** more songs"
            
            embed.add_field(
                name="⏭️ Up Next",
                value=upcoming_text,
                inline=False
            )
        else:
            embed.add_field(
                name="⏭️ Up Next",
                value="No songs in queue",
                inline=False
            )
        
        return embed

    @app_commands.command(name="play", description="Play a song or add it to the queue.")
    @app_commands.describe(song_query="Search query or URL")
    async def play(self, interaction: discord.Interaction, song_query: str):
        """Play music from various sources (excluding radio)."""
        if not interaction.response.is_done():
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

        # Search for music in non-radio services only
        songs = []
        
        # Get enabled services excluding radio
        for service in self.music_manager.get_enabled_services():
            if service.name != 'radio':
                try:
                    # Check if service is available
                    if await service.is_available():
                        log_event("trying_music_service", 
                                 service_name=service.name, 
                                 priority=service.priority)
                        
                        service_results = await service.search(song_query)
                        if service_results:
                            # For music, only take the first (best) result
                            best_result = service_results[0]
                            songs.append(best_result)
                            log_event("music_search_success", 
                                     service_name=service.name,
                                     results_count=1,
                                     selected_title=best_result.get('title', 'Unknown'))
                            break  # Use first successful service (fallback behavior)
                    else:
                        log_event("music_service_unavailable", service_name=service.name)
                except Exception as e:
                    log_event("music_service_error", 
                             service_name=service.name, 
                             error=str(e))
                    continue

        if not songs:
            await interaction.followup.send(f"No results found for: **{song_query}**")
            return

        self.song_queues[guild_id].extend(songs)
        log_event("enqueue", guild_id=guild_id, count=len(songs))

        # Create embed showing the updated queue with added song
        embed = await self._create_queue_embed(guild_id)
        embed.color = discord.Color.green()
        
        # Add information about what was added
        song = songs[0]
        service_emoji = self._get_service_emoji(song.get('service'))
        title = song.get('title', 'Untitled')
        embed.add_field(
            name="✅ Song Added",
            value=f"{service_emoji} Added to queue: **{title}**",
            inline=False
        )
        
        embed.set_footer(text="🎵 Song added to queue • Music will start playing automatically")
        await interaction.followup.send(embed=embed)

        if not (voice_client.is_playing() or voice_client.is_paused()):
            await self.play_next_song(voice_client, guild_id, interaction.channel)

    @app_commands.command(name="shuffle", description="Shuffle the current playlist.")
    async def shuffle(self, interaction: discord.Interaction):
        guild_id = str(interaction.guild_id)
        if not self.song_queues.get(guild_id):
            return await safe_reply(interaction, "The queue is empty.")

        random.shuffle(self.song_queues[guild_id])
        log_event("shuffled", guild_id=guild_id)
        await safe_reply(interaction, "Queue shuffled!")

    @app_commands.command(name="skip", description="Skips the current playing song")
    async def skip(self, interaction: discord.Interaction):
        await interaction.response.defer()
        
        if interaction.guild.voice_client and (interaction.guild.voice_client.is_playing() or interaction.guild.voice_client.is_paused()):
            log_event("skip", guild_id=interaction.guild_id, channel_id=getattr(interaction.channel, "id", None))
            interaction.guild.voice_client.stop()
            
            # Give it a moment for the next song to start, then show queue
            await asyncio.sleep(1)
            guild_id = str(interaction.guild_id)
            embed = await self._create_queue_embed(guild_id, "⏭️ Skipped Song", discord.Color.orange())
            embed.set_footer(text="Use /play to add more songs • /queue to see full list")
            await interaction.followup.send(embed=embed)
        else:
            log_event("skip_noop", guild_id=interaction.guild_id, reason="no_playback")
            await interaction.followup.send("Not playing anything to skip.")

    @app_commands.command(name="pause", description="Pause the currently playing song.")
    async def pause(self, interaction: discord.Interaction):
        await interaction.response.defer()
        
        voice_client = interaction.guild.voice_client
        guild_id = str(interaction.guild_id)
        
        if voice_client and voice_client.is_playing():
            voice_client.pause()
            log_event("paused", guild_id=guild_id)
            
            # Show queue with pause status
            embed = await self._create_queue_embed(guild_id)
            embed.color = discord.Color.orange()
            embed.set_footer(text="⏸️ Playback PAUSED • Use /resume to continue")
            
            await interaction.followup.send(embed=embed)
        else:
            log_event("pause_noop", guild_id=guild_id)
            embed = discord.Embed(
                title="⏸️ Pause",
                description="Nothing is currently playing to pause.",
                color=discord.Color.red()
            )
            await interaction.followup.send(embed=embed, ephemeral=True)

    @app_commands.command(name="resume", description="Resume the currently paused song.")
    async def resume(self, interaction: discord.Interaction):
        await interaction.response.defer()
        
        voice_client = interaction.guild.voice_client
        guild_id = str(interaction.guild_id)
        
        if voice_client and voice_client.is_paused():
            voice_client.resume()
            log_event("resumed", guild_id=guild_id)
            
            # Show queue with resumed status
            embed = await self._create_queue_embed(guild_id)
            embed.color = discord.Color.green()
            embed.set_footer(text="▶️ Playback RESUMED • Use /pause to pause")
            
            await interaction.followup.send(embed=embed)
        else:
            log_event("resume_noop", guild_id=guild_id)
            embed = discord.Embed(
                title="▶️ Resume",
                description="I'm not paused right now.",
                color=discord.Color.red()
            )
            await interaction.followup.send(embed=embed, ephemeral=True)

    @app_commands.command(name="stop", description="Stop playback and clear the queue.")
    async def stop(self, interaction: discord.Interaction):
        await interaction.response.defer()
        
        gid = str(interaction.guild_id)
        log_event("stop_called", guild_id=gid, channel_id=getattr(interaction.channel, "id", None))

        vc = interaction.guild.voice_client
        if not vc or not vc.is_connected():
            log_event("stop_no_voice", guild_id=gid)
            embed = discord.Embed(
                title="⏹️ Stop",
                description="I'm not connected to any voice channel.",
                color=discord.Color.red()
            )
            await interaction.followup.send(embed=embed, ephemeral=True)
            return

        # Get current state for display
        current_song = self.current_song.get(gid)
        queue_length = len(self.song_queues.get(gid, deque()))
        
        # Clear queue and stop playback
        if gid in self.song_queues:
            self.song_queues[gid].clear()
        log_event("queue_cleared", guild_id=gid)

        if vc.is_playing() or vc.is_paused():
            log_event("stopping_playback", guild_id=gid)
            vc.stop()

        # Clear current song
        if gid in self.current_song:
            del self.current_song[gid]

        await self._clear_activity()
        
        # Create stop confirmation embed
        embed = discord.Embed(
            title="⏹️ Playback Stopped",
            description="Queue cleared and disconnected from voice channel.",
            color=discord.Color.red()
        )
        
        if current_song:
            service_emoji = self._get_service_emoji(current_song.get('service'))
            title = current_song.get('title', 'Unknown')[:50]
            if len(current_song.get('title', '')) > 50:
                title += "..."
            embed.add_field(
                name="🎵 Was Playing",
                value=f"{service_emoji} {title}",
                inline=False
            )
        
        if queue_length > 0:
            embed.add_field(
                name="🗑️ Queue Cleared",
                value=f"Removed **{queue_length}** songs from queue",
                inline=False
            )
        
        embed.set_footer(text="Use /play to start playing music again")
        
        try:
            await asyncio.wait_for(vc.disconnect(), timeout=5)
            log_event("disconnected", guild_id=gid)
            await interaction.followup.send(embed=embed)
        except asyncio.TimeoutError:
            log_event("disconnect_timeout", guild_id=gid)
            embed.add_field(
                name="⚠️ Warning",
                value="Disconnect timed out",
                inline=False
            )
            await interaction.followup.send(embed=embed)
        except Exception as e:
            log_event("disconnect_error", guild_id=gid, error=str(e))
            embed.add_field(
                name="⚠️ Error",
                value=f"Disconnect error: `{e}`",
                inline=False
            )
            await interaction.followup.send(embed=embed)

    @app_commands.command(name="sources", description="Show status of all music sources")
    async def sources(self, interaction: discord.Interaction):
        """Show the status of all music sources."""
        await interaction.response.defer(ephemeral=True)
        
        log_event("sources_command_called", guild_id=interaction.guild_id)
        
        try:
            status = await self.music_manager.get_service_status()
            
            embed = discord.Embed(
                title="🎵 Music Sources Status",
                description="Current status of all available music sources",
                color=discord.Color.blue()
            )
            
            for service_name, service_status in status.items():
                emoji = self._get_service_emoji(service_name)
                status_emoji = "🟢" if service_status['status'] == 'online' else "🔴"
                
                priority_text = f"Priority: {service_status['priority']}"
                enabled_text = "Enabled" if service_status['enabled'] else "Disabled"
                status_text = service_status['status'].title()
                
                field_value = f"{status_emoji} {status_text}\n{enabled_text}\n{priority_text}"
                
                if 'error' in service_status:
                    field_value += f"\nError: {service_status['error'][:50]}..."
                
                embed.add_field(
                    name=f"{emoji} {service_name.replace('_', ' ').title()}",
                    value=field_value,
                    inline=True
                )
            
            await interaction.followup.send(embed=embed, ephemeral=True)
            
        except Exception as e:
            log_event("sources_command_error", error=str(e))
            await interaction.followup.send(f"Error checking sources: {e}", ephemeral=True)

    @app_commands.command(name="search_all", description="Search all sources for a song")
    @app_commands.describe(query="Search query")
    async def search_all(self, interaction: discord.Interaction, query: str):
        """Search all sources and show results from each."""
        await interaction.response.defer(ephemeral=True)
        
        log_event("search_all_command_called", guild_id=interaction.guild_id, query=query)
        
        try:
            all_results = await self.music_manager.search_all_sources(query, max_results_per_source=2)
            
            if not any(all_results.values()):
                await interaction.followup.send(f"No results found for: **{query}**", ephemeral=True)
                return
            
            embed = discord.Embed(
                title=f"🔍 Search Results: {query}",
                description="Results from all available sources",
                color=discord.Color.green()
            )
            
            for service_name, results in all_results.items():
                if results:
                    emoji = self._get_service_emoji(service_name)
                    result_texts = []
                    
                    for i, result in enumerate(results[:2], 1):
                        title = result.get('title', 'Unknown')[:50]
                        if len(result.get('title', '')) > 50:
                            title += "..."
                        result_texts.append(f"{i}. {title}")
                    
                    field_value = "\n".join(result_texts)
                    if len(results) > 2:
                        field_value += f"\n... and {len(results) - 2} more"
                    
                    embed.add_field(
                        name=f"{emoji} {service_name.replace('_', ' ').title()} ({len(results)})",
                        value=field_value,
                        inline=False
                    )
            
            await interaction.followup.send(embed=embed, ephemeral=True)
            
        except Exception as e:
            log_event("search_all_command_error", error=str(e), query=query)
            await interaction.followup.send(f"Error searching: {e}", ephemeral=True)

    @app_commands.command(name="queue", description="Show the current music queue")
    async def queue(self, interaction: discord.Interaction):
        """Display the current music queue with now playing and upcoming songs."""
        await interaction.response.defer(ephemeral=True)
        
        guild_id = str(interaction.guild_id)
        log_event("queue_command_called", guild_id=guild_id)
        
        try:
            # Check if nothing is playing and queue is empty
            current_song = self.current_song.get(guild_id)
            queue = self.song_queues.get(guild_id, deque())
            
            if not current_song and not queue:
                embed = discord.Embed(
                    title="🎵 Music Queue",
                    description="The queue is empty. Use `/play` to add music!",
                    color=discord.Color.orange()
                )
                await interaction.followup.send(embed=embed, ephemeral=True)
                return
            
            # Use helper function to create queue embed
            embed = await self._create_queue_embed(guild_id)
            
            # Add footer with useful info
            voice_client = interaction.guild.voice_client
            if voice_client:
                if voice_client.is_playing():
                    status = "Playing"
                elif voice_client.is_paused():
                    status = "Paused"
                else:
                    status = "Stopped"
                embed.set_footer(text=f"Status: {status} • Use /play to add more songs")
            else:
                embed.set_footer(text="Not connected to voice • Use /play to start playing")
            
            await interaction.followup.send(embed=embed, ephemeral=True)
            
        except Exception as e:
            log_event("queue_command_error", error=str(e), guild_id=guild_id)
            await interaction.followup.send(f"Error showing queue: {e}", ephemeral=True)

    @app_commands.command(name="radio", description="Play radio stations by genre")
    @app_commands.describe(genre="Radio genre (pop, rock, jazz, classical, electronic, news, talk, country, reggae, latin)")
    async def radio(self, interaction: discord.Interaction, genre: str):
        """Play radio stations by genre."""
        if not interaction.response.is_done():
            await interaction.response.defer()
        
        log_event(
            "radio_called",
            guild_id=interaction.guild_id,
            channel_id=getattr(interaction.channel, "id", None),
            user_id=getattr(interaction.user, "id", None),
            genre=genre,
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

        # Get only the radio service
        radio_service = self.music_manager.get_service_by_name('radio')
        if not radio_service:
            await interaction.followup.send("Radio service is not available.")
            return

        # Search for radio stations by genre
        try:
            stations = await radio_service.search(genre)
            
            if not stations:
                # Show available genres if no stations found
                available_genres = ["pop", "rock", "jazz", "classical", "electronic", "news", "talk", "country", "reggae", "latin"]
                genres_text = ", ".join([f"`{g}`" for g in available_genres])
                await interaction.followup.send(
                    f"No radio stations found for genre: **{genre}**\n"
                    f"Available genres: {genres_text}"
                )
                return

            self.song_queues[guild_id].extend(stations)
            log_event("radio_enqueue", guild_id=guild_id, genre=genre, count=len(stations))

            # Create embed showing the updated queue with added radio stations
            embed = await self._create_queue_embed(guild_id)
            embed.color = discord.Color.blue()
            
            # Add information about what was added
            if len(stations) > 1:
                embed.add_field(
                    name="📻 Radio Stations Added",
                    value=f"Added **{len(stations)}** radio stations for genre: **{genre}**",
                    inline=False
                )
            else:
                station = stations[0]
                title = station.get('title', 'Unknown Station')
                embed.add_field(
                    name="📻 Radio Station Added",
                    value=f"Added radio station: **{title}**",
                    inline=False
                )
            
            embed.set_footer(text="📻 Radio stations will play continuously • Use /skip to change station")
            await interaction.followup.send(embed=embed)

            if not (voice_client.is_playing() or voice_client.is_paused()):
                await self.play_next_song(voice_client, guild_id, interaction.channel)
                
        except Exception as e:
            log_event("radio_command_error", error=str(e), genre=genre)
            await interaction.followup.send(f"Error searching radio stations: {e}")

async def setup(bot):
    await bot.add_cog(MusicCog(bot))