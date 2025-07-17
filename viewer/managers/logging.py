"""
Logging Manager for SentrySix.

This module provides centralized logging functionality with file rotation,
different log levels, and debugging features. Integrates with the consolidated
directory structure for organized log file management.
"""

import os
import logging
import logging.handlers
from typing import Dict, List, Optional, Any
from pathlib import Path
from datetime import datetime, timedelta
from PyQt6.QtCore import QObject, pyqtSignal, QTimer

from .base import BaseManager


class LoggingManagerSignals(QObject):
    """Signals for LoggingManager communication with UI and other managers."""

    # Log level change signals
    log_level_changed = pyqtSignal(str)  # new_level
    debug_mode_changed = pyqtSignal(bool)  # enabled

    # Log file management signals
    log_file_rotated = pyqtSignal(str)  # new_file_path
    log_file_created = pyqtSignal(str)  # file_path
    log_cleanup_completed = pyqtSignal(int)  # files_removed

    # Log monitoring signals
    critical_error_logged = pyqtSignal(str, str)  # logger_name, message
    warning_threshold_exceeded = pyqtSignal(str, int)  # logger_name, count
    log_size_warning = pyqtSignal(str, int)  # file_path, size_mb

    # Performance monitoring signals
    performance_metric_logged = pyqtSignal(str, float)  # metric_name, value
    memory_usage_logged = pyqtSignal(float)  # memory_mb


class LoggingManager(BaseManager):
    """
    Manages centralized logging with file rotation and debugging features.

    Handles:
    - Centralized logging configuration for all application components
    - File rotation with size and time-based policies
    - Different log levels (DEBUG, INFO, WARNING, ERROR, CRITICAL)
    - Performance and memory usage logging
    - Log file cleanup and archival
    - Debug mode with enhanced logging
    - Integration with consolidated directory structure
    """

    # Log level mappings
    LOG_LEVELS = {
        'DEBUG': logging.DEBUG,
        'INFO': logging.INFO,
        'WARNING': logging.WARNING,
        'ERROR': logging.ERROR,
        'CRITICAL': logging.CRITICAL
    }

    def __init__(self, parent_widget, dependency_container):
        """Initialize the LoggingManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = LoggingManagerSignals()

        # Logging configuration
        self.current_log_level = 'INFO'
        self.debug_mode = False
        self.log_to_console = True
        self.log_to_file = True

        # File rotation settings
        self.max_file_size_mb = 10
        self.max_backup_count = 5
        self.log_retention_days = 30

        # Performance monitoring
        self.performance_logging_enabled = True
        self.memory_check_interval = 60000  # 1 minute in milliseconds
        self.memory_timer = QTimer()

        # Log file paths (will be set during initialization)
        self.logs_directory: Optional[Path] = None
        self.main_log_file: Optional[Path] = None
        self.error_log_file: Optional[Path] = None
        self.performance_log_file: Optional[Path] = None

        # Logger instances
        self.loggers: Dict[str, logging.Logger] = {}
        self.file_handlers: Dict[str, logging.handlers.RotatingFileHandler] = {}
        self.console_handler: Optional[logging.StreamHandler] = None

        # Warning counters for monitoring
        self.warning_counters: Dict[str, int] = {}
        self.warning_threshold = 10  # Emit signal after this many warnings

        self.logger.debug("LoggingManager created")

    def initialize(self) -> bool:
        """
        Initialize logging manager.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Get logs directory from ConfigurationManager
            self._setup_log_directories()

            # Configure logging system
            self._configure_logging()

            # Set up file handlers
            self._setup_file_handlers()

            # Set up console handler
            self._setup_console_handler()

            # Configure application loggers
            self._configure_application_loggers()

            # Start performance monitoring
            if self.performance_logging_enabled:
                self._start_performance_monitoring()

            # Clean up old log files
            self._cleanup_old_logs()

            self.logger.info("LoggingManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "LoggingManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up logging resources."""
        try:
            self._mark_cleanup_started()

            # Stop performance monitoring
            if self.memory_timer.isActive():
                self.memory_timer.stop()

            # Close all file handlers
            for handler in self.file_handlers.values():
                handler.close()

            # Remove handlers from loggers
            for logger in self.loggers.values():
                for handler in logger.handlers[:]:
                    logger.removeHandler(handler)

            # Final log message
            self.logger.info("LoggingManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "LoggingManager cleanup")

    # ========================================
    # Log Level Management
    # ========================================

    def set_log_level(self, level: str) -> bool:
        """
        Set the global log level.

        Args:
            level: Log level ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')

        Returns:
            bool: True if level was set successfully
        """
        try:
            if level not in self.LOG_LEVELS:
                self.logger.warning(f"Invalid log level: {level}")
                return False

            old_level = self.current_log_level
            self.current_log_level = level
            numeric_level = self.LOG_LEVELS[level]

            # Update all loggers
            for logger in self.loggers.values():
                logger.setLevel(numeric_level)

            # Update file handlers
            for handler in self.file_handlers.values():
                handler.setLevel(numeric_level)

            # Update console handler
            if self.console_handler:
                self.console_handler.setLevel(numeric_level)

            self.signals.log_level_changed.emit(level)
            self.logger.info(f"Log level changed from {old_level} to {level}")
            return True

        except Exception as e:
            self.handle_error(e, f"set_log_level({level})")
            return False

    def get_log_level(self) -> str:
        """Get current log level."""
        return self.current_log_level

    def set_debug_mode(self, enabled: bool) -> None:
        """Enable or disable debug mode."""
        try:
            old_debug = self.debug_mode
            self.debug_mode = enabled

            if enabled:
                self.set_log_level('DEBUG')
            else:
                # Restore previous level or default to INFO
                config_manager = self.dependency_container.get_service('configuration')
                if config_manager:
                    default_level = config_manager.get_setting('logging.default_level', 'INFO')
                    self.set_log_level(default_level)
                else:
                    self.set_log_level('INFO')

            self.signals.debug_mode_changed.emit(enabled)
            self.logger.info(f"Debug mode {'enabled' if enabled else 'disabled'}")

        except Exception as e:
            self.handle_error(e, f"set_debug_mode({enabled})")

    def is_debug_mode(self) -> bool:
        """Check if debug mode is enabled."""
        return self.debug_mode

    # ========================================
    # Logger Management
    # ========================================

    def get_logger(self, name: str) -> logging.Logger:
        """
        Get or create a logger with the specified name.

        Args:
            name: Logger name (typically module or component name)

        Returns:
            logging.Logger: Configured logger instance
        """
        try:
            if name not in self.loggers:
                self._create_logger(name)

            return self.loggers[name]

        except Exception as e:
            self.handle_error(e, f"get_logger({name})")
            # Return a basic logger as fallback
            return logging.getLogger(name)

    def _create_logger(self, name: str) -> None:
        """Create a new logger with proper configuration."""
        try:
            logger = logging.getLogger(name)
            logger.setLevel(self.LOG_LEVELS[self.current_log_level])

            # Add file handlers
            for handler in self.file_handlers.values():
                logger.addHandler(handler)

            # Add console handler
            if self.console_handler and self.log_to_console:
                logger.addHandler(self.console_handler)

            # Prevent duplicate logs
            logger.propagate = False

            self.loggers[name] = logger
            self.warning_counters[name] = 0

        except Exception as e:
            self.handle_error(e, f"_create_logger({name})")

    # ========================================
    # Performance and Memory Logging
    # ========================================

    def log_performance_metric(self, metric_name: str, value: float, unit: str = 'ms') -> None:
        """
        Log a performance metric.

        Args:
            metric_name: Name of the metric (e.g., 'video_load_time')
            value: Metric value
            unit: Unit of measurement (default: 'ms')
        """
        try:
            if self.performance_logging_enabled:
                perf_logger = self.get_logger('performance')
                perf_logger.info(f"{metric_name}: {value}{unit}")
                self.signals.performance_metric_logged.emit(metric_name, value)

        except Exception as e:
            self.handle_error(e, f"log_performance_metric({metric_name}, {value})")

    def log_memory_usage(self) -> None:
        """Log current memory usage."""
        try:
            # Try to import psutil for detailed memory monitoring
            try:
                import psutil
                process = psutil.Process()
                memory_mb = process.memory_info().rss / 1024 / 1024
                memory_source = "psutil"
            except ImportError:
                # Fallback to basic memory monitoring using tracemalloc or gc
                try:
                    import tracemalloc
                    if tracemalloc.is_tracing():
                        current, _ = tracemalloc.get_traced_memory()
                        memory_mb = current / 1024 / 1024
                        memory_source = "tracemalloc"
                    else:
                        # Start tracing for next time
                        tracemalloc.start()
                        memory_mb = 0.0
                        memory_source = "tracemalloc (starting)"
                except ImportError:
                    # Final fallback - estimate based on object count
                    import gc
                    object_count = len(gc.get_objects())
                    memory_mb = object_count * 0.001  # Rough estimate
                    memory_source = "gc (estimated)"

            memory_logger = self.get_logger('memory')
            memory_logger.info(f"Memory usage: {memory_mb:.2f} MB (source: {memory_source})")
            self.signals.memory_usage_logged.emit(memory_mb)

            # Check for high memory usage
            config_manager = self.container.get_service('configuration')
            if config_manager:
                memory_limit = config_manager.get_setting('performance.memory_limit_mb', 1024)
                if memory_mb > memory_limit:
                    self.logger.warning(f"High memory usage: {memory_mb:.2f} MB (limit: {memory_limit} MB)")

        except Exception as e:
            self.handle_error(e, "log_memory_usage")

    def _start_performance_monitoring(self) -> None:
        """Start automatic performance monitoring."""
        try:
            self.memory_timer.timeout.connect(self.log_memory_usage)
            self.memory_timer.start(self.memory_check_interval)
            self.logger.debug("Performance monitoring started")

        except Exception as e:
            self.handle_error(e, "_start_performance_monitoring")

    # ========================================
    # Log File Management
    # ========================================

    def get_log_files(self) -> List[Path]:
        """Get list of all log files."""
        try:
            if not self.logs_directory or not self.logs_directory.exists():
                return []

            log_files = []
            for file_path in self.logs_directory.iterdir():
                if file_path.is_file() and file_path.suffix == '.log':
                    log_files.append(file_path)

            return sorted(log_files, key=lambda x: x.stat().st_mtime, reverse=True)

        except Exception as e:
            self.handle_error(e, "get_log_files")
            return []

    def get_log_file_info(self) -> Dict[str, Any]:
        """Get information about log files."""
        try:
            info = {
                'logs_directory': str(self.logs_directory) if self.logs_directory else None,
                'main_log_file': str(self.main_log_file) if self.main_log_file else None,
                'error_log_file': str(self.error_log_file) if self.error_log_file else None,
                'performance_log_file': str(self.performance_log_file) if self.performance_log_file else None,
                'total_files': 0,
                'total_size_mb': 0.0,
                'oldest_file': None,
                'newest_file': None
            }

            log_files = self.get_log_files()
            if log_files:
                info['total_files'] = len(log_files)

                total_size = sum(f.stat().st_size for f in log_files)
                info['total_size_mb'] = total_size / 1024 / 1024

                info['oldest_file'] = str(min(log_files, key=lambda x: x.stat().st_mtime))
                info['newest_file'] = str(max(log_files, key=lambda x: x.stat().st_mtime))

            return info

        except Exception as e:
            self.handle_error(e, "get_log_file_info")
            return {}

    def cleanup_old_logs(self, days: Optional[int] = None) -> int:
        """
        Clean up log files older than specified days.

        Args:
            days: Number of days to keep (default: use configured retention)

        Returns:
            int: Number of files removed
        """
        try:
            if days is None:
                days = self.log_retention_days

            if not self.logs_directory or not self.logs_directory.exists():
                return 0

            cutoff_date = datetime.now() - timedelta(days=days)
            removed_count = 0

            for file_path in self.logs_directory.iterdir():
                if file_path.is_file() and file_path.suffix == '.log':
                    file_time = datetime.fromtimestamp(file_path.stat().st_mtime)
                    if file_time < cutoff_date:
                        file_path.unlink()
                        removed_count += 1
                        self.logger.debug(f"Removed old log file: {file_path}")

            if removed_count > 0:
                self.signals.log_cleanup_completed.emit(removed_count)
                self.logger.info(f"Cleaned up {removed_count} old log files")

            return removed_count

        except Exception as e:
            self.handle_error(e, f"cleanup_old_logs({days})")
            return 0

    def _cleanup_old_logs(self) -> None:
        """Perform automatic cleanup of old logs during initialization."""
        try:
            removed = self.cleanup_old_logs()
            if removed > 0:
                self.logger.info(f"Automatic cleanup removed {removed} old log files")

        except Exception as e:
            self.handle_error(e, "_cleanup_old_logs")

    # ========================================
    # Helper Methods
    # ========================================

    def _setup_log_directories(self) -> None:
        """Set up log directories using ConfigurationManager."""
        try:
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                self.logs_directory = config_manager.get_logs_directory()
            else:
                # Fallback to default location
                from pathlib import Path
                self.logs_directory = Path.home() / '.sentrysix' / 'logs'

            # Ensure directory exists
            self.logs_directory.mkdir(parents=True, exist_ok=True)

            # Set up log file paths
            timestamp = datetime.now().strftime('%Y%m%d')
            self.main_log_file = self.logs_directory / f'sentrysix_{timestamp}.log'
            self.error_log_file = self.logs_directory / f'sentrysix_errors_{timestamp}.log'
            self.performance_log_file = self.logs_directory / f'sentrysix_performance_{timestamp}.log'

        except Exception as e:
            self.handle_error(e, "_setup_log_directories")

    def _configure_logging(self) -> None:
        """Configure the logging system."""
        try:
            # Load configuration from ConfigurationManager
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                self.current_log_level = config_manager.get_setting('logging.default_level', 'INFO')
                self.debug_mode = config_manager.get_setting('logging.debug_mode', False)
                self.log_to_console = config_manager.get_setting('logging.console_enabled', True)
                self.log_to_file = config_manager.get_setting('logging.file_enabled', True)
                self.max_file_size_mb = config_manager.get_setting('logging.max_file_size_mb', 10)
                self.max_backup_count = config_manager.get_setting('logging.max_backup_count', 5)
                self.log_retention_days = config_manager.get_setting('logging.retention_days', 30)

        except Exception as e:
            self.handle_error(e, "_configure_logging")

    def _setup_file_handlers(self) -> None:
        """Set up rotating file handlers."""
        try:
            if not self.log_to_file or not self.logs_directory:
                return

            # Main log handler
            main_handler = logging.handlers.RotatingFileHandler(
                self.main_log_file,
                maxBytes=self.max_file_size_mb * 1024 * 1024,
                backupCount=self.max_backup_count,
                encoding='utf-8'
            )
            main_handler.setLevel(self.LOG_LEVELS[self.current_log_level])
            main_handler.setFormatter(self._get_file_formatter())
            self.file_handlers['main'] = main_handler

            # Error log handler (WARNING and above)
            error_handler = logging.handlers.RotatingFileHandler(
                self.error_log_file,
                maxBytes=self.max_file_size_mb * 1024 * 1024,
                backupCount=self.max_backup_count,
                encoding='utf-8'
            )
            error_handler.setLevel(logging.WARNING)
            error_handler.setFormatter(self._get_file_formatter())
            self.file_handlers['error'] = error_handler

            # Performance log handler
            perf_handler = logging.handlers.RotatingFileHandler(
                self.performance_log_file,
                maxBytes=self.max_file_size_mb * 1024 * 1024,
                backupCount=self.max_backup_count,
                encoding='utf-8'
            )
            perf_handler.setLevel(logging.INFO)
            perf_handler.setFormatter(self._get_performance_formatter())
            self.file_handlers['performance'] = perf_handler

        except Exception as e:
            self.handle_error(e, "_setup_file_handlers")

    def _setup_console_handler(self) -> None:
        """Set up console handler."""
        try:
            if not self.log_to_console:
                return

            self.console_handler = logging.StreamHandler()
            self.console_handler.setLevel(self.LOG_LEVELS[self.current_log_level])
            self.console_handler.setFormatter(self._get_console_formatter())

        except Exception as e:
            self.handle_error(e, "_setup_console_handler")

    def _configure_application_loggers(self) -> None:
        """Configure loggers for different application components."""
        try:
            # Create loggers for main application components
            component_loggers = [
                'VideoPlaybackManager',
                'ExportManager',
                'LayoutManager',
                'ClipManager',
                'ConfigurationManager',
                'LoggingManager',
                'performance',
                'memory',
                'ui',
                'root'
            ]

            for component in component_loggers:
                self._create_logger(component)

        except Exception as e:
            self.handle_error(e, "_configure_application_loggers")

    def _get_file_formatter(self) -> logging.Formatter:
        """Get formatter for file logging."""
        return logging.Formatter(
            '%(asctime)s [%(levelname)s] %(name)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )

    def _get_console_formatter(self) -> logging.Formatter:
        """Get formatter for console logging."""
        return logging.Formatter(
            '%(asctime)s [%(levelname)s] %(name)s: %(message)s',
            datefmt='%H:%M:%S'
        )

    def _get_performance_formatter(self) -> logging.Formatter:
        """Get formatter for performance logging."""
        return logging.Formatter(
            '%(asctime)s [PERF] %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
