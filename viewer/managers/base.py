"""
Base Manager Class

Provides the abstract base class and common functionality for all managers
in the SentrySix application.
"""

from abc import ABC, abstractmethod
from typing import Any, Optional
import logging
from datetime import datetime


class BaseManager(ABC):
    """
    Abstract base class for all managers with common functionality.

    Provides:
    - Initialization and cleanup lifecycle management
    - Centralized error handling with logging
    - Dependency injection support
    - Common state management patterns
    """

    def __init__(self, parent_widget, dependency_container):
        """
        Initialize the base manager.

        Args:
            parent_widget: The parent Qt widget (usually TeslaCamViewer)
            dependency_container: Container for dependency injection
        """
        self.parent_widget = parent_widget
        self.container = dependency_container
        self.logger = logging.getLogger(self.__class__.__name__)
        self._initialized = False
        self._initialization_time: Optional[datetime] = None

        # Track manager state
        self._is_cleaning_up = False
        self._error_count = 0

        self.logger.debug(f"Created {self.__class__.__name__}")

    @abstractmethod
    def initialize(self) -> bool:
        """
        Initialize the manager. Must be implemented by subclasses.

        Returns:
            bool: True if initialization was successful, False otherwise
        """
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """
        Clean up resources when manager is destroyed.
        Must be implemented by subclasses.
        """
        pass

    def is_initialized(self) -> bool:
        """Check if the manager has been successfully initialized."""
        return self._initialized

    def get_initialization_time(self) -> Optional[datetime]:
        """Get the time when the manager was initialized."""
        return self._initialization_time

    def handle_error(self, error: Exception, context: str,
                    user_friendly_message: Optional[str] = None) -> None:
        """
        Centralized error handling with logging and user notification.

        Args:
            error: The exception that occurred
            context: Description of what was being done when the error occurred
            user_friendly_message: Optional user-friendly error message
        """
        self._error_count += 1

        # Log the technical error
        self.logger.error(
            f"Error in {context}: {error}",
            exc_info=True,
            extra={
                'manager': self.__class__.__name__,
                'context': context,
                'error_count': self._error_count
            }
        )

        # Get error handler if available
        try:
            if self.container and self.container.has_service('error_handler'):
                error_handler = self.container.get_service('error_handler')
                from .error_handling import ErrorContext, ErrorSeverity

                error_context = ErrorContext(
                    component=self.__class__.__name__,
                    operation=context
                )

                error_handler.handle_error(error, error_context, ErrorSeverity.ERROR)
            else:
                # Fallback: emit signal to parent widget if available
                if hasattr(self.parent_widget, 'show_error_message'):
                    message = user_friendly_message or f"Error in {context}: {str(error)}"
                    self.parent_widget.show_error_message(message)

        except Exception as handler_error:
            # Don't let error handling itself cause more errors
            self.logger.critical(
                f"Error in error handler: {handler_error}",
                exc_info=True
            )

    def _mark_initialized(self) -> None:
        """Mark the manager as successfully initialized."""
        self._initialized = True
        self._initialization_time = datetime.now()
        self.logger.info(f"{self.__class__.__name__} initialized successfully")

    def _mark_cleanup_started(self) -> None:
        """Mark that cleanup has started."""
        self._is_cleaning_up = True
        self.logger.debug(f"{self.__class__.__name__} cleanup started")

    def get_error_count(self) -> int:
        """Get the number of errors that have occurred in this manager."""
        return self._error_count

    def reset_error_count(self) -> None:
        """Reset the error counter."""
        self._error_count = 0
        self.logger.debug(f"{self.__class__.__name__} error count reset")
