"""
SentrySix Manager Components

This package contains the manager-based architecture components that handle
specific aspects of the application functionality:

- BaseManager: Abstract base class for all managers
- DependencyContainer: Service locator for manager communication
- ErrorHandler: Centralized error handling and user notification
- VideoPlaybackManager: Video player operations and synchronization
- ExportManager: Video export operations and progress tracking
"""

from .base import BaseManager
from .container import DependencyContainer
from .error_handling import ErrorHandler, ErrorContext, ErrorSeverity
from .video_playback import VideoPlaybackManager
from .export import ExportManager

__all__ = [
    'BaseManager',
    'DependencyContainer',
    'ErrorHandler',
    'ErrorContext',
    'ErrorSeverity',
    'VideoPlaybackManager',
    'ExportManager'
]
