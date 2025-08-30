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

# Canal específico onde a Musa pode responder
MUSA_CHANNEL_ID = 1411119201556496414

class MusicCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.song_queues = {}
        self.current_song = {}
        self.inactivity_timers = {}  # Para controlar timers de inatividade
        self.empty_channel_timers = {}  # Para controlar timers de canal vazio
        
        # Initialize multi-source manager
        self.music_manager = MultiSourceManager()
        
        # Configure services based on environment variables
        self._configure_services()

    async def _check_musa_channel(self, interaction: discord.Interaction) -> bool:
        """Verifica se o comando está sendo usado no canal correto da Musa."""
        if interaction.channel.id != MUSA_CHANNEL_ID:
            embed = discord.Embed(
                title="🧚‍♀️ Canal Incorreto",
                description=f"Eu só respondo comandos no canal <#{MUSA_CHANNEL_ID}>!",
                color=discord.Color.purple()
            )
            embed.set_footer(text="Use os comandos no canal dedicado da Musa")
            
            try:
                # Try to send as initial response if not deferred yet
                if not interaction.response.is_done():
                    await interaction.response.send_message(embed=embed, ephemeral=True)
                else:
                    await interaction.followup.send(embed=embed, ephemeral=True)
            except discord.HTTPException:
                pass
            return False
        return True

    async def _check_voice_requirements(self, interaction: discord.Interaction, command_type: str = "music") -> bool:
        """
        Verifica os requisitos de canal de voz para comandos de música.
        
        Args:
            interaction: A interação do Discord
            command_type: Tipo do comando ('music' para comandos que precisam de voz)
        
        Returns:
            bool: True se os requisitos foram atendidos, False caso contrário
        """
        # Verificar se usuário está em um canal de voz
        if not interaction.user.voice or not interaction.user.voice.channel:
            embed = discord.Embed(
                title="🔊 Canal de Voz Necessário",
                description="Você precisa estar conectado em um canal de voz para usar este comando!",
                color=discord.Color.red()
            )
            embed.set_footer(text="Entre em um canal de voz e tente novamente")
            
            try:
                if not interaction.response.is_done():
                    await interaction.response.send_message(embed=embed, ephemeral=True)
                else:
                    await interaction.followup.send(embed=embed, ephemeral=True)
            except discord.HTTPException:
                pass
            return False
        
        # Se o bot já está conectado, verificar se usuário está no mesmo canal
        voice_client = interaction.guild.voice_client
        if voice_client and voice_client.channel:
            user_channel = interaction.user.voice.channel
            bot_channel = voice_client.channel
            
            if user_channel != bot_channel:
                embed = discord.Embed(
                    title="🎵 Canal Ocupado",
                    description=f"Estou tocando música no canal **{bot_channel.name}**!\nVenha para o mesmo canal para usar os comandos.",
                    color=discord.Color.orange()
                )
                embed.set_footer(text="Entre no canal onde estou tocando para controlar a música")
                
                try:
                    if not interaction.response.is_done():
                        await interaction.response.send_message(embed=embed, ephemeral=True)
                    else:
                        await interaction.followup.send(embed=embed, ephemeral=True)
                except discord.HTTPException:
                    pass
                return False
        
        return True

    def _start_inactivity_timer(self, guild_id: str, voice_client):
        """Inicia um timer de inatividade para desconectar o bot após 60 segundos sem música."""
        # Cancelar timer anterior se existir
        self._cancel_inactivity_timer(guild_id)
        
        async def disconnect_after_timeout():
            await asyncio.sleep(60)  # 60 segundos de inatividade
            try:
                if guild_id in self.inactivity_timers:
                    # Verificar se ainda não há música tocando
                    if voice_client and not voice_client.is_playing() and not voice_client.is_paused():
                        log_event("auto_disconnect_inactivity", guild_id=guild_id)
                        await voice_client.disconnect()
                        
                        # Limpar estado
                        if guild_id in self.current_song:
                            del self.current_song[guild_id]
                        if guild_id in self.song_queues:
                            self.song_queues[guild_id].clear()
                        
                        # Limpar atividade do Discord
                        await self._clear_activity()
                        
                    # Remover timer
                    if guild_id in self.inactivity_timers:
                        del self.inactivity_timers[guild_id]
            except Exception as e:
                log_event("auto_disconnect_error", guild_id=guild_id, error=str(e))
        
        # Criar e armazenar a task
        task = asyncio.create_task(disconnect_after_timeout())
        self.inactivity_timers[guild_id] = task
        
        log_event("inactivity_timer_started", guild_id=guild_id, timeout_seconds=60)

    def _cancel_inactivity_timer(self, guild_id: str):
        """Cancela o timer de inatividade se existir."""
        if guild_id in self.inactivity_timers:
            self.inactivity_timers[guild_id].cancel()
            del self.inactivity_timers[guild_id]
            log_event("inactivity_timer_cancelled", guild_id=guild_id)

    def _check_voice_channel_has_users(self, voice_client) -> bool:
        """Verifica se há usuários reais (não bots) no canal de voz."""
        if not voice_client or not voice_client.channel:
            return False
        
        # Contar apenas usuários que não são bots
        real_users = [member for member in voice_client.channel.members if not member.bot]
        return len(real_users) > 0

    def _start_empty_channel_timer(self, guild_id: str, voice_client):
        """Inicia timer para desconectar quando não há usuários no canal."""
        async def empty_channel_disconnect():
            try:
                await asyncio.sleep(30)  # Aguardar 30 segundos
                
                # Verificar novamente se ainda não há usuários
                if not self._check_voice_channel_has_users(voice_client):
                    log_event("empty_channel_auto_disconnect", guild_id=guild_id)
                    
                    # Limpar estado
                    if guild_id in self.song_queues:
                        self.song_queues[guild_id].clear()
                    self.current_song.pop(guild_id, None)
                    await self._clear_activity()
                    
                    # Desconectar
                    if voice_client.is_connected():
                        await voice_client.disconnect()
                    
                    # Remover timer
                    if guild_id in self.empty_channel_timers:
                        del self.empty_channel_timers[guild_id]
                        
            except Exception as e:
                log_event("empty_channel_timer_error", guild_id=guild_id, error=str(e))
        
        # Cancelar timer existente
        self._cancel_empty_channel_timer(guild_id)
        
        # Criar novo timer
        task = asyncio.create_task(empty_channel_disconnect())
        self.empty_channel_timers[guild_id] = task
        log_event("empty_channel_timer_started", guild_id=guild_id, timeout_seconds=120)

    def _cancel_empty_channel_timer(self, guild_id: str):
        """Cancela o timer de canal vazio se existir."""
        if guild_id in self.empty_channel_timers:
            self.empty_channel_timers[guild_id].cancel()
            del self.empty_channel_timers[guild_id]
            log_event("empty_channel_timer_cancelled", guild_id=guild_id)

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

    @commands.Cog.listener()
    async def on_voice_state_update(self, member, before, after):
        """Detecta quando usuários saem do canal de voz para verificar se deve pausar."""
        # Ignorar mudanças do próprio bot
        if member.bot:
            return
        
        guild_id = str(member.guild.id)
        voice_client = member.guild.voice_client
        
        # Se o bot não está conectado, não há nada para verificar
        if not voice_client or not voice_client.channel:
            return
        
        # Verificar se alguém saiu do canal onde o bot está tocando
        # Isso inclui: sair completamente ou mudar para outro canal
        if (before.channel and before.channel.id == voice_client.channel.id and
            (not after.channel or after.channel.id != voice_client.channel.id)):
            
            # Se o bot está tocando música
            if voice_client.is_playing() or voice_client.is_paused():
                # Verificar se ainda há usuários no canal
                if not self._check_voice_channel_has_users(voice_client):
                    log_event("all_users_left_channel", guild_id=guild_id, channel_id=voice_client.channel.id)
                    self._start_empty_channel_timer(guild_id, voice_client)
        
        # Verificar se alguém entrou no canal onde o bot está (cancelar timer)
        elif (after.channel and after.channel.id == voice_client.channel.id):
            # Cancelar timer de canal vazio se existir
            if guild_id in self.empty_channel_timers:
                self._cancel_empty_channel_timer(guild_id)
                log_event("user_returned_timer_cancelled", guild_id=guild_id, user_id=member.id)

    async def _set_activity(self, song, channel):
        """Set enhanced activity status with detailed music information."""
        try:
            # Get service-specific information
            service_name = song.get('service', 'Unknown')
            service_emoji = self._get_service_emoji(song.get('service'))
            
            # Prepare song details (respecting Discord limits)
            title = song.get('title', 'Unknown Song')[:80]  # Discord name limit
            creator = song.get('creator', 'Unknown Artist')[:50]
            
            # Build activity name with service info
            if song.get('is_live_stream'):
                activity_name = f"🔴 {title}"
                activity_state = f"{service_emoji} LIVE on {service_name.title()}"
            else:
                activity_name = title
                activity_state = f"{service_emoji} {service_name.title()}"
            
            # Add creator info if available and different from title
            if creator and creator.lower() not in title.lower():
                activity_details = f"By {creator} • #{channel.name}"
            else:
                activity_details = f"In #{channel.name}"
            
            activity = discord.Activity(
                type=discord.ActivityType.listening,
                name=activity_name,
                state=activity_state,
                details=activity_details
            )
            
            await self.bot.change_presence(activity=activity, status=discord.Status.online)
            log_event("activity_updated", title=title, service=service_name, channel=channel.name)
            
        except Exception as e:
            log_event("activity_update_error", error=str(e))
            # Fallback to simple activity
            activity = discord.Activity(
                type=discord.ActivityType.listening,
                name=song.get('title', 'Unknown Song')[:80]
            )
            await self.bot.change_presence(activity=activity)

    async def _set_paused_activity(self, song, channel):
        """Set activity status when music is paused."""
        try:
            service_emoji = self._get_service_emoji(song.get('service'))
            title = song.get('title', 'Unknown Song')[:80]
            
            activity = discord.Activity(
                type=discord.ActivityType.listening,
                name=f"⏸️ {title}",
                state=f"{service_emoji} Pausado",
                details=f"In #{channel.name}"
            )
            
            await self.bot.change_presence(activity=activity, status=discord.Status.idle)
            log_event("activity_paused", title=title)
            
        except Exception as e:
            log_event("activity_pause_error", error=str(e))

    async def _clear_activity(self):
        """Clear activity when no music is playing."""
        try:
            activity = discord.Activity(
                type=discord.ActivityType.listening, 
                name="um silêncio ensurdecedor",
                state="🧚‍♀️ Musa em standby",
                details="Pronta para tocar música"
            )
            await self.bot.change_presence(activity=activity, status=discord.Status.online)
            log_event("activity_cleared")
            
        except Exception as e:
            log_event("activity_clear_error", error=str(e))
    
    async def play_next_song(self, voice_client, guild_id, channel):
        # Cancelar timer de inatividade se existir (música está prestes a tocar)
        self._cancel_inactivity_timer(guild_id)
        
        # Cancelar timer de canal vazio se existir (música está prestes a tocar)
        self._cancel_empty_channel_timer(guild_id)
        
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
            # Fila vazia - iniciar timer de inatividade em vez de desconectar imediatamente
            log_event("queue_empty_starting_inactivity_timer", guild_id=guild_id)
            await self._clear_activity()
            self._start_inactivity_timer(guild_id, voice_client)

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
        # Verificar canal correto ANTES do defer
        if not await self._check_musa_channel(interaction):
            return
            
        # Verificar requisitos de canal de voz
        if not await self._check_voice_requirements(interaction):
            return
            
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
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
        else:
            # Check if voice_client is actually functional after container restart
            try:
                # Test if voice_client is responsive
                if not hasattr(voice_client, 'is_connected') or not voice_client.is_connected():
                    # Reconnect if not properly connected
                    await voice_client.disconnect()
                    voice_client = await voice_channel.connect()
            except Exception:
                # If any error occurs, reconnect
                try:
                    await voice_client.disconnect()
                except Exception:
                    pass
                voice_client = await voice_channel.connect()

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
        # Verificar canal correto ANTES do defer
        if not await self._check_musa_channel(interaction):
            return
            
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
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
        # Verificar canal correto ANTES do defer
        if not await self._check_musa_channel(interaction):
            return
            
        # Verificar requisitos de voz ANTES do defer
        if not await self._check_voice_requirements(interaction):
            return
            
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
        voice_client = interaction.guild.voice_client
        guild_id = str(interaction.guild_id)
        
        if voice_client and voice_client.is_playing():
            voice_client.pause()
            log_event("paused", guild_id=guild_id)
            
            # Update activity status to show paused
            current_song = self.current_song.get(guild_id)
            if current_song:
                await self._set_paused_activity(current_song, interaction.channel)
            
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
        # Verificar canal correto
        if not await self._check_musa_channel(interaction):
            return
            
        # Verificar requisitos de voz
        if not await self._check_voice_requirements(interaction):
            return
            
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
        voice_client = interaction.guild.voice_client
        guild_id = str(interaction.guild_id)
        
        if voice_client and voice_client.is_paused():
            voice_client.resume()
            log_event("resumed", guild_id=guild_id)
            
            # Update activity status to show playing again
            current_song = self.current_song.get(guild_id)
            if current_song:
                await self._set_activity(current_song, interaction.channel)
            
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
        # Verificar canal correto ANTES do defer
        if not await self._check_musa_channel(interaction):
            return
            
        # Verificar requisitos de voz ANTES do defer
        if not await self._check_voice_requirements(interaction):
            return
            
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
        gid = str(interaction.guild_id)
        log_event("stop_called", guild_id=gid, channel_id=getattr(interaction.channel, "id", None))

        vc = interaction.guild.voice_client
        if not vc:
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
        
        # Cancelar timer de inatividade se existir
        self._cancel_inactivity_timer(gid)
        
        # Cancelar timer de canal vazio se existir
        self._cancel_empty_channel_timer(gid)

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
        try:
            if not interaction.response.is_done():
                await interaction.response.defer(ephemeral=True)
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
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
        try:
            if not interaction.response.is_done():
                await interaction.response.defer(ephemeral=True)
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
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
        try:
            if not interaction.response.is_done():
                await interaction.response.defer(ephemeral=True)
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
            
        # Verificar canal correto
        if not await self._check_musa_channel(interaction):
            return
        """Display the current music queue with now playing and upcoming songs."""
        try:
            if not interaction.response.is_done():
                await interaction.response.defer(ephemeral=True)
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
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
        # Verificar canal correto ANTES do defer
        if not await self._check_musa_channel(interaction):
            return
            
        # Verificar requisitos de canal de voz
        if not await self._check_voice_requirements(interaction):
            return
            
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except discord.HTTPException:
            # Interaction already acknowledged
            pass
        
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
        else:
            # Check if voice_client is actually functional after container restart
            try:
                # Test if voice_client is responsive
                if not hasattr(voice_client, 'is_connected') or not voice_client.is_connected():
                    # Reconnect if not properly connected
                    await voice_client.disconnect()
                    voice_client = await voice_channel.connect()
            except Exception:
                # If any error occurs, reconnect
                try:
                    await voice_client.disconnect()
                except Exception:
                    pass
                voice_client = await voice_channel.connect()

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