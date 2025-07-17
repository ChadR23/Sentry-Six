import requests
import os
import sys
import logging
from viewer.version import __version__

GITHUB_REPO = 'ChadR23/Sentry-Six'

def get_latest_release():
    url = f'https://api.github.com/repos/{GITHUB_REPO}/releases/latest'
    logging.info(f"Checking for latest release from {url}")
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        logging.info("Successfully fetched latest release info.")
        return response.json()
    except Exception as e:
        logging.exception(f"Failed to fetch latest release info: {e}")
        raise

def check_for_update():
    try:
        latest = get_latest_release()
        latest_version = latest['tag_name'].lstrip('v')
        if latest_version > __version__:
            for asset in latest['assets']:
                if asset['name'].endswith('.exe'):
                    logging.info(f"Update available: {latest_version} (current: {__version__})")
                    return asset['browser_download_url'], latest_version
        logging.info("No update available. Current version is up to date.")
        return None, None
    except Exception as e:
        logging.exception(f"Error during update check: {e}")
        raise

def download_and_run_installer(url):
    local_path = os.path.join(os.path.expanduser('~'), 'Downloads', os.path.basename(url))
    logging.info(f"Downloading installer from {url} to {local_path}")
    try:
        with requests.get(url, stream=True) as r:
            r.raise_for_status()
            with open(local_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
        logging.info(f"Installer downloaded successfully to {local_path}")
        os.startfile(local_path)
        logging.info("Installer launched. Exiting application.")
        sys.exit(0)
    except Exception as e:
        logging.exception(f"Failed to download or run installer: {e}")
        raise 