"""
Input validation module for SentrySix application.

This module provides comprehensive validation for all user inputs including
file paths, time inputs, export settings, and other user-provided data.
"""

import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Tuple, Union, List

from .constants import (
    TIME_FORMAT_INPUT, TIMESTAMP_FORMAT, DATE_FORMAT, TIME_ONLY_FORMAT,
    VIDEO_EXTENSIONS, SUPPORTED_VIDEO_EXTENSION, TESLA_FILENAME_PATTERN
)
from .logging_config import get_logger

logger = get_logger(__name__)


class ValidationError(Exception):
    """Custom exception for validation errors."""
    pass


class ValidationResult:
    """Result of a validation operation."""
    
    def __init__(self, is_valid: bool, value=None, error_message: str = ""):
        self.is_valid = is_valid
        self.value = value
        self.error_message = error_message
    
    def __bool__(self):
        return self.is_valid


class InputValidator:
    """Comprehensive input validator for the application."""
    
    @staticmethod
    def validate_file_path(path: Union[str, Path], must_exist: bool = True, 
                          must_be_file: bool = True, must_be_dir: bool = False,
                          allowed_extensions: Optional[List[str]] = None) -> ValidationResult:
        """
        Validate a file or directory path.
        
        Args:
            path: Path to validate
            must_exist: Whether the path must exist
            must_be_file: Whether the path must be a file
            must_be_dir: Whether the path must be a directory
            allowed_extensions: List of allowed file extensions (e.g., ['.mp4', '.avi'])
        
        Returns:
            ValidationResult with the validated Path object
        """
        try:
            if not path:
                return ValidationResult(False, None, "Path cannot be empty")
            
            path_obj = Path(path)
            
            # Check if path exists when required
            if must_exist and not path_obj.exists():
                return ValidationResult(False, None, f"Path does not exist: {path}")
            
            # Check if it's a file when required
            if must_exist and must_be_file and not path_obj.is_file():
                return ValidationResult(False, None, f"Path is not a file: {path}")
            
            # Check if it's a directory when required
            if must_exist and must_be_dir and not path_obj.is_dir():
                return ValidationResult(False, None, f"Path is not a directory: {path}")
            
            # Check file extension
            if allowed_extensions and path_obj.suffix.lower() not in [ext.lower() for ext in allowed_extensions]:
                return ValidationResult(False, None, f"Invalid file extension. Allowed: {', '.join(allowed_extensions)}")
            
            logger.debug(f"Path validation successful: {path}")
            return ValidationResult(True, path_obj)
            
        except Exception as e:
            logger.error(f"Error validating path {path}: {e}")
            return ValidationResult(False, None, f"Invalid path: {e}")
    
    @staticmethod
    def validate_clips_directory(path: Union[str, Path]) -> ValidationResult:
        """
        Validate a Tesla clips directory.
        
        Args:
            path: Path to the clips directory
        
        Returns:
            ValidationResult with the validated Path object
        """
        result = InputValidator.validate_file_path(path, must_exist=True, must_be_dir=True)
        if not result.is_valid:
            return result
        
        path_obj = result.value
        
        # Check if directory contains date folders
        date_pattern = re.compile(r'^\d{4}-\d{2}-\d{2}')
        date_folders = [item for item in path_obj.iterdir() 
                       if item.is_dir() and date_pattern.match(item.name)]
        
        if not date_folders:
            return ValidationResult(False, None, "Directory does not contain any date folders (YYYY-MM-DD format)")
        
        logger.info(f"Clips directory validation successful: {path} ({len(date_folders)} date folders found)")
        return ValidationResult(True, path_obj)
    
    @staticmethod
    def validate_time_string(time_str: str, allow_empty: bool = False) -> ValidationResult:
        """
        Validate a time string in HH:MM:SS format.
        
        Args:
            time_str: Time string to validate
            allow_empty: Whether empty strings are allowed
        
        Returns:
            ValidationResult with the validated time string
        """
        if not time_str:
            if allow_empty:
                return ValidationResult(True, "")
            return ValidationResult(False, None, "Time cannot be empty")
        
        time_str = time_str.strip()
        
        # Check format with regex
        time_pattern = re.compile(r'^([0-1]?[0-9]|2[0-3]):([0-5]?[0-9]):([0-5]?[0-9])$')
        if not time_pattern.match(time_str):
            return ValidationResult(False, None, "Time must be in HH:MM:SS format")
        
        # Try to parse with datetime
        try:
            datetime.strptime(time_str, TIME_ONLY_FORMAT)
            logger.debug(f"Time validation successful: {time_str}")
            return ValidationResult(True, time_str)
        except ValueError as e:
            return ValidationResult(False, None, f"Invalid time: {e}")
    
    @staticmethod
    def validate_datetime_string(datetime_str: str, date_format: str = TIMESTAMP_FORMAT) -> ValidationResult:
        """
        Validate a datetime string.
        
        Args:
            datetime_str: Datetime string to validate
            date_format: Expected datetime format
        
        Returns:
            ValidationResult with the parsed datetime object
        """
        if not datetime_str:
            return ValidationResult(False, None, "Datetime cannot be empty")
        
        try:
            dt = datetime.strptime(datetime_str.strip(), date_format)
            logger.debug(f"Datetime validation successful: {datetime_str}")
            return ValidationResult(True, dt)
        except ValueError as e:
            return ValidationResult(False, None, f"Invalid datetime format. Expected {date_format}: {e}")
    
    @staticmethod
    def validate_export_range(start_ms: Optional[int], end_ms: Optional[int], 
                             max_duration_ms: Optional[int] = None) -> ValidationResult:
        """
        Validate export time range.
        
        Args:
            start_ms: Start time in milliseconds
            end_ms: End time in milliseconds
            max_duration_ms: Maximum allowed duration
        
        Returns:
            ValidationResult with tuple (start_ms, end_ms)
        """
        if start_ms is None:
            return ValidationResult(False, None, "Start time must be set")
        
        if end_ms is None:
            return ValidationResult(False, None, "End time must be set")
        
        if start_ms < 0:
            return ValidationResult(False, None, "Start time cannot be negative")
        
        if end_ms < 0:
            return ValidationResult(False, None, "End time cannot be negative")
        
        if start_ms >= end_ms:
            return ValidationResult(False, None, "Start time must be before end time")
        
        duration_ms = end_ms - start_ms
        
        # Check minimum duration (1 second)
        if duration_ms < 1000:
            return ValidationResult(False, None, "Export duration must be at least 1 second")
        
        # Check maximum duration if specified
        if max_duration_ms and duration_ms > max_duration_ms:
            max_minutes = max_duration_ms // 60000
            return ValidationResult(False, None, f"Export duration cannot exceed {max_minutes} minutes")
        
        logger.debug(f"Export range validation successful: {start_ms}-{end_ms}ms ({duration_ms/1000:.1f}s)")
        return ValidationResult(True, (start_ms, end_ms))
    
    @staticmethod
    def validate_output_path(path: Union[str, Path], overwrite_allowed: bool = True) -> ValidationResult:
        """
        Validate an output file path for export.
        
        Args:
            path: Output file path
            overwrite_allowed: Whether overwriting existing files is allowed
        
        Returns:
            ValidationResult with the validated Path object
        """
        if not path:
            return ValidationResult(False, None, "Output path cannot be empty")
        
        path_obj = Path(path)
        
        # Check if parent directory exists
        if not path_obj.parent.exists():
            return ValidationResult(False, None, f"Output directory does not exist: {path_obj.parent}")
        
        # Check if parent is writable
        if not os.access(path_obj.parent, os.W_OK):
            return ValidationResult(False, None, f"Output directory is not writable: {path_obj.parent}")
        
        # Check file extension
        if path_obj.suffix.lower() != SUPPORTED_VIDEO_EXTENSION:
            return ValidationResult(False, None, f"Output file must have {SUPPORTED_VIDEO_EXTENSION} extension")
        
        # Check if file exists and overwrite policy
        if path_obj.exists() and not overwrite_allowed:
            return ValidationResult(False, None, f"Output file already exists: {path}")
        
        logger.debug(f"Output path validation successful: {path}")
        return ValidationResult(True, path_obj)
    
    @staticmethod
    def validate_tesla_video_file(path: Union[str, Path]) -> ValidationResult:
        """
        Validate a Tesla video file.
        
        Args:
            path: Path to the video file
        
        Returns:
            ValidationResult with parsed filename components
        """
        result = InputValidator.validate_file_path(path, must_exist=True, must_be_file=True, 
                                                  allowed_extensions=[SUPPORTED_VIDEO_EXTENSION])
        if not result.is_valid:
            return result
        
        path_obj = result.value
        filename = path_obj.name
        
        # Check Tesla filename pattern
        match = TESLA_FILENAME_PATTERN.match(filename)
        if not match:
            return ValidationResult(False, None, f"File does not match Tesla video naming pattern: {filename}")
        
        date_str, time_str, camera = match.groups()
        
        # Validate date and time components
        try:
            file_datetime = datetime.strptime(f"{date_str}_{time_str}", "%Y-%m-%d_%H-%M-%S")
        except ValueError as e:
            return ValidationResult(False, None, f"Invalid date/time in filename: {e}")
        
        logger.debug(f"Tesla video file validation successful: {filename}")
        return ValidationResult(True, {
            'path': path_obj,
            'date': date_str,
            'time': time_str,
            'camera': camera,
            'datetime': file_datetime
        })
    
    @staticmethod
    def validate_playback_rate(rate_str: str, allowed_rates: dict) -> ValidationResult:
        """
        Validate a playback rate string.
        
        Args:
            rate_str: Playback rate string (e.g., "1x", "2x")
            allowed_rates: Dictionary of allowed rates
        
        Returns:
            ValidationResult with the numeric rate value
        """
        if not rate_str:
            return ValidationResult(False, None, "Playback rate cannot be empty")
        
        if rate_str not in allowed_rates:
            valid_rates = ", ".join(allowed_rates.keys())
            return ValidationResult(False, None, f"Invalid playback rate. Allowed: {valid_rates}")
        
        rate_value = allowed_rates[rate_str]
        logger.debug(f"Playback rate validation successful: {rate_str} ({rate_value})")
        return ValidationResult(True, rate_value)


# Convenience functions for common validations
def validate_clips_folder(path: Union[str, Path]) -> ValidationResult:
    """Convenience function to validate clips folder."""
    return InputValidator.validate_clips_directory(path)


def validate_time_input(time_str: str) -> ValidationResult:
    """Convenience function to validate time input."""
    return InputValidator.validate_time_string(time_str)


def validate_export_settings(start_ms: Optional[int], end_ms: Optional[int], 
                            output_path: Union[str, Path]) -> ValidationResult:
    """Convenience function to validate complete export settings."""
    # Validate time range
    range_result = InputValidator.validate_export_range(start_ms, end_ms)
    if not range_result.is_valid:
        return range_result
    
    # Validate output path
    path_result = InputValidator.validate_output_path(output_path)
    if not path_result.is_valid:
        return path_result
    
    return ValidationResult(True, {
        'time_range': range_result.value,
        'output_path': path_result.value
    })


def sanitize_filename(filename: str) -> str:
    """
    Sanitize a filename by removing or replacing invalid characters.
    
    Args:
        filename: Original filename
    
    Returns:
        Sanitized filename safe for filesystem use
    """
    # Remove or replace invalid characters
    invalid_chars = '<>:"/\\|?*'
    sanitized = filename
    
    for char in invalid_chars:
        sanitized = sanitized.replace(char, '_')
    
    # Remove leading/trailing whitespace and dots
    sanitized = sanitized.strip(' .')
    
    # Ensure filename is not empty
    if not sanitized:
        sanitized = "untitled"
    
    # Limit length to reasonable size
    if len(sanitized) > 200:
        sanitized = sanitized[:200]
    
    logger.debug(f"Filename sanitized: '{filename}' -> '{sanitized}'")
    return sanitized
