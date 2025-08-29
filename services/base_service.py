"""
Base service interface for multi-source audio architecture.
All audio services should inherit from this base class.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Optional
from utils.logging import log_event

class AudioService(ABC):
    """
    Abstract base class for audio services.
    Each service must implement methods to search and resolve audio URLs.
    """
    
    def __init__(self, name: str, enabled: bool = True, priority: int = 1):
        self.name = name
        self.enabled = enabled
        self.priority = priority  # Lower number = higher priority
        
    @abstractmethod
    async def search(self, query: str) -> List[Dict]:
        """
        Search for songs using the service.
        
        Args:
            query: Search query string
            
        Returns:
            List of song dictionaries with metadata
        """
        pass
    
    @abstractmethod
    async def resolve_url(self, song_info: Dict) -> Optional[Dict]:
        """
        Resolve a song info dictionary to a playable audio URL.
        
        Args:
            song_info: Song metadata dictionary from search()
            
        Returns:
            Dictionary with 'url', 'title', 'duration', 'thumbnail' keys
            or None if resolution failed
        """
        pass
    
    @abstractmethod
    async def is_available(self) -> bool:
        """
        Check if the service is currently available.
        
        Returns:
            True if service is working, False otherwise
        """
        pass
    
    def log_service_event(self, event_type: str, **kwargs):
        """Helper method to log service-specific events."""
        log_event(f"{self.name}_{event_type}", service=self.name, **kwargs)
