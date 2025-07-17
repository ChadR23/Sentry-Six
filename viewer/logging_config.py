"""
Logging configuration module for SentrySix application.

This module provides structured logging setup with proper log levels,
formatters, and handlers for different components of the application.
"""

import logging
import logging.handlers
import os
import sys
import time
from pathlib import Path
from typing import Optional

from .constants import get_log_dir_path, get_log_file_path, APP_NAME

# Optional imports
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

try:
    import __main__
    HAS_MAIN = True
except ImportError:
    HAS_MAIN = False


class SentryLogger:
    """Centralized logging manager for the SentrySix application."""
    
    _instance: Optional['SentryLogger'] = None
    _initialized = False
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self):
        if not SentryLogger._initialized:
            self.setup_logging()
            SentryLogger._initialized = True
    
    def setup_logging(self, debug_mode: bool = False):
        """
        Set up comprehensive logging for the application.
        
        Args:
            debug_mode: If True, enables DEBUG level logging and console output
        """
        # Create log directory
        log_dir = get_log_dir_path()
        log_dir.mkdir(exist_ok=True)
        
        # Configure root logger
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.DEBUG if debug_mode else logging.INFO)
        
        # Clear any existing handlers
        root_logger.handlers.clear()
        
        # Create formatters
        detailed_formatter = logging.Formatter(
            fmt='%(asctime)s [%(levelname)8s] %(name)s:%(lineno)d - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        
        simple_formatter = logging.Formatter(
            fmt='%(asctime)s [%(levelname)s] %(message)s',
            datefmt='%H:%M:%S'
        )
        
        # File handler with rotation
        file_handler = logging.handlers.RotatingFileHandler(
            filename=get_log_file_path(),
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=5,
            encoding='utf-8'
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(detailed_formatter)
        root_logger.addHandler(file_handler)
        
        # Console handler (only in debug mode or when explicitly enabled)
        if debug_mode or self._should_show_console():
            console_handler = logging.StreamHandler(sys.stdout)
            console_handler.setLevel(logging.INFO)
            console_handler.setFormatter(simple_formatter)
            root_logger.addHandler(console_handler)
        
        # Error file handler for critical issues
        error_handler = logging.FileHandler(
            filename=log_dir / "errors.log",
            encoding='utf-8'
        )
        error_handler.setLevel(logging.ERROR)
        error_handler.setFormatter(detailed_formatter)
        root_logger.addHandler(error_handler)
        
        # Set up specific logger levels
        self._configure_module_loggers()
        
        # Log startup message
        logger = logging.getLogger(__name__)
        logger.info(f"{APP_NAME} logging system initialized")
        logger.info(f"Log directory: {log_dir}")
        logger.info(f"Debug mode: {debug_mode}")
    
    def _should_show_console(self) -> bool:
        """Determine if console logging should be enabled."""
        if HAS_MAIN:
            return getattr(__main__, 'DEBUG', False)
        return False
    
    def _configure_module_loggers(self):
        """Configure specific loggers for different modules."""
        # UI module - moderate logging
        logging.getLogger('viewer.ui').setLevel(logging.INFO)
        
        # Workers - detailed logging for background operations
        logging.getLogger('viewer.workers').setLevel(logging.DEBUG)
        
        # FFmpeg operations - detailed logging
        logging.getLogger('viewer.ffmpeg_manager').setLevel(logging.DEBUG)
        logging.getLogger('viewer.ffmpeg_builder').setLevel(logging.DEBUG)
        
        # Hardware acceleration - detailed logging
        logging.getLogger('viewer.hwacc_detector').setLevel(logging.DEBUG)
        
        # Updater - moderate logging
        logging.getLogger('viewer.updater').setLevel(logging.INFO)
        
        # Utils - minimal logging
        logging.getLogger('viewer.utils').setLevel(logging.WARNING)
        
        # External libraries - minimal logging
        logging.getLogger('requests').setLevel(logging.WARNING)
        logging.getLogger('urllib3').setLevel(logging.WARNING)
    
    def get_logger(self, name: str) -> logging.Logger:
        """Get a logger instance for the specified module."""
        return logging.getLogger(name)
    
    def log_performance(self, operation: str, duration: float, logger_name: str = None):
        """Log performance metrics for operations."""
        logger = logging.getLogger(logger_name or 'performance')
        if duration > 1.0:  # Log slow operations
            logger.warning(f"Slow operation: {operation} took {duration:.2f}s")
        else:
            logger.debug(f"Operation: {operation} completed in {duration:.3f}s")
    
    def log_user_action(self, action: str, details: str = None):
        """Log user actions for debugging and analytics."""
        logger = logging.getLogger('user_actions')
        message = f"User action: {action}"
        if details:
            message += f" - {details}"
        logger.info(message)
    
    def log_system_info(self):
        """Log system information at startup."""
        logger = logging.getLogger('system')
        logger.info(f"Python version: {sys.version}")
        logger.info(f"Platform: {sys.platform}")
        logger.info(f"Working directory: {os.getcwd()}")
        
        # Log memory usage if psutil is available
        if HAS_PSUTIL:
            try:
                process = psutil.Process()
                memory_mb = process.memory_info().rss / 1024 / 1024
                logger.info(f"Initial memory usage: {memory_mb:.1f} MB")
            except Exception as e:
                logger.debug(f"Could not get memory usage: {e}")


def setup_exception_logging():
    """Set up global exception handler to log uncaught exceptions."""
    def log_uncaught_exception(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            # Don't log keyboard interrupts
            sys.__excepthook__(exc_type, exc_value, exc_traceback)
            return
        
        logger = logging.getLogger('uncaught_exceptions')
        logger.critical(
            "Uncaught exception occurred",
            exc_info=(exc_type, exc_value, exc_traceback)
        )
    
    sys.excepthook = log_uncaught_exception


def get_logger(name: str) -> logging.Logger:
    """
    Convenience function to get a logger instance.
    
    Args:
        name: Logger name (typically __name__)
    
    Returns:
        Configured logger instance
    """
    # Ensure logging is initialized
    SentryLogger()
    return logging.getLogger(name)


# Context managers for structured logging
class LoggedOperation:
    """Context manager for logging operations with timing."""
    
    def __init__(self, operation_name: str, logger_name: str = None):
        self.operation_name = operation_name
        self.logger = get_logger(logger_name or 'operations')
        self.start_time = None
    
    def __enter__(self):
        self.start_time = time.time()
        self.logger.info(f"Starting operation: {self.operation_name}")
        return self
    
    def __exit__(self, exc_type, exc_val, _exc_tb):
        duration = time.time() - self.start_time
        if exc_type is None:
            self.logger.info(f"Completed operation: {self.operation_name} in {duration:.3f}s")
        else:
            self.logger.error(f"Failed operation: {self.operation_name} after {duration:.3f}s - {exc_val}")
        return False  # Don't suppress exceptions


# Decorators for automatic logging
def log_method_calls(logger_name: str = None):
    """Decorator to automatically log method calls."""
    def decorator(func):
        def wrapper(*args, **kwargs):
            logger = get_logger(logger_name or func.__module__)
            func_name = f"{func.__qualname__}"
            logger.debug(f"Calling {func_name}")
            try:
                result = func(*args, **kwargs)
                logger.debug(f"Completed {func_name}")
                return result
            except Exception as e:
                logger.error(f"Error in {func_name}: {e}")
                raise
        return wrapper
    return decorator


def log_errors(logger_name: str = None):
    """Decorator to automatically log errors in functions."""
    def decorator(func):
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                logger = get_logger(logger_name or func.__module__)
                logger.error(f"Error in {func.__qualname__}: {e}", exc_info=True)
                raise
        return wrapper
    return decorator
