"""
Constants module for SentrySix application.

This module contains all hardcoded values extracted from the codebase
to improve maintainability and configuration management.
"""

import os
import re
from pathlib import Path

# =============================================================================
# APPLICATION METADATA
# =============================================================================

APP_NAME = "SentrySix"
APP_ORGANIZATION = "JR Media"
APP_VERSION = "1.0.0"
APP_TITLE = "Sentry Six"

# =============================================================================
# UI DIMENSIONS AND LAYOUT
# =============================================================================

# Main window
MIN_WINDOW_WIDTH = 1280
MIN_WINDOW_HEIGHT = 720
DEFAULT_WINDOW_WIDTH = 1600
DEFAULT_WINDOW_HEIGHT = 950
DEFAULT_WINDOW_X = 50
DEFAULT_WINDOW_Y = 50

# Layout spacing and margins
LAYOUT_SPACING = 8
LAYOUT_MARGINS = 8

# Icon sizes
ICON_SIZE_SMALL = 28
ICON_SIZE_MEDIUM = 32
ICON_SIZE_LARGE = 48

# Thumbnail dimensions
THUMBNAIL_WIDTH = 192
THUMBNAIL_HEIGHT = -1  # Maintain aspect ratio
THUMBNAIL_MIN_WIDTH = 320
THUMBNAIL_MIN_HEIGHT = 180

# Video scaling
VIDEO_SCALE_WIDTH = 1448
VIDEO_SCALE_HEIGHT = 938

# Mobile export dimensions
MOBILE_EXPORT_HEIGHT = 1080

# Zoom limits for video player
MIN_ZOOM_FACTOR = 1.0
MAX_ZOOM_FACTOR = 7.0
ZOOM_STEP = 1.15

# =============================================================================
# CAMERA CONFIGURATION
# =============================================================================

# Camera names and indices
CAMERA_NAMES = {
    "front": 0,
    "left_repeater": 1,
    "right_repeater": 2,
    "back": 3,
    "left_pillar": 4,
    "right_pillar": 5
}

# Number of cameras
NUM_CAMERAS = 6

# Default camera visibility (all visible)
DEFAULT_CAMERA_VISIBILITY = [True] * NUM_CAMERAS

# =============================================================================
# PLAYBACK CONFIGURATION
# =============================================================================

# Playback rates
PLAYBACK_RATES = {
    "0.25x": 0.25,
    "0.5x": 0.5,
    "0.75x": 0.75,
    "1x": 1.0,
    "1.25x": 1.25,
    "1.5x": 1.5,
    "2x": 2.0,
    "4x": 4.0
}

DEFAULT_PLAYBACK_RATE = "1x"

# Player controls text
PLAY_BUTTON_TEXT = "▶️ Play"
PAUSE_BUTTON_TEXT = "⏸️ Pause"

# =============================================================================
# TIME AND DURATION
# =============================================================================

# Default durations (in milliseconds)
DEFAULT_VIDEO_DURATION_MS = 60000  # 1 minute
DEFAULT_CLIP_DURATION_MS = 60000   # 1 minute

# Time format patterns
TIME_FORMAT_DISPLAY = "--:--"
TIME_FORMAT_INPUT = "HH:MM:SS"
TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"
DATE_FORMAT = "%Y-%m-%d"
TIME_ONLY_FORMAT = "%H:%M:%S"

# Timeout values (in seconds)
FFPROBE_TIMEOUT = 5
THUMBNAIL_GENERATION_DELAY = 0.75  # 750ms
UPDATE_CHECK_TIMEOUT = 10
SUBPROCESS_TIMEOUT = 5

# =============================================================================
# FILE PATTERNS AND EXTENSIONS
# =============================================================================

# Tesla video filename pattern
TESLA_FILENAME_PATTERN = re.compile(
    r"(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(front|left_repeater|right_repeater|back|left_pillar|right_pillar)\.mp4"
)

# FFmpeg time pattern for progress parsing
FFMPEG_TIME_PATTERN = re.compile(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})")

# File extensions
VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv"]
IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".bmp"]
SUPPORTED_VIDEO_EXTENSION = ".mp4"

# MIME types
DRAG_DROP_MIME_TYPE = "application/x-teslacam-widget-index"

# =============================================================================
# PATHS AND DIRECTORIES
# =============================================================================

# Base directories
BASE_DIR = Path(__file__).parent
PROJECT_ROOT = BASE_DIR.parent
ASSETS_DIR = PROJECT_ROOT / "assets"
FFMPEG_BIN_DIR = PROJECT_ROOT / "ffmpeg_bin"

# Asset files
ICON_FILE = "Sentry_six.ico"
STYLESHEET_FILE = "style.qss"

# Asset SVG icons
CAMERA_ICON = "camera.svg"
HAND_ICON = "hand.svg"
HORN_ICON = "horn.svg"

# Log directory
LOG_DIR_NAME = ".sentry_six_logs"
LOG_FILE_NAME = "sentry_six.log"

# =============================================================================
# FFMPEG CONFIGURATION
# =============================================================================

# FFmpeg executable names
FFMPEG_EXE_NAME = "ffmpeg.exe"
FFPROBE_EXE_NAME = "ffprobe.exe"
FFMPEG_CONFIG_FILE = "ffmpeg_update.json"

# FFmpeg download URL
FFMPEG_DOWNLOAD_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

# FFmpeg update check interval
FFMPEG_CHECK_INTERVAL_DAYS = 30

# FFmpeg command arguments
FFMPEG_COMMON_ARGS = ["-y"]  # Overwrite output files
FFPROBE_COMMON_ARGS = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1"
]

# Video encoding presets
ENCODING_PRESET_FAST = "fast"
ENCODING_PRESET_MEDIUM = "medium"
ENCODING_CRF_MOBILE = "23"
ENCODING_CRF_DESKTOP = "18"
AUDIO_BITRATE = "128k"

# =============================================================================
# EXPORT CONFIGURATION
# =============================================================================

# Export file filters
EXPORT_FILE_FILTER = "MP4 Videos (*.mp4)"

# Export progress messages
EXPORT_PROGRESS_STARTING = "Exporting clip... (0%)"
EXPORT_PROGRESS_FINALIZING = "Finalizing..."
EXPORT_PROGRESS_FORMAT = "Exporting... ({percentage}%)"

# =============================================================================
# SETTINGS KEYS
# =============================================================================

# QSettings keys
SETTINGS_WINDOW_GEOMETRY = "windowGeometry"
SETTINGS_LAST_ROOT_FOLDER = "lastRootFolder"
SETTINGS_LAST_SPEED_TEXT = "lastSpeedText"
SETTINGS_CAMERA_VISIBILITY = "cameraVisibility"
SETTINGS_CAMERA_ORDER = "cameraOrder"
SETTINGS_DONT_SHOW_WELCOME = "dontShowWelcome"

# =============================================================================
# ERROR MESSAGES
# =============================================================================

# Common error messages
ERROR_NO_FFMPEG = "FFmpeg not found"
ERROR_NO_CLIPS_FOUND = "No clip folders found for {date}"
ERROR_NO_VALID_FILES = "No valid video files found for {date}"
ERROR_EXPORT_FAILED = "Export failed"
ERROR_INVALID_TIME_FORMAT = "Invalid time format"
ERROR_INVALID_DATE = "Invalid date for preview"
ERROR_UPDATE_CHECK_FAILED = "Could not check for updates"

# Success messages
SUCCESS_EXPORT_COMPLETE = "Export completed successfully!"
SUCCESS_UPDATE_CHECK = "You are running the latest version."

# =============================================================================
# HARDWARE ACCELERATION
# =============================================================================

# GPU types
GPU_TYPE_NVIDIA = "nvidia"
GPU_TYPE_AMD = "amd"
GPU_TYPE_INTEL = "intel"

# Hardware acceleration encoders
HWACC_ENCODERS = {
    GPU_TYPE_NVIDIA: ["h264_nvenc", "hevc_nvenc"],
    GPU_TYPE_AMD: ["h264_amf", "hevc_amf"],
    GPU_TYPE_INTEL: ["h264_qsv", "hevc_qsv"]
}

# =============================================================================
# GITHUB INTEGRATION
# =============================================================================

GITHUB_REPO = "ChadR23/Sentry-Six"
GITHUB_API_BASE = "https://api.github.com/repos"
UPDATE_CHECK_TIMEOUT = 10

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def get_camera_index_to_name_map():
    """Get reverse mapping from camera index to name."""
    return {v: k for k, v in CAMERA_NAMES.items()}

def get_ffmpeg_exe_path():
    """Get the full path to the FFmpeg executable."""
    return FFMPEG_BIN_DIR / FFMPEG_EXE_NAME

def get_ffprobe_exe_path():
    """Get the full path to the FFprobe executable."""
    return FFMPEG_BIN_DIR / FFPROBE_EXE_NAME

def get_assets_path():
    """Get the full path to the assets directory."""
    return ASSETS_DIR

def get_log_dir_path():
    """Get the full path to the log directory."""
    return Path.home() / LOG_DIR_NAME

def get_log_file_path():
    """Get the full path to the log file."""
    return get_log_dir_path() / LOG_FILE_NAME

# =============================================================================
# SVG ICON DATA
# =============================================================================

# SVG icon definitions for embedded assets
SVG_ICONS = {
    'check.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#282c34" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    CAMERA_ICON: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e06c75" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>',
    HAND_ICON: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c678dd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5l3.5 3.5.9-1.8"/><path d="M20 13.3c.2-.3.2-.7 0-1l-3-5a2 2 0 00-3.5 0l-3.5 6a2 2 0 002 3h9.4a2 2 0 011.6.8L22 22V8.5A2.5 2.5 0 0019.5 6Z"/><path d="M2 16.5a2.5 2.5 0 012.5-2.5H8"/><path d="M10 20.5a2.5 2.5 0 01-2.5 2.5H4a2 2 0 01-2-2V16"/></svg>',
    HORN_ICON: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d19a66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.53 4.53 12 2 4 10v10h10v-4.07"/><path d="M12 10a2 2 0 00-2 2v0a2 2 0 002 2v0a2 2 0 002-2v0a2 2 0 00-2-2z"/><path d="M18 8a6 6 0 010 8"/></svg>'
}
