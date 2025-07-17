import sys
import os

from viewer.constants import (
    APP_NAME, APP_ORGANIZATION, ICON_FILE, STYLESHEET_FILE,
    get_assets_path
)
from viewer.logging_config import SentryLogger, setup_exception_logging, get_logger
from viewer.resource_manager import register_exit_cleanup

# Set to True for detailed logs, False to hide console output
DEBUG = True
# Show first-time welcome dialog (folder picker)
SHOW_WELCOME = True

# Initialize logging system
sentry_logger = SentryLogger()
sentry_logger.setup_logging(debug_mode=DEBUG)
logger = get_logger(__name__)
setup_exception_logging()

# Log system information
sentry_logger.log_system_info()

# Register cleanup handlers
register_exit_cleanup()

if not DEBUG:
    # Redirect stdout and stderr to devnull to hide console output on Windows
    # when running from a pythonw.exe interpreter.
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

from PyQt6.QtWidgets import QApplication
from PyQt6.QtGui import QIcon
from viewer.ui import TeslaCamViewer
from viewer import utils

def main():
    logger.info("Starting SentrySix application")

    app = QApplication(sys.argv)

    # These must be set for QSettings to work correctly on all platforms
    app.setOrganizationName(APP_ORGANIZATION)
    app.setApplicationName(APP_NAME)
    logger.info(f"Application configured: {APP_ORGANIZATION} - {APP_NAME}")

    # Set application icon
    icon_path = get_assets_path() / ICON_FILE
    app.setWindowIcon(QIcon(str(icon_path)))
    logger.debug(f"Application icon set: {icon_path}")

    # Create asset files if they don't exist
    utils.setup_assets()
    logger.debug("Asset files setup completed")

    # Load stylesheet from file
    style_path = os.path.join(os.path.dirname(__file__), 'viewer', STYLESHEET_FILE)
    try:
        with open(style_path, 'r', encoding='utf-8') as f:
            app.setStyleSheet(f.read())
        logger.info(f"Stylesheet loaded successfully: {style_path}")
    except FileNotFoundError:
        logger.warning(f"Stylesheet not found at {style_path}")
    except IOError as e:
        logger.warning(f"Could not read stylesheet {style_path}: {e}")

    # Create and show the main window
    logger.info("Creating main window")
    viewer = TeslaCamViewer(show_welcome=SHOW_WELCOME)
    viewer.show()
    logger.info("Main window displayed, starting event loop")

    # Start the application event loop
    exit_code = app.exec()
    logger.info(f"Application exiting with code: {exit_code}")
    sys.exit(exit_code)

if __name__ == '__main__':
    main()