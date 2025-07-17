"""
Resource management module for SentrySix application.

This module provides context managers and utilities for proper cleanup
of temporary files, video players, and other resources to prevent memory leaks.
"""

import os
import tempfile
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import List, Optional, Set, Union
from PyQt6.QtCore import QUrl, QThread
from PyQt6.QtMultimedia import QMediaPlayer

from .logging_config import get_logger

logger = get_logger(__name__)


class ResourceTracker:
    """Tracks and manages application resources for proper cleanup."""
    
    def __init__(self):
        self.temp_files: Set[Path] = set()
        self.media_players: Set[QMediaPlayer] = set()
        self.threads: Set[QThread] = set()
        self.cleanup_callbacks: List[callable] = []
        
    def register_temp_file(self, file_path: Union[str, Path]) -> Path:
        """Register a temporary file for cleanup."""
        path = Path(file_path)
        self.temp_files.add(path)
        logger.debug(f"Registered temp file: {path}")
        return path
    
    def register_media_player(self, player: QMediaPlayer) -> QMediaPlayer:
        """Register a media player for cleanup."""
        self.media_players.add(player)
        logger.debug(f"Registered media player: {id(player)}")
        return player
    
    def register_thread(self, thread: QThread) -> QThread:
        """Register a thread for cleanup."""
        self.threads.add(thread)
        logger.debug(f"Registered thread: {id(thread)}")
        return thread
    
    def register_cleanup_callback(self, callback: callable):
        """Register a cleanup callback function."""
        self.cleanup_callbacks.append(callback)
        logger.debug(f"Registered cleanup callback: {callback.__name__}")
    
    def cleanup_temp_files(self):
        """Clean up all registered temporary files."""
        for file_path in list(self.temp_files):
            try:
                if file_path.exists():
                    file_path.unlink()
                    logger.debug(f"Cleaned up temp file: {file_path}")
                self.temp_files.discard(file_path)
            except OSError as e:
                logger.warning(f"Failed to remove temp file {file_path}: {e}")
    
    def cleanup_media_players(self):
        """Clean up all registered media players."""
        player_count = len(self.media_players)
        if player_count > 0:
            logger.debug(f"Cleaning up {player_count} media players")

        for player in list(self.media_players):
            try:
                player.stop()
                player.setSource(QUrl())
                self.media_players.discard(player)
            except Exception as e:
                logger.warning(f"Failed to cleanup media player {id(player)}: {e}")

        if player_count > 0:
            logger.debug(f"Media player cleanup completed")
    
    def cleanup_threads(self):
        """Clean up all registered threads."""
        for thread in list(self.threads):
            try:
                if thread.isRunning():
                    thread.quit()
                    thread.wait(5000)  # Wait up to 5 seconds
                    if thread.isRunning():
                        logger.warning(f"Thread {id(thread)} did not terminate gracefully")
                logger.debug(f"Cleaned up thread: {id(thread)}")
                self.threads.discard(thread)
            except Exception as e:
                logger.warning(f"Failed to cleanup thread {id(thread)}: {e}")
    
    def run_cleanup_callbacks(self):
        """Run all registered cleanup callbacks."""
        for callback in self.cleanup_callbacks:
            try:
                callback()
                logger.debug(f"Executed cleanup callback: {callback.__name__}")
            except (RuntimeError, AttributeError) as e:
                # Qt objects may have been deleted already
                logger.debug(f"Qt object already deleted in cleanup callback {callback.__name__}: {e}")
            except Exception as e:
                logger.error(f"Error in cleanup callback {callback.__name__}: {e}")
    
    def cleanup_all(self):
        """Clean up all registered resources."""
        logger.info("Starting comprehensive resource cleanup")
        
        # Run custom cleanup callbacks first
        self.run_cleanup_callbacks()
        
        # Clean up threads (they might be using other resources)
        self.cleanup_threads()
        
        # Clean up media players
        self.cleanup_media_players()
        
        # Clean up temporary files last
        self.cleanup_temp_files()
        
        logger.info("Resource cleanup completed")


# Global resource tracker instance
_resource_tracker = ResourceTracker()


def get_resource_tracker() -> ResourceTracker:
    """Get the global resource tracker instance."""
    return _resource_tracker


@contextmanager
def temporary_file(suffix: str = "", prefix: str = "sentry_", dir: Optional[str] = None, text: bool = False):
    """
    Context manager for creating and automatically cleaning up temporary files.
    
    Args:
        suffix: File suffix (e.g., '.txt', '.jpg')
        prefix: File prefix
        dir: Directory to create file in (default: system temp)
        text: Whether to open in text mode
    
    Yields:
        Path to the temporary file
    """
    fd = None
    temp_path = None
    
    try:
        fd, temp_path = tempfile.mkstemp(suffix=suffix, prefix=prefix, dir=dir, text=text)
        temp_path = Path(temp_path)
        
        # Close the file descriptor immediately if we don't need it
        if fd is not None:
            os.close(fd)
            fd = None
        
        logger.debug(f"Created temporary file: {temp_path}")
        yield temp_path
        
    except Exception as e:
        logger.error(f"Error with temporary file: {e}")
        raise
    finally:
        # Clean up
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
                logger.debug(f"Cleaned up temporary file: {temp_path}")
            except OSError as e:
                logger.warning(f"Failed to cleanup temporary file {temp_path}: {e}")


@contextmanager
def managed_temp_file(suffix: str = "", prefix: str = "sentry_", dir: Optional[str] = None, text: bool = False):
    """
    Context manager for creating temporary files that are tracked by the resource manager.
    
    Unlike temporary_file, these files are registered with the global resource tracker
    and will be cleaned up when the application exits if not cleaned up manually.
    """
    fd = None
    temp_path = None
    
    try:
        fd, temp_path = tempfile.mkstemp(suffix=suffix, prefix=prefix, dir=dir, text=text)
        temp_path = Path(temp_path)
        
        # Close the file descriptor immediately
        if fd is not None:
            os.close(fd)
            fd = None
        
        # Register with resource tracker
        _resource_tracker.register_temp_file(temp_path)
        
        logger.debug(f"Created managed temporary file: {temp_path}")
        yield temp_path
        
    except Exception as e:
        logger.error(f"Error with managed temporary file: {e}")
        raise
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


class ManagedMediaPlayer:
    """Wrapper for QMediaPlayer that ensures proper cleanup."""
    
    def __init__(self, parent=None):
        self.player = QMediaPlayer(parent)
        _resource_tracker.register_media_player(self.player)
        logger.debug(f"Created managed media player: {id(self.player)}")
    
    def __getattr__(self, name):
        """Delegate all attribute access to the wrapped player."""
        return getattr(self.player, name)
    
    def cleanup(self):
        """Manually clean up this media player."""
        try:
            self.player.stop()
            self.player.setSource(QUrl())
            _resource_tracker.media_players.discard(self.player)
            logger.debug(f"Manually cleaned up media player: {id(self.player)}")
        except Exception as e:
            logger.warning(f"Error during manual media player cleanup: {e}")


class ManagedThread:
    """Wrapper for QThread that ensures proper cleanup."""
    
    def __init__(self, parent=None):
        self.thread = QThread(parent)
        _resource_tracker.register_thread(self.thread)
        logger.debug(f"Created managed thread: {id(self.thread)}")
    
    def __getattr__(self, name):
        """Delegate all attribute access to the wrapped thread."""
        return getattr(self.thread, name)
    
    def cleanup(self):
        """Manually clean up this thread."""
        try:
            if self.thread.isRunning():
                self.thread.quit()
                self.thread.wait(5000)
            _resource_tracker.threads.discard(self.thread)
            logger.debug(f"Manually cleaned up thread: {id(self.thread)}")
        except Exception as e:
            logger.warning(f"Error during manual thread cleanup: {e}")


def cleanup_on_exit():
    """Function to be called on application exit to clean up all resources."""
    logger.info("Application exit cleanup initiated")
    _resource_tracker.cleanup_all()


def register_exit_cleanup():
    """Register the cleanup function to be called on application exit."""
    import atexit
    atexit.register(cleanup_on_exit)
    logger.info("Exit cleanup handler registered")


# Utility functions for common cleanup patterns
def safe_remove_file(file_path: Union[str, Path]) -> bool:
    """
    Safely remove a file, logging any errors.
    
    Returns:
        True if file was removed or didn't exist, False if removal failed
    """
    try:
        path = Path(file_path)
        if path.exists():
            path.unlink()
            logger.debug(f"Removed file: {path}")
        return True
    except OSError as e:
        logger.warning(f"Failed to remove file {file_path}: {e}")
        return False


def safe_cleanup_media_player(player: QMediaPlayer) -> bool:
    """
    Safely clean up a media player.

    Returns:
        True if cleanup was successful, False otherwise
    """
    try:
        player.stop()
        player.setSource(QUrl())
        # Only log at debug level and less frequently
        return True
    except Exception as e:
        logger.warning(f"Failed to cleanup media player {id(player)}: {e}")
        return False
