"""
Universal stream resolver utility.
Handles different types of audio streams (M3U, MP3, direct URLs, etc.)
Can be used by any audio service for robust stream resolution.
"""

import aiohttp
from typing import Optional
from urllib.parse import urljoin


class UniversalStreamResolver:
    """Universal stream resolver that handles multiple stream formats."""
    
    # Constants for content type detection
    AUDIO_CONTENT_TYPES = ['audio/', 'application/ogg', 'video/']
    PLAYLIST_CONTENT_TYPES = ['text/', 'application/vnd.apple.mpegurl', 'audio/x-mpegurl', 'audio/mpegurl']
    VALID_STATUS_CODES = [200, 206, 302, 301]
    
    def __init__(self, logger_service=None):
        self.logger_service = logger_service
    
    def log_event(self, event_type: str, **kwargs):
        """Log event if logger service is available."""
        if self.logger_service and hasattr(self.logger_service, 'log_service_event'):
            self.logger_service.log_service_event(f"stream_resolver_{event_type}", **kwargs)
    
    async def resolve_stream_url(self, url: str) -> Optional[str]:
        """Universal stream resolver that handles M3U, MP3, and other formats."""
        try:
            self.log_event("resolve_start", original_url=url)
            
            async with aiohttp.ClientSession() as session:
                # Try HEAD request first to check content type
                final_url = await self._try_head_request(session, url)
                if final_url:
                    return final_url
                
                # If HEAD failed, try GET request
                return await self._try_get_request(session, url)
            
        except Exception as e:
            self.log_event("resolve_error", original_url=url, error=str(e))
            return None
    
    async def _try_head_request(self, session: aiohttp.ClientSession, url: str) -> Optional[str]:
        """Try HEAD request to get content type and check accessibility."""
        try:
            async with session.head(url, timeout=10, allow_redirects=True) as response:
                content_type = response.headers.get('Content-Type', '').lower()
                final_url = str(response.url)  # Get final URL after redirects
                
                self.log_event("head_request_success", 
                             original_url=url,
                             final_url=final_url,
                             content_type=content_type,
                             status=response.status)
                
                # If it's already an audio/video stream, use it directly
                if any(media_type in content_type for media_type in self.AUDIO_CONTENT_TYPES):
                    if await self._test_stream_accessibility(final_url):
                        return final_url
                
                # If direct access works with valid status, use the final URL
                if response.status in self.VALID_STATUS_CODES:
                    if await self._test_stream_accessibility(final_url):
                        return final_url
            
            return None
        
        except Exception as head_error:
            self.log_event("head_request_failed", original_url=url, error=str(head_error))
            return None
    
    async def _try_get_request(self, session: aiohttp.ClientSession, url: str) -> Optional[str]:
        """Try GET request to download content and determine stream type."""
        try:
            async with session.get(url, timeout=10) as response:
                if response.status not in self.VALID_STATUS_CODES:
                    return None
                
                content_type = response.headers.get('Content-Type', '').lower()
                final_url = str(response.url)
                
                # Check if it's a playlist format
                if any(playlist_type in content_type for playlist_type in self.PLAYLIST_CONTENT_TYPES):
                    content = await response.text()
                    return await self._extract_stream_from_playlist(content, url)
                
                # If it's audio/video content, use the URL directly
                elif any(media_type in content_type for media_type in self.AUDIO_CONTENT_TYPES):
                    if await self._test_stream_accessibility(final_url):
                        return final_url
                
                # Unknown content type, try to parse as playlist anyway
                else:
                    content = await response.text()
                    playlist_url = await self._extract_stream_from_playlist(content, url)
                    if playlist_url:
                        return playlist_url
                    
                    # Last resort: test if the original URL works as direct stream
                    if await self._test_stream_accessibility(final_url):
                        return final_url
                
                return None
        
        except Exception as get_error:
            self.log_event("get_request_failed", original_url=url, error=str(get_error))
            return None
    
    async def _extract_stream_from_playlist(self, content: str, base_url: str) -> Optional[str]:
        """Extract stream URL from playlist content (M3U, PLS, etc.)"""
        try:
            lines = content.strip().split('\n')
            
            # Look for HTTP URLs in the content
            for line in lines:
                line = line.strip()
                
                # Direct HTTP URLs
                if line.startswith('http'):
                    if await self._try_playlist_url(line, base_url):
                        return line
                
                # Handle relative URLs in playlists
                elif line and not line.startswith('#') and not line.startswith('['):
                    absolute_url = self._make_absolute_url(line, base_url)
                    if absolute_url and await self._try_playlist_url(absolute_url, base_url):
                        return absolute_url
            
            self.log_event("no_valid_stream_in_playlist", 
                         base_url=base_url,
                         content_preview=content[:200])
            return None
            
        except Exception as e:
            self.log_event("playlist_extract_error", base_url=base_url, error=str(e))
            return None
    
    async def _try_playlist_url(self, url: str, base_url: str) -> bool:
        """Try a URL found in a playlist and log the result."""
        if await self._test_stream_accessibility(url):
            self.log_event("playlist_stream_found", 
                         base_url=base_url,
                         stream_url=url)
            return True
        return False
    
    def _make_absolute_url(self, relative_url: str, base_url: str) -> Optional[str]:
        """Convert relative URL to absolute URL."""
        try:
            if relative_url.startswith('/') or (relative_url and not relative_url.startswith('#')):
                absolute_url = urljoin(base_url, relative_url)
                if absolute_url.startswith('http'):
                    return absolute_url
            return None
        except Exception:
            return None
    
    async def _test_stream_accessibility(self, url: str) -> bool:
        """Test if a stream URL is accessible and returns audio data."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=5) as response:
                    if response.status in self.VALID_STATUS_CODES:
                        content_type = response.headers.get('Content-Type', '').lower()
                        
                        # Check if it's audio/video content
                        if any(media_type in content_type for media_type in self.AUDIO_CONTENT_TYPES):
                            return True
                        
                        # Try to read a small chunk to see if it's streaming
                        try:
                            chunk = await response.content.read(1024)
                            return len(chunk) > 0
                        except Exception:
                            return False
                    
                    return False
        except Exception:
            return False
