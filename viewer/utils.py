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

# --- Constants ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(os.path.dirname(BASE_DIR), 'assets')

# Remove FFMPEG_PATH, FFPROBE_PATH, FFMPEG_FOUND, and find_ffmpeg logic
# Use FFMPEG_EXE and FFPROBE_EXE everywhere instead

filename_pattern = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(front|left_repeater|right_repeater|back|left_pillar|right_pillar)\.mp4")

# --- FFmpeg Functions ---
# Remove FFMPEG_PATH, FFPROBE_PATH, FFMPEG_FOUND, and find_ffmpeg logic
# Use FFMPEG_EXE and FFPROBE_EXE everywhere instead

def get_video_duration_ms(video_path):
    if not FFPROBE_EXE or not os.path.exists(video_path):
        return 60000  # Default to 1 minute if ffprobe is not found or file doesn't exist

    command = [
        FFPROBE_EXE,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path
    ]
    
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=creation_flags)
        stdout, _ = proc.communicate(timeout=5)  # 5-second timeout
        if proc.returncode == 0 and stdout:
            return int(float(stdout.strip()) * 1000)
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass  # Ignore errors and return default

    return 60000

def format_time(ms):
    if ms is None:
        return "--:--"
    seconds = max(0, ms // 1000)
    return f"{seconds // 60:02}:{seconds % 60:02}"

def setup_assets():
    """Creates the assets directory and the SVG icon files if they don't exist."""
    if not os.path.exists(ASSETS_DIR):
        os.makedirs(ASSETS_DIR)
    
    icons = {
        'check.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#282c34" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        'camera.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e06c75" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>',
        'hand.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c678dd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5l3.5 3.5.9-1.8"/><path d="M20 13.3c.2-.3.2-.7 0-1l-3-5a2 2 0 00-3.5 0l-3.5 6a2 2 0 002 3h9.4a2 2 0 011.6.8L22 22V8.5A2.5 2.5 0 0019.5 6Z"/><path d="M2 16.5a2.5 2.5 0 012.5-2.5H8"/><path d="M10 20.5a2.5 2.5 0 01-2.5 2.5H4a2 2 0 01-2-2V16"/></svg>',
        'horn.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d19a66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.53 4.53 12 2 4 10v10h10v-4.07"/><path d="M12 10a2 2 0 00-2 2v0a2 2 0 002 2v0a2 2 0 002-2v0a2 2 0 00-2-2z"/><path d="M18 8a6 6 0 010 8"/></svg>'
    }

    for filename, svg_data in icons.items():
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