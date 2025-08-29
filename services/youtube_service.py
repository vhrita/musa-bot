"""
YouTube service wrapper for multi-source architecture.
Wraps existing YouTube functionality to conform to the AudioService interface.
"""

from typing import List, Dict, Optional
from services.base_service import AudioService
from services.youtube import extract_info, resolve_song
from utils.logging import log_event

class YouTubeService(AudioService):
    """
    Service wrapper for YouTube functionality.
    Integrates existing YouTube service with the multi-source architecture.
    """
    
    def __init__(self):
        # YouTube has highest priority when enabled (lowest number)
        super().__init__(name="youtube", enabled=True, priority=1)
        
    async def search(self, query: str) -> List[Dict]:
        """Search for songs on YouTube using existing extract_info function."""
        self.log_service_event("search_start", query=query)
        
        try:
            # Use existing YouTube extract_info function
            results = await extract_info(query)
            
            if results:
                # Add service metadata to each result
                for result in results:
                    result['service'] = self.name
                    
                self.log_service_event("search_success", 
                                     query=query, 
                                     results_count=len(results))
                return results
            else:
                self.log_service_event("search_no_results", query=query)
                return []
                
        except Exception as e:
            self.log_service_event("search_error", 
                                 query=query, 
                                 error=str(e), 
                                 error_type=type(e).__name__)
            return []
    
    async def resolve_url(self, song_info: Dict) -> Optional[Dict]:
        """Resolve YouTube song info to playable URL using existing resolve_song function."""
        self.log_service_event("resolve_start", 
                             title=song_info.get('title'),
                             has_formats=bool(song_info.get('formats')))
        
        try:
            # Use existing YouTube resolve_song function (it's synchronous)
            resolved = resolve_song(song_info)
            
            if resolved:
                # Add service metadata
                resolved['service'] = self.name
                resolved['original_info'] = song_info
                
                self.log_service_event("resolve_success", 
                                     title=resolved.get('title'),
                                     url_domain=resolved['url'].split('/')[2] if '/' in resolved['url'] else None)
                return resolved
            else:
                self.log_service_event("resolve_failed", 
                                     title=song_info.get('title'))
                return None
                
        except Exception as e:
            self.log_service_event("resolve_error", 
                                 title=song_info.get('title'),
                                 error=str(e),
                                 error_type=type(e).__name__)
            return None
    
    async def is_available(self) -> bool:
        """
        Check if YouTube service is available.
        This could be expanded to test actual connectivity.
        """
        try:
            # For now, we'll do a simple availability check
            # In the future, this could test proxy connectivity or make a simple API call
            from config import YTDLP_PROXY
            
            # If we have proxy configured, assume YouTube is available
            # If not, we might have connectivity issues but could still work
            available = True  # Default to available unless we detect issues
            
            self.log_service_event("availability_check", 
                                 available=available,
                                 has_proxy=bool(YTDLP_PROXY))
            return available
            
        except Exception as e:
            self.log_service_event("availability_error", 
                                 error=str(e),
                                 error_type=type(e).__name__)
            return False
