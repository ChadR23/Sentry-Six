import os
import sys
import shutil
import subprocess
import re
from dataclasses import dataclass
from datetime import datetime

try:
    import __main__
    DEBUG_UI = __main__.DEBUG if hasattr(__main__, 'DEBUG') else False
except (ImportError, AttributeError):
    DEBUG_UI = False

from .ffmpeg_manager import FFMPEG_EXE, FFPROBE_EXE
from .constants import (
    TESLA_FILENAME_PATTERN, DEFAULT_VIDEO_DURATION_MS, FFPROBE_TIMEOUT,
    FFPROBE_COMMON_ARGS, TIME_FORMAT_DISPLAY, SVG_ICONS, get_assets_path
)

# --- Constants ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = get_assets_path()

# Tesla filename pattern
filename_pattern = TESLA_FILENAME_PATTERN

# --- FFmpeg Functions ---
# Remove FFMPEG_PATH, FFPROBE_PATH, FFMPEG_FOUND, and find_ffmpeg logic
# Use FFMPEG_EXE and FFPROBE_EXE everywhere instead

def get_video_duration_ms(video_path):
    if not FFPROBE_EXE or not os.path.exists(video_path):
        return DEFAULT_VIDEO_DURATION_MS

    command = [FFPROBE_EXE] + FFPROBE_COMMON_ARGS + [video_path]

    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=creation_flags)
        stdout, _ = proc.communicate(timeout=FFPROBE_TIMEOUT)
        if proc.returncode == 0 and stdout:
            return int(float(stdout.strip()) * 1000)
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass  # Ignore errors and return default

    return DEFAULT_VIDEO_DURATION_MS

def format_time(ms):
    if ms is None:
        return TIME_FORMAT_DISPLAY
    seconds = max(0, ms // 1000)
    return f"{seconds // 60:02}:{seconds % 60:02}"

def setup_assets():
    """Creates the assets directory and the SVG icon files if they don't exist."""
    if not os.path.exists(ASSETS_DIR):
        os.makedirs(ASSETS_DIR)
    
    for filename, svg_data in SVG_ICONS.items():
        path = os.path.join(ASSETS_DIR, filename)
        if not os.path.exists(path):
            try:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(svg_data)
            except IOError as e:
                print(f"Could not write asset file {path}: {e}")

# Initial call to find FFmpeg on startup
# Remove FFMPEG_PATH, FFPROBE_PATH, FFMPEG_FOUND, and find_ffmpeg logic
# Use FFMPEG_EXE and FFPROBE_EXE everywhere instead

def parse_tesla_filename(filepath: str) -> dict:
    """
    Parse a Tesla video filename to extract date, time, and camera information.

    Args:
        filepath: Path to the Tesla video file

    Returns:
        Dictionary with parsed information or None if parsing fails
    """
    filename = os.path.basename(filepath)
    match = filename_pattern.match(filename)

    if not match:
        return None

    date_str, time_str, camera = match.groups()

    try:
        # Parse the datetime from the filename
        file_datetime = datetime.strptime(f"{date_str}_{time_str}", "%Y-%m-%d_%H-%M-%S")

        return {
            'filepath': filepath,
            'filename': filename,
            'date': date_str,
            'time': time_str,
            'camera': camera,
            'datetime': file_datetime
        }
    except ValueError:
        return None