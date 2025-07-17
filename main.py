import sys
import os
import logging

# Set up logging
log_dir = os.path.join(os.path.expanduser("~"), ".sentry_six_logs")
os.makedirs(log_dir, exist_ok=True)
log_file = os.path.join(log_dir, "sentry_six.log")

logging.basicConfig(
    level=logging.INFO,  # Change to DEBUG for more detail
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler()  # Optional: also log to console
    ]
)

def log_uncaught_exceptions(exctype, value, tb):
    import traceback
    logging.critical("Uncaught exception", exc_info=(exctype, value, tb))
    # Optionally, show a user-friendly message box here

sys.excepthook = log_uncaught_exceptions

# Set to True for detailed logs, False to hide console output
DEBUG = True
# Show first-time welcome dialog (folder picker)
SHOW_WELCOME = True

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
    app = QApplication(sys.argv)
    
    # These must be set for QSettings to work correctly on all platforms
    app.setOrganizationName("JR Media")
    app.setApplicationName("SentrySix")

    # Set application icon
    app.setWindowIcon(QIcon(os.path.join(os.path.dirname(__file__), 'assets', 'Sentry_six.ico')))

    # Create asset files if they don't exist
    utils.setup_assets()
    
    # Load stylesheet from file
    style_path = os.path.join(os.path.dirname(__file__), 'viewer', 'style.qss')
    try:
        with open(style_path, 'r', encoding='utf-8') as f:
            app.setStyleSheet(f.read())
    except FileNotFoundError:
        logging.warning(f"Stylesheet not found at {style_path}")
    except IOError as e:
        logging.warning(f"Could not read stylesheet {style_path}: {e}")

    # Create and show the main window
    viewer = TeslaCamViewer(show_welcome=SHOW_WELCOME)
    viewer.show()
    # Start the application event loop
    sys.exit(app.exec())

if __name__ == '__main__':
    main()