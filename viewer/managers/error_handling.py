"""
Error Handling Framework

Provides centralized error handling, user notification, and logging
for the SentrySix application.
"""

from enum import Enum
from typing import Optional, Callable, Dict, Any
from datetime import datetime
from PyQt6.QtCore import QObject, pyqtSignal
import logging
import traceback


class ErrorSeverity(Enum):
    """Error severity levels for categorizing errors."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class ErrorContext:
    """Context information for errors to provide better debugging and user messages."""

    def __init__(self, component: str, operation: str, user_action: Optional[str] = None):
        """
        Initialize error context.

        Args:
            component: Name of the component where error occurred
            operation: Description of the operation being performed
            user_action: Optional description of what the user was doing
        """
        self.component = component
        self.operation = operation
        self.user_action = user_action
        self.timestamp = datetime.now()
        self.error_id = f"{component}_{operation}_{int(self.timestamp.timestamp())}"

    def __str__(self) -> str:
        """String representation of the error context."""
        parts = [f"[{self.component}] {self.operation}"]
        if self.user_action:
            parts.append(f"User action: {self.user_action}")
        parts.append(f"Time: {self.timestamp.strftime('%H:%M:%S')}")
        return " | ".join(parts)


class ErrorHandler(QObject):
    """
    Centralized error handling and user notification system.

    Provides:
    - Structured error logging with context
    - User-friendly error message generation
    - Error callback registration for custom handling
    - Signal emission for UI error display
    """

    # Signals for UI communication
    error_occurred = pyqtSignal(str, str, str)  # severity, title, message
    critical_error = pyqtSignal(str)  # message for critical errors

    def __init__(self):
        """Initialize the error handler."""
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self.error_callbacks: Dict[str, Callable] = {}
        self.error_count = 0
        self.last_errors = []  # Keep track of recent errors
        self.max_recent_errors = 10

        self.logger.debug("ErrorHandler initialized")

    def handle_error(self, error: Exception, context: ErrorContext,
                    severity: ErrorSeverity = ErrorSeverity.ERROR) -> None:
        """
        Handle an error with appropriate logging and user notification.

        Args:
            error: The exception that occurred
            context: Error context information
            severity: Severity level of the error
        """
        self.error_count += 1

        # Create error record
        error_record = {
            'error': error,
            'context': context,
            'severity': severity,
            'timestamp': datetime.now(),
            'error_id': context.error_id
        }

        # Add to recent errors (keep only last N)
        self.last_errors.append(error_record)
        if len(self.last_errors) > self.max_recent_errors:
            self.last_errors.pop(0)

        # Log the error with appropriate level
        log_message = f"{context} | Error: {str(error)}"

        if severity == ErrorSeverity.CRITICAL:
            self.logger.critical(log_message, exc_info=True)
        elif severity == ErrorSeverity.ERROR:
            self.logger.error(log_message, exc_info=True)
        elif severity == ErrorSeverity.WARNING:
            self.logger.warning(log_message)
        else:  # INFO
            self.logger.info(log_message)

        # Generate user-friendly message
        user_message = self._get_user_friendly_message(error, context)
        title = f"{context.component} Error"

        # Emit appropriate signal
        if severity == ErrorSeverity.CRITICAL:
            self.critical_error.emit(user_message)
        else:
            self.error_occurred.emit(severity.value, title, user_message)

        # Execute any registered callbacks
        self._execute_error_callbacks(error, context, severity)

    def _get_user_friendly_message(self, error: Exception, context: ErrorContext) -> str:
        """
        Convert technical errors to user-friendly messages.

        Args:
            error: The exception that occurred
            context: Error context information

        Returns:
            User-friendly error message
        """
        error_type = type(error).__name__
        error_str = str(error)

        # Map common errors to user-friendly messages
        user_messages = {
            'FileNotFoundError': self._handle_file_not_found_error(error_str, context),
            'PermissionError': f"Permission denied while {context.operation}. Please check file permissions.",
            'TimeoutError': f"Operation timed out: {context.operation}. Please try again.",
            'subprocess.CalledProcessError': f"External tool failed during {context.operation}. Please check your installation.",
            'ValueError': f"Invalid input for {context.operation}: {error_str}",
            'ConnectionError': f"Network connection failed during {context.operation}. Please check your internet connection.",
            'OSError': f"System error during {context.operation}: {error_str}",
            'MemoryError': f"Out of memory during {context.operation}. Please close other applications and try again.",
        }

        # Return specific message if available, otherwise generic
        if error_type in user_messages:
            return user_messages[error_type]
        else:
            return f"An error occurred during {context.operation}: {error_str}"

    def _handle_file_not_found_error(self, error_str: str, context: ErrorContext) -> str:
        """Handle FileNotFoundError with specific context."""
        if 'ffmpeg' in error_str.lower():
            return "FFmpeg is not available. Please ensure FFmpeg is properly installed."
        elif any(ext in error_str for ext in ['.mp4', '.avi', '.mov']):
            return f"Video file not found for {context.operation}. The file may have been moved or deleted."
        else:
            return f"Required file not found for {context.operation}: {error_str}"

    def _execute_error_callbacks(self, error: Exception, context: ErrorContext,
                               severity: ErrorSeverity) -> None:
        """Execute any registered error callbacks."""
        callback_key = f"{context.component}.{context.operation}"

        if callback_key in self.error_callbacks:
            try:
                self.error_callbacks[callback_key](error, context, severity)
            except Exception as callback_error:
                self.logger.error(f"Error in error callback for {callback_key}: {callback_error}")

    def register_error_callback(self, component: str, operation: str,
                              callback: Callable[[Exception, ErrorContext, ErrorSeverity], None]) -> None:
        """
        Register a callback for specific error types.

        Args:
            component: Component name to match
            operation: Operation name to match
            callback: Function to call when error occurs
        """
        callback_key = f"{component}.{operation}"
        self.error_callbacks[callback_key] = callback
        self.logger.debug(f"Registered error callback for {callback_key}")

    def unregister_error_callback(self, component: str, operation: str) -> bool:
        """
        Unregister an error callback.

        Args:
            component: Component name
            operation: Operation name

        Returns:
            True if callback was removed, False if not found
        """
        callback_key = f"{component}.{operation}"
        if callback_key in self.error_callbacks:
            del self.error_callbacks[callback_key]
            self.logger.debug(f"Unregistered error callback for {callback_key}")
            return True
        return False

    def get_error_statistics(self) -> Dict[str, Any]:
        """
        Get error statistics for debugging and monitoring.

        Returns:
            Dictionary with error statistics
        """
        return {
            'total_errors': self.error_count,
            'recent_errors_count': len(self.last_errors),
            'error_types': self._get_error_type_counts(),
            'components_with_errors': self._get_component_error_counts(),
            'last_error_time': self.last_errors[-1]['timestamp'] if self.last_errors else None
        }

    def _get_error_type_counts(self) -> Dict[str, int]:
        """Get counts of different error types."""
        type_counts = {}
        for error_record in self.last_errors:
            error_type = type(error_record['error']).__name__
            type_counts[error_type] = type_counts.get(error_type, 0) + 1
        return type_counts

    def _get_component_error_counts(self) -> Dict[str, int]:
        """Get counts of errors by component."""
        component_counts = {}
        for error_record in self.last_errors:
            component = error_record['context'].component
            component_counts[component] = component_counts.get(component, 0) + 1
        return component_counts

    def clear_error_history(self) -> None:
        """Clear the error history."""
        self.last_errors.clear()
        self.error_count = 0
        self.logger.debug("Cleared error history")
