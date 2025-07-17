"""
SentrySix Manager Components

This package contains the manager-based architecture components that handle
specific aspects of the application functionality:

- BaseManager: Abstract base class for all managers
- DependencyContainer: Service locator for manager communication
- ErrorHandler: Centralized error handling and user notification
- VideoPlaybackManager: Video player operations and synchronization
- ExportManager: Video export operations and progress tracking
- LayoutManager: Camera layout and UI management
- ClipManager: File discovery and clip loading
- ConfigurationManager: Application settings and user preferences
- LoggingManager: Centralized logging with file rotation and debugging
- CacheManager: Intelligent caching for thumbnails, metadata, and data
- PluginManager: Extensible plugin architecture for functionality expansion
"""

from .base import BaseManager
from .container import DependencyContainer
from .error_handling import ErrorHandler, ErrorContext, ErrorSeverity
from .video_playback import VideoPlaybackManager
from .export import ExportManager
from .layout import LayoutManager
from .clip import ClipManager
from .configuration import ConfigurationManager
from .logging import LoggingManager
from .cache import CacheManager
from .plugin import PluginManager, PluginInterface

__all__ = [
    'BaseManager',
    'DependencyContainer',
    'ErrorHandler',
    'ErrorContext',
    'ErrorSeverity',
    'VideoPlaybackManager',
    'ExportManager',
    'LayoutManager',
    'ClipManager',
    'ConfigurationManager',
    'LoggingManager',
    'CacheManager',
    'PluginManager',
    'PluginInterface'
]
