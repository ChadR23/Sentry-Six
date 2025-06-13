import sys
import os

DEBUG = True     # Set to True for detailed logs, False to hide console output

if not DEBUG:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

from PyQt6.QtWidgets import QApplication
from viewer.ui import TeslaCamViewer

if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setOrganizationName("TeslaCamViewerAdvanced") # Ensure these are set
    app.setApplicationName("TeslaCamViewerAdvanced")      # For QSettings

    app.setStyleSheet("""
        QWidget {
            background-color: #282c34;
            color: #abb2bf;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 11pt;
        }
        QPushButton {
            background-color: #3a3f4b;
            color: #e0e0e0;
            border: 1px solid #20232a;
            padding: 7px 12px;
            border-radius: 4px;
            min-height: 22px;
        }
        QPushButton:hover {
            background-color: #4c5260;
            border: 1px solid #3a3f4b;
        }
        QPushButton:pressed {
            background-color: #30353f;
        }
        QPushButton:disabled {
            background-color: #30353f;
            color: #6a7180;
            border-color: #2a2e37;
        }
        QSlider::groove:horizontal {
            background: #3a3f4b;
            height: 8px;
            border-radius: 4px;
        }
        QSlider::handle:horizontal {
            background: #61afef;
            width: 16px;
            margin: -4px 0;
            border-radius: 8px;
            border: 1px solid #282c34;
        }
        QComboBox {
            background-color: #3a3f4b;
            border: 1px solid #20232a;
            padding: 4px 8px; 
            border-radius: 4px;
            min-height: 22px;
            min-width: 120px; 
            combobox-popup: 0; 
        }
        QComboBox:focus { border: 1px solid #61afef; }
        QComboBox::drop-down {
            subcontrol-origin: padding; subcontrol-position: top right;
            width: 22px; border-left-width: 1px; border-left-color: #20232a;
            border-left-style: solid; border-top-right-radius: 3px; border-bottom-right-radius: 3px;
        }
        QComboBox::down-arrow { image: none; }
        QComboBox QAbstractItemView {
            background-color: #2c313a; border: 1px solid #20232a; color: #abb2bf;
            selection-background-color: #61afef; selection-color: #282c34; padding: 3px; 
        }
        QLabel { color: #abb2bf; padding: 3px;}
        QRadioButton { spacing: 6px; color: #abb2bf; padding: 2px; }
        QRadioButton::indicator { width: 14px; height: 14px; border-radius: 8px; border: 2px solid #4c5260; }
        QRadioButton::indicator:unchecked { background-color: #282c34; }
        QRadioButton::indicator:checked { background-color: #61afef; border: 2px solid #528bcc; }
        QRadioButton::indicator:checked:hover { border: 2px solid #61afef; }
        QRadioButton::indicator:unchecked:hover { border: 2px solid #61afef; }
        
        QCheckBox { spacing: 6px; color: #abb2bf; padding: 2px; }
        QCheckBox::indicator { width: 14px; height: 14px; border-radius: 3px; border: 2px solid #4c5260; background-color: #282c34;}
        QCheckBox::indicator:hover { border: 2px solid #61afef; }
        QCheckBox::indicator:checked {
            background-color: #61afef;
            border: 2px solid #528bcc;
            image: url(./assets/check.svg);
        }
        
        /* QGraphicsView styling */
        QGraphicsView {
            background-color: #000000; /* Black background for video area */
            border: 1px solid #1a1d23; /* Subtle border */
        }
        QMenu {
            background-color: #2c313a; border: 1px solid #20232a; color: #abb2bf; padding: 4px;
        }
        QMenu::item { padding: 4px 20px 4px 20px; }
        QMenu::item:selected { background-color: #61afef; color: #282c34; }
        QMenu::indicator { width: 13px; height: 13px; }

        QFileDialog, QInputDialog, QMessageBox, QProgressDialog { background-color: #282c34; color: #abb2bf; }
        QFileDialog QLabel, QInputDialog QLabel, QMessageBox QLabel, QProgressDialog QLabel, 
        QInputDialog QLineEdit { 
            color: #abb2bf; background-color: #3a3f4b; 
            border: 1px solid #20232a; padding: 4px; border-radius: 3px;
        }
        QFileDialog QPushButton, QInputDialog QPushButton, QMessageBox QPushButton, QProgressDialog QPushButton {
            background-color: #3a3f4b; color: #e0e0e0; border: 1px solid #20232a;
            padding: 6px 10px; border-radius: 3px;
        }
        QFileDialog QPushButton:hover, QInputDialog QPushButton:hover, QMessageBox QPushButton:hover, QProgressDialog QPushButton:hover {
            background-color: #4c5260;
        }
        QProgressBar {
            border: 1px solid #4c5260;
            border-radius: 4px;
            text-align: center;
            background-color: #3a3f4b;
            color: #e0e0e0;
        }
        QProgressBar::chunk {
            background-color: #61afef;
            border-radius: 4px;
        }
    """)

    assets_dir = 'assets'
    if not os.path.exists(assets_dir):
        os.makedirs(assets_dir)
    
    # --- FIX: Replaced icons with better, clearer versions ---
    icons = {
        'check.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#282c34" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        'camera.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e06c75" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>',
        'hand.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c678dd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5l3.5 3.5.9-1.8"/><path d="M20 13.3c.2-.3.2-.7 0-1l-3-5a2 2 0 00-3.5 0l-3.5 6a2 2 0 002 3h9.4a2 2 0 011.6.8L22 22V8.5A2.5 2.5 0 0019.5 6Z"/><path d="M2 16.5a2.5 2.5 0 012.5-2.5H8"/><path d="M10 20.5a2.5 2.5 0 01-2.5 2.5H4a2 2 0 01-2-2V16"/></svg>',
        'horn.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d19a66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.53 4.53 12 2 4 10v10h10v-4.07"/><path d="M12 10a2 2 0 00-2 2v0a2 2 0 002 2v0a2 2 0 002-2v0a2 2 0 00-2-2z"/><path d="M18 8a6 6 0 010 8"/></svg>'
    }

    for filename, svg_data in icons.items():
        path = os.path.join(assets_dir, filename)
        if not os.path.exists(path):
            with open(path, 'w') as f:
                f.write(svg_data)

    viewer = TeslaCamViewer()
    viewer.show()
    sys.exit(app.exec())