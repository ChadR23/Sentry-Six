import requests
import os
import sys
from viewer.version import __version__
from .constants import GITHUB_REPO, UPDATE_CHECK_TIMEOUT

GITHUB_REPO_NAME = GITHUB_REPO

def get_latest_release():
    url = f'https://api.github.com/repos/{GITHUB_REPO_NAME}/releases/latest'
    logging.info(f"Checking for latest release from {url}")
    try:
        response = requests.get(url, timeout=UPDATE_CHECK_TIMEOUT)
        response.raise_for_status()
        logging.info("Successfully fetched latest release info.")
        return response.json()
    except Exception as e:
        logging.exception(f"Failed to fetch latest release info: {e}")
        raise

def check_for_update():
    latest = get_latest_release()
    latest_version = latest['tag_name'].lstrip('v')
    if latest_version > __version__:
        for asset in latest['assets']:
            if asset['name'].endswith('.exe'):
                return asset['browser_download_url'], latest_version
    return None, None

def download_and_run_installer(url):
    local_path = os.path.join(os.path.expanduser('~'), 'Downloads', os.path.basename(url))
    with requests.get(url, stream=True) as r:
        r.raise_for_status()
        with open(local_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
    os.startfile(local_path)
    sys.exit(0) 