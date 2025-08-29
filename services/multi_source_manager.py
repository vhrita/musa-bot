"""
Multi-source audio service manager.
Coordinates multiple audio services with fallback priority system.
"""

import asyncio
from typing import List, Dict, Optional, Type
from services.base_service import AudioService
from services.youtube_service import YouTubeService
from services.internet_archive import InternetArchiveService
from services.radio import RadioService
from utils.logging import log_event

class MultiSourceManager:
    """
    Manages multiple audio services with priority-based fallback.
    Attempts to find music from multiple sources in order of priority.
    """
    
    def __init__(self):
        self.services: List[AudioService] = []
        self._initialize_services()
        
    def _initialize_services(self):
        """Initialize all available audio services."""
        # Add services in order (will be sorted by priority anyway)
        service_classes = [
            YouTubeService,      # Priority 1 (highest when enabled)
            InternetArchiveService,  # Priority 2
            RadioService,        # Priority 3
        ]
        
        for service_class in service_classes:
            try:
                service = service_class()
                self.services.append(service)
                log_event("service_initialized", 
                         service_name=service.name,
                         priority=service.priority,
                         enabled=service.enabled)
            except Exception as e:
                log_event("service_initialization_failed",
                         service_class=service_class.__name__,
                         error=str(e))
        
        # Sort services by priority (lower number = higher priority)
        self.services.sort(key=lambda s: s.priority)
        
        log_event("multi_source_manager_initialized",
                 total_services=len(self.services),
                 enabled_services=len([s for s in self.services if s.enabled]))
    
    def get_service_by_name(self, name: str) -> Optional[AudioService]:
        """Get a service by its name."""
        for service in self.services:
            if service.name == name:
                return service
        return None
    
    def get_enabled_services(self) -> List[AudioService]:
        """Get all enabled services."""
        return [service for service in self.services if service.enabled]
    
    def enable_service(self, service_name: str):
        """Enable a specific service."""
        for service in self.services:
            if service.name == service_name:
                service.enabled = True
                log_event("service_enabled", service_name=service_name)
                return True
        return False
    
    def disable_service(self, service_name: str):
        """Disable a specific service."""
        for service in self.services:
            if service.name == service_name:
                service.enabled = False
                log_event("service_disabled", service_name=service_name)
                return True
        return False
    
    def set_service_priority(self, service_name: str, priority: int):
        """Change the priority of a service."""
        for service in self.services:
            if service.name == service_name:
                old_priority = service.priority
                service.priority = priority
                # Re-sort services by priority
                self.services.sort(key=lambda s: s.priority)
                log_event("service_priority_changed",
                         service_name=service_name,
                         old_priority=old_priority,
                         new_priority=priority)
                return True
        return False
    
    async def search_all_sources(self, query: str, max_results_per_source: int = 3) -> Dict[str, List[Dict]]:
        """
        Search across all enabled sources and return results grouped by service.
        
        Args:
            query: Search query
            max_results_per_source: Maximum results to get from each source
            
        Returns:
            Dictionary with service names as keys and result lists as values
        """
        log_event("search_all_sources_start", 
                 query=query, 
                 enabled_services=len(self.get_enabled_services()))
        
        results = {}
        tasks = []
        
        # Create search tasks for all enabled services
        for service in self.get_enabled_services():
            task = asyncio.create_task(
                self._search_service_with_limit(service, query, max_results_per_source)
            )
            tasks.append((service.name, task))
        
        # Wait for all searches to complete
        for service_name, task in tasks:
            try:
                service_results = await task
                results[service_name] = service_results
                log_event("service_search_completed",
                         service_name=service_name,
                         results_count=len(service_results))
            except Exception as e:
                log_event("service_search_failed",
                         service_name=service_name,
                         error=str(e))
                results[service_name] = []
        
        total_results = sum(len(res) for res in results.values())
        log_event("search_all_sources_completed",
                 query=query,
                 total_results=total_results,
                 services_with_results=len([k for k, v in results.items() if v]))
        
        return results
    
    async def _search_service_with_limit(self, service: AudioService, query: str, limit: int) -> List[Dict]:
        """Search a service and limit the number of results."""
        try:
            results = await service.search(query)
            return results[:limit] if results else []
        except Exception as e:
            log_event("service_search_error",
                     service_name=service.name,
                     query=query,
                     error=str(e))
            return []
    
    async def search_with_fallback(self, query: str) -> List[Dict]:
        """
        Search for music with automatic fallback to next available source.
        Returns results from the first service that finds matches.
        
        Args:
            query: Search query
            
        Returns:
            List of song dictionaries from the first successful service
        """
        log_event("search_with_fallback_start", 
                 query=query,
                 services_count=len(self.get_enabled_services()))
        
        for service in self.get_enabled_services():
            try:
                log_event("trying_service", 
                         service_name=service.name, 
                         priority=service.priority)
                
                # Check if service is available before searching
                if not await service.is_available():
                    log_event("service_unavailable", service_name=service.name)
                    continue
                
                results = await service.search(query)
                
                if results:
                    log_event("search_with_fallback_success",
                             query=query,
                             service_used=service.name,
                             results_count=len(results))
                    return results
                else:
                    log_event("service_no_results", 
                             service_name=service.name, 
                             query=query)
                    
            except Exception as e:
                log_event("service_search_failed",
                         service_name=service.name,
                         query=query,
                         error=str(e),
                         error_type=type(e).__name__)
                continue
        
        log_event("search_with_fallback_no_results", query=query)
        return []
    
    async def resolve_song_url(self, song_info: Dict) -> Optional[Dict]:
        """
        Resolve a song info dictionary to a playable URL.
        Uses the service specified in the song_info.
        
        Args:
            song_info: Song metadata dictionary with 'service' key
            
        Returns:
            Resolved song dictionary with playable URL or None
        """
        service_name = song_info.get('service')
        if not service_name:
            log_event("resolve_song_no_service", title=song_info.get('title'))
            return None
        
        # Find the appropriate service
        service = None
        for s in self.services:
            if s.name == service_name and s.enabled:
                service = s
                break
        
        if not service:
            log_event("resolve_song_service_not_found", 
                     service_name=service_name,
                     title=song_info.get('title'))
            return None
        
        try:
            resolved = await service.resolve_url(song_info)
            if resolved:
                log_event("resolve_song_success",
                         service_name=service_name,
                         title=resolved.get('title'))
            else:
                log_event("resolve_song_failed",
                         service_name=service_name,
                         title=song_info.get('title'))
            return resolved
            
        except Exception as e:
            log_event("resolve_song_error",
                     service_name=service_name,
                     title=song_info.get('title'),
                     error=str(e),
                     error_type=type(e).__name__)
            return None
    
    async def get_service_status(self) -> Dict[str, Dict]:
        """
        Get status information for all services.
        
        Returns:
            Dictionary with service status information
        """
        status = {}
        
        for service in self.services:
            try:
                is_available = await service.is_available() if service.enabled else False
                status[service.name] = {
                    'enabled': service.enabled,
                    'priority': service.priority,
                    'available': is_available,
                    'status': 'online' if (service.enabled and is_available) else 'offline'
                }
            except Exception as e:
                status[service.name] = {
                    'enabled': service.enabled,
                    'priority': service.priority,
                    'available': False,
                    'status': 'error',
                    'error': str(e)
                }
        
        log_event("service_status_check_completed",
                 total_services=len(status),
                 online_services=len([s for s in status.values() if s['status'] == 'online']))
        
        return status
