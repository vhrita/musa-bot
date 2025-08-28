import discord

async def safe_reply(interaction: discord.Interaction, content: str, ephemeral: bool = True):
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
