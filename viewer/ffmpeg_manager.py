import os
import subprocess
import urllib.request
import zipfile
import json
import shutil
import tempfile
from datetime import datetime, timedelta
from PyQt6.QtWidgets import QMessageBox
import logging

FFMPEG_DIR = os.path.join(os.path.dirname(__file__), '..', 'ffmpeg_bin')
FFMPEG_EXE = os.path.join(FFMPEG_DIR, 'ffmpeg.exe')
FFPROBE_EXE = os.path.join(FFMPEG_DIR, 'ffprobe.exe')
CONFIG_FILE = os.path.join(FFMPEG_DIR, 'ffmpeg_update.json')
FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
CHECK_INTERVAL_DAYS = 30

LATEST_VERSION_CACHE = None

def get_ffmpeg_version_from_path(ffmpeg_path):
    if not os.path.exists(ffmpeg_path):
        return None
    try:
        result = subprocess.run([ffmpeg_path, '-version'], capture_output=True, text=True, timeout=5)
        first_line = result.stdout.splitlines()[0]
        parts = first_line.split()
        if len(parts) >= 3:
            return parts[2].split('-')[0]
    except Exception:
        return None
    return None

def get_bundled_ffmpeg_version():
    return get_ffmpeg_version_from_path(FFMPEG_EXE)

def get_last_update_check():
    if not os.path.exists(CONFIG_FILE):
        return None
    try:
        with open(CONFIG_FILE, 'r') as f:
            data = json.load(f)
        return datetime.fromisoformat(data.get('last_check'))
    except Exception:
        return None

def set_last_update_check():
    data = {'last_check': datetime.now().isoformat()}
    os.makedirs(FFMPEG_DIR, exist_ok=True)
    with open(CONFIG_FILE, 'w') as f:
        json.dump(data, f)

def is_time_to_check():
    last = get_last_update_check()
    if not last:
        return True
    return datetime.now() - last > timedelta(days=CHECK_INTERVAL_DAYS)

def get_latest_ffmpeg_version():
    global LATEST_VERSION_CACHE
    if LATEST_VERSION_CACHE:
        return LATEST_VERSION_CACHE
    tmp_zip = os.path.join(FFMPEG_DIR, 'ffmpeg_latest.zip')
    tmp_dir = tempfile.mkdtemp()
    try:
        urllib.request.urlretrieve(FFMPEG_URL, tmp_zip)
        ffmpeg_temp_path = None
        with zipfile.ZipFile(tmp_zip, 'r') as zip_ref:
            for member in zip_ref.namelist():
                if member.endswith('ffmpeg.exe'):
                    zip_ref.extract(member, tmp_dir)
                    ffmpeg_temp_path = os.path.join(tmp_dir, member)
                    break
        version = get_ffmpeg_version_from_path(ffmpeg_temp_path) if ffmpeg_temp_path else None
        LATEST_VERSION_CACHE = version
        return version
    except Exception:
        return None
    finally:
        try:
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass

def download_and_replace_ffmpeg(parent=None):
    import shutil
    tmp_zip = os.path.join(FFMPEG_DIR, 'ffmpeg_update.zip')
    os.makedirs(FFMPEG_DIR, exist_ok=True)
    try:
        # Delete old binaries if they exist
        for exe in ['ffmpeg.exe', 'ffprobe.exe']:
            exe_path = os.path.join(FFMPEG_DIR, exe)
            if os.path.exists(exe_path):
                try:
                    os.remove(exe_path)
                except Exception:
                    pass  # Ignore errors, will be overwritten anyway

        urllib.request.urlretrieve(FFMPEG_URL, tmp_zip)
        with zipfile.ZipFile(tmp_zip, 'r') as zip_ref:
            for member in zip_ref.namelist():
                if member.endswith('ffmpeg.exe') or member.endswith('ffprobe.exe'):
                    # Extract to a temp location first
                    temp_extract_path = os.path.join(FFMPEG_DIR, os.path.basename(member))
                    zip_ref.extract(member, FFMPEG_DIR)
                    src = os.path.join(FFMPEG_DIR, member)
                    dst = os.path.join(FFMPEG_DIR, os.path.basename(member))
                    # Move to ffmpeg_bin root if not already there
                    if src != dst:
                        shutil.move(src, dst)
                    # Clean up any empty folders created by extraction
                    extracted_dir = os.path.dirname(src)
                    if extracted_dir != FFMPEG_DIR and os.path.isdir(extracted_dir):
                        try:
                            os.rmdir(extracted_dir)
                        except Exception:
                            pass
        os.remove(tmp_zip)
        QMessageBox.information(parent, "FFmpeg Updated", "FFmpeg has been updated to the latest version.")
    except Exception as e:
        QMessageBox.warning(parent, "FFmpeg Update Failed", f"Could not update FFmpeg: {e}")

def ensure_ffmpeg_up_to_date(parent=None):
    # Always use bundled ffmpeg, but check for updates once a month
    logging.info(f"Checking for FFmpeg at: {FFMPEG_EXE}")
    exists = os.path.exists(FFMPEG_EXE)
    logging.info(f"FFmpeg exists: {exists}")
    if not exists:
        msg = f"Bundled FFmpeg is missing. The app may not function correctly.\n\nExpected path: {FFMPEG_EXE}\nExists: {exists}"
        logging.error(msg)
        QMessageBox.critical(parent, "FFmpeg Missing", msg)
        return
    if not is_time_to_check():
        return
    set_last_update_check()
    try:
        urllib.request.urlopen('https://www.google.com', timeout=3)
    except Exception:
        QMessageBox.information(parent, "FFmpeg Update", "No internet connection detected. Using bundled FFmpeg. Could not check for updates.")
        return
    bundled_version = get_bundled_ffmpeg_version()
    latest_version = get_latest_ffmpeg_version()
    if not latest_version or not bundled_version:
        QMessageBox.information(parent, "FFmpeg Update", "Could not determine FFmpeg version. Using bundled version.")
        return
    if bundled_version != latest_version:
        reply = QMessageBox.question(
            parent, "FFmpeg Update Available",
            f"A new version of FFmpeg is available (current: {bundled_version}, latest: {latest_version}).\nWould you like to update now?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            download_and_replace_ffmpeg(parent)
        else:
            QMessageBox.information(parent, "FFmpeg", "Continuing with the bundled FFmpeg version.")
    else:
        pass 