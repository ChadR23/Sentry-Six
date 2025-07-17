"""
Configuration Manager for SentrySix.

This module handles application settings, user preferences, and configuration management.
Provides centralized configuration storage with automatic persistence and validation.
"""

import os
import json
from typing import Any, Dict, Optional, List, Union
from pathlib import Path
from PyQt6.QtCore import QObject, pyqtSignal, QSettings
from PyQt6.QtWidgets import QMessageBox

from .base import BaseManager


class ConfigurationManagerSignals(QObject):
    """Signals for ConfigurationManager communication with UI and other managers."""

    # Configuration change signals
    setting_changed = pyqtSignal(str, object)  # setting_key, new_value
    settings_loaded = pyqtSignal()
    settings_saved = pyqtSignal()
    settings_reset = pyqtSignal()

    # Preference signals
    preference_changed = pyqtSignal(str, object)  # preference_key, new_value
    theme_changed = pyqtSignal(str)  # theme_name
    language_changed = pyqtSignal(str)  # language_code

    # Configuration validation signals
    validation_failed = pyqtSignal(str, str)  # setting_key, error_message
    configuration_corrupted = pyqtSignal(str)  # error_message

    # Profile management signals
    profile_created = pyqtSignal(str)  # profile_name
    profile_loaded = pyqtSignal(str)  # profile_name
    profile_deleted = pyqtSignal(str)  # profile_name


class ConfigurationManager(BaseManager):
    """
    Manages application configuration, settings, and user preferences.

    Handles:
    - Application settings (window geometry, playback preferences, etc.)
    - User preferences (themes, language, export defaults)
    - Configuration validation and migration
    - Profile management for different user configurations
    - Automatic persistence and loading
    """

    # Default configuration schema
    DEFAULT_SETTINGS = {
        # Application settings
        'app': {
            'version': '1.0.0',
            'first_run': True,
            'window_geometry': None,
            'window_state': None,
            'last_folder_path': '',
            'auto_load_latest': False,
            'check_updates': True,
        },
        
        # Playback settings
        'playback': {
            'default_speed': 1.0,
            'auto_play_on_load': True,
            'loop_playback': False,
            'hardware_acceleration': True,
            'preload_segments': True,
            'sync_tolerance_ms': 100,
        },
        
        # UI preferences
        'ui': {
            'theme': 'dark',
            'language': 'en',
            'show_tooltips': True,
            'compact_mode': False,
            'camera_labels': True,
            'timeline_precision': 'seconds',
        },
        
        # Export settings
        'export': {
            'default_format': 'mp4',
            'default_quality': 'high',
            'mobile_optimization': False,
            'include_audio': False,
            'output_directory': '',
            'filename_template': '{date}_{time}_{cameras}',
        },
        
        # Camera settings
        'cameras': {
            'default_layout': 'grid_2x3',
            'visible_cameras': ['front', 'back', 'left_pillar', 'right_pillar', 'left_repeater', 'right_repeater'],
            'camera_order': [0, 1, 2, 3, 4, 5],
            'auto_hide_empty': True,
        },
        
        # Performance settings
        'performance': {
            'max_cache_size_mb': 512,
            'thumbnail_cache_enabled': True,
            'background_processing': True,
            'cpu_threads': -1,  # -1 = auto-detect
            'memory_limit_mb': 1024,
        },

        # Logging settings
        'logging': {
            'default_level': 'INFO',
            'debug_mode': False,
            'console_enabled': True,
            'file_enabled': True,
            'max_file_size_mb': 10,
            'max_backup_count': 5,
            'retention_days': 30,
            'performance_logging': True,
        },

        # Cache settings
        'cache': {
            'thumbnails_enabled': True,
            'metadata_enabled': True,
            'video_info_enabled': True,
            'user_data_enabled': True,
            'temp_enabled': True,
            'cleanup_interval_minutes': 30,
            'memory_cache_limit': 100,
        },

        # Plugin settings
        'plugins': {
            'auto_load': True,
            'enable_third_party': True,
            'security_enabled': True,
            'discovery_enabled': True,
        }
    }

    def __init__(self, parent_widget, dependency_container):
        """Initialize the ConfigurationManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = ConfigurationManagerSignals()

        # Configuration storage
        self.settings: Dict[str, Any] = {}
        self.profiles: Dict[str, Dict[str, Any]] = {}
        self.current_profile: str = 'default'

        # Consolidated directory structure
        self.base_dir = Path.home() / '.sentrysix'
        self.config_dir = self.base_dir / 'config'
        self.logs_dir = self.base_dir / 'logs'
        self.cache_dir = self.base_dir / 'cache'

        # Configuration files
        self.settings_file = self.config_dir / 'settings.json'
        self.profiles_file = self.config_dir / 'profiles.json'
        self.migration_marker = self.base_dir / '.migration_completed'

        # Legacy paths for migration detection
        self.legacy_paths = [
            Path.home() / '.sentrysix' / 'settings.json',  # Old direct location
            Path.home() / '.sentrysix_config',  # Potential old config dir
            Path.home() / '.config' / 'sentrysix',  # XDG config location
        ]

        # Qt Settings for system integration
        self.qt_settings = QSettings('JR Media', 'SentrySix')

        # Validation rules
        self.validation_rules = self._setup_validation_rules()

        self.logger.debug("ConfigurationManager created")

    def initialize(self) -> bool:
        """
        Initialize configuration manager.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Create consolidated directory structure
            self._create_directory_structure()

            # Perform one-time migration from old file organization
            self._perform_migration_if_needed()

            # Load existing configuration or create defaults
            self._load_configuration()

            # Validate configuration
            if not self._validate_configuration():
                self.logger.warning("Configuration validation failed, using defaults")
                self._reset_to_defaults()

            # Load profiles
            self._load_profiles()

            # Migrate configuration version if needed
            self._migrate_configuration_version()

            # Save current state to ensure persistence
            self.save_configuration()

            self.logger.info("ConfigurationManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "ConfigurationManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up configuration resources."""
        try:
            self._mark_cleanup_started()

            # Save current configuration
            self.save_configuration()

            # Save profiles
            self._save_profiles()

            # Sync Qt settings
            self.qt_settings.sync()

            self.logger.info("ConfigurationManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "ConfigurationManager cleanup")

    # ========================================
    # Configuration Management
    # ========================================

    def get_setting(self, key: str, default: Any = None) -> Any:
        """
        Get a configuration setting value.

        Args:
            key: Setting key in dot notation (e.g., 'app.version', 'playback.default_speed')
            default: Default value if setting doesn't exist

        Returns:
            Setting value or default
        """
        try:
            keys = key.split('.')
            value = self.settings

            for k in keys:
                if isinstance(value, dict) and k in value:
                    value = value[k]
                else:
                    return default

            return value

        except Exception as e:
            self.handle_error(e, f"get_setting({key})")
            return default

    def set_setting(self, key: str, value: Any, save: bool = True) -> bool:
        """
        Set a configuration setting value.

        Args:
            key: Setting key in dot notation
            value: New value to set
            save: Whether to immediately save to disk

        Returns:
            bool: True if setting was successfully set
        """
        try:
            # Validate the setting
            if not self._validate_setting(key, value):
                return False

            # Navigate to the setting location
            keys = key.split('.')
            current = self.settings

            # Navigate to parent of target key
            for k in keys[:-1]:
                if k not in current:
                    current[k] = {}
                current = current[k]

            # Set the value
            old_value = current.get(keys[-1])
            current[keys[-1]] = value

            # Emit signal if value changed
            if old_value != value:
                self.signals.setting_changed.emit(key, value)

                # Emit specific signals for important settings
                if key == 'ui.theme':
                    self.signals.theme_changed.emit(value)
                elif key == 'ui.language':
                    self.signals.language_changed.emit(value)

            # Save if requested
            if save:
                self.save_configuration()

            self.logger.debug(f"Setting updated: {key} = {value}")
            return True

        except Exception as e:
            self.handle_error(e, f"set_setting({key}, {value})")
            return False

    def get_all_settings(self) -> Dict[str, Any]:
        """Get all configuration settings."""
        return self.settings.copy()

    def update_settings(self, settings_dict: Dict[str, Any], save: bool = True) -> bool:
        """
        Update multiple settings at once.

        Args:
            settings_dict: Dictionary of settings to update
            save: Whether to save after updating

        Returns:
            bool: True if all settings were updated successfully
        """
        try:
            success = True
            for key, value in settings_dict.items():
                if not self.set_setting(key, value, save=False):
                    success = False

            if save and success:
                self.save_configuration()

            return success

        except Exception as e:
            self.handle_error(e, f"update_settings({len(settings_dict)} items)")
            return False

    def reset_setting(self, key: str, save: bool = True) -> bool:
        """Reset a setting to its default value."""
        try:
            default_value = self._get_default_setting(key)
            if default_value is not None:
                return self.set_setting(key, default_value, save)
            return False

        except Exception as e:
            self.handle_error(e, f"reset_setting({key})")
            return False

    def save_configuration(self) -> bool:
        """Save current configuration to disk."""
        try:
            # Save to JSON file
            with open(self.settings_file, 'w', encoding='utf-8') as f:
                json.dump(self.settings, f, indent=2, ensure_ascii=False)

            # Save important settings to Qt settings for system integration
            self._save_qt_settings()

            self.signals.settings_saved.emit()
            self.logger.debug("Configuration saved successfully")
            return True

        except Exception as e:
            self.handle_error(e, "save_configuration")
            return False

    def load_configuration(self) -> bool:
        """Load configuration from disk."""
        try:
            self._load_configuration()
            self.signals.settings_loaded.emit()
            return True

        except Exception as e:
            self.handle_error(e, "load_configuration")
            return False

    def reset_to_defaults(self) -> bool:
        """Reset all settings to default values."""
        try:
            self._reset_to_defaults()
            self.save_configuration()
            self.signals.settings_reset.emit()
            self.logger.info("Configuration reset to defaults")
            return True

        except Exception as e:
            self.handle_error(e, "reset_to_defaults")
            return False

    # ========================================
    # Profile Management
    # ========================================

    def create_profile(self, profile_name: str, copy_current: bool = True) -> bool:
        """
        Create a new configuration profile.

        Args:
            profile_name: Name of the new profile
            copy_current: Whether to copy current settings to new profile

        Returns:
            bool: True if profile was created successfully
        """
        try:
            if profile_name in self.profiles:
                self.logger.warning(f"Profile '{profile_name}' already exists")
                return False

            if copy_current:
                self.profiles[profile_name] = self.settings.copy()
            else:
                self.profiles[profile_name] = self._get_default_settings()

            self._save_profiles()
            self.signals.profile_created.emit(profile_name)
            self.logger.info(f"Profile '{profile_name}' created")
            return True

        except Exception as e:
            self.handle_error(e, f"create_profile({profile_name})")
            return False

    def load_profile(self, profile_name: str) -> bool:
        """Load a configuration profile."""
        try:
            if profile_name not in self.profiles:
                self.logger.warning(f"Profile '{profile_name}' not found")
                return False

            # Save current profile
            self.profiles[self.current_profile] = self.settings.copy()

            # Load new profile
            self.settings = self.profiles[profile_name].copy()
            self.current_profile = profile_name

            # Save profiles and settings
            self._save_profiles()
            self.save_configuration()

            self.signals.profile_loaded.emit(profile_name)
            self.logger.info(f"Profile '{profile_name}' loaded")
            return True

        except Exception as e:
            self.handle_error(e, f"load_profile({profile_name})")
            return False

    def delete_profile(self, profile_name: str) -> bool:
        """Delete a configuration profile."""
        try:
            if profile_name == 'default':
                self.logger.warning("Cannot delete default profile")
                return False

            if profile_name not in self.profiles:
                self.logger.warning(f"Profile '{profile_name}' not found")
                return False

            # Switch to default if deleting current profile
            if profile_name == self.current_profile:
                self.load_profile('default')

            del self.profiles[profile_name]
            self._save_profiles()

            self.signals.profile_deleted.emit(profile_name)
            self.logger.info(f"Profile '{profile_name}' deleted")
            return True

        except Exception as e:
            self.handle_error(e, f"delete_profile({profile_name})")
            return False

    def get_profiles(self) -> List[str]:
        """Get list of available profiles."""
        return list(self.profiles.keys())

    def get_current_profile(self) -> str:
        """Get current profile name."""
        return self.current_profile

    # ========================================
    # Helper Methods
    # ========================================

    def _load_configuration(self) -> None:
        """Load configuration from file or create defaults."""
        try:
            if self.settings_file.exists():
                with open(self.settings_file, 'r', encoding='utf-8') as f:
                    self.settings = json.load(f)
                self.logger.debug("Configuration loaded from file")
            else:
                self.settings = self._get_default_settings()
                self.logger.debug("Using default configuration")

        except (json.JSONDecodeError, IOError) as e:
            self.logger.warning(f"Error loading configuration: {e}, using defaults")
            self.settings = self._get_default_settings()

    def _get_default_settings(self) -> Dict[str, Any]:
        """Get a deep copy of default settings."""
        import copy
        return copy.deepcopy(self.DEFAULT_SETTINGS)

    def _get_default_setting(self, key: str) -> Any:
        """Get default value for a specific setting."""
        try:
            keys = key.split('.')
            value = self.DEFAULT_SETTINGS

            for k in keys:
                if isinstance(value, dict) and k in value:
                    value = value[k]
                else:
                    return None

            return value

        except Exception:
            return None

    def _validate_configuration(self) -> bool:
        """Validate the current configuration."""
        try:
            # Check if all required sections exist
            required_sections = ['app', 'playback', 'ui', 'export', 'cameras', 'performance']
            for section in required_sections:
                if section not in self.settings:
                    self.logger.warning(f"Missing configuration section: {section}")
                    return False

            # Validate specific settings
            for key, rule in self.validation_rules.items():
                value = self.get_setting(key)
                if not self._validate_setting_with_rule(key, value, rule):
                    return False

            return True

        except Exception as e:
            self.handle_error(e, "_validate_configuration")
            return False

    def _validate_setting(self, key: str, value: Any) -> bool:
        """Validate a single setting."""
        try:
            if key in self.validation_rules:
                rule = self.validation_rules[key]
                return self._validate_setting_with_rule(key, value, rule)
            return True

        except Exception as e:
            self.handle_error(e, f"_validate_setting({key}, {value})")
            return False

    def _validate_setting_with_rule(self, key: str, value: Any, rule: Dict[str, Any]) -> bool:
        """Validate a setting against a specific rule."""
        try:
            # Type validation
            if 'type' in rule and not isinstance(value, rule['type']):
                self.signals.validation_failed.emit(key, f"Invalid type for {key}")
                return False

            # Range validation for numbers
            if 'min' in rule and value < rule['min']:
                self.signals.validation_failed.emit(key, f"{key} below minimum value")
                return False

            if 'max' in rule and value > rule['max']:
                self.signals.validation_failed.emit(key, f"{key} above maximum value")
                return False

            # Choice validation
            if 'choices' in rule and value not in rule['choices']:
                self.signals.validation_failed.emit(key, f"Invalid choice for {key}")
                return False

            return True

        except Exception as e:
            self.handle_error(e, f"_validate_setting_with_rule({key})")
            return False

    def _setup_validation_rules(self) -> Dict[str, Dict[str, Any]]:
        """Set up validation rules for settings."""
        return {
            'playback.default_speed': {'type': (int, float), 'min': 0.1, 'max': 4.0},
            'ui.theme': {'type': str, 'choices': ['light', 'dark', 'auto']},
            'ui.language': {'type': str, 'choices': ['en', 'es', 'fr', 'de', 'zh']},
            'export.default_quality': {'type': str, 'choices': ['low', 'medium', 'high', 'ultra']},
            'performance.max_cache_size_mb': {'type': int, 'min': 64, 'max': 4096},
            'performance.cpu_threads': {'type': int, 'min': -1, 'max': 32},
        }

    def _reset_to_defaults(self) -> None:
        """Reset configuration to default values."""
        self.settings = self._get_default_settings()

    def _create_directory_structure(self) -> None:
        """Create the consolidated directory structure."""
        try:
            # Create all necessary directories
            directories = [self.base_dir, self.config_dir, self.logs_dir, self.cache_dir]

            for directory in directories:
                directory.mkdir(parents=True, exist_ok=True)
                self.logger.debug(f"Created directory: {directory}")

        except Exception as e:
            self.handle_error(e, "_create_directory_structure")

    def _perform_migration_if_needed(self) -> None:
        """Perform one-time migration from old file organization."""
        try:
            # Check if migration has already been completed
            if self.migration_marker.exists():
                self.logger.debug("Migration already completed, skipping")
                return

            # Check for legacy files and migrate them
            migrated_files = []

            for legacy_path in self.legacy_paths:
                if legacy_path.exists():
                    migrated_files.extend(self._migrate_from_legacy_path(legacy_path))

            # Migrate any files from the old base directory structure
            old_base_settings = self.base_dir / 'settings.json'
            old_base_profiles = self.base_dir / 'profiles.json'

            if old_base_settings.exists() and old_base_settings != self.settings_file:
                self._migrate_file(old_base_settings, self.settings_file)
                migrated_files.append(str(old_base_settings))

            if old_base_profiles.exists() and old_base_profiles != self.profiles_file:
                self._migrate_file(old_base_profiles, self.profiles_file)
                migrated_files.append(str(old_base_profiles))

            # Create migration marker
            self.migration_marker.touch()

            if migrated_files:
                self.logger.info(f"Migration completed. Migrated {len(migrated_files)} files to new structure")
                self.logger.debug(f"Migrated files: {migrated_files}")
            else:
                self.logger.debug("No legacy files found to migrate")

        except Exception as e:
            self.handle_error(e, "_perform_migration_if_needed")

    def _migrate_from_legacy_path(self, legacy_path: Path) -> List[str]:
        """Migrate files from a legacy path location."""
        migrated_files = []

        try:
            if legacy_path.is_file():
                # Single file migration
                if legacy_path.name == 'settings.json':
                    self._migrate_file(legacy_path, self.settings_file)
                    migrated_files.append(str(legacy_path))
                elif legacy_path.name == 'profiles.json':
                    self._migrate_file(legacy_path, self.profiles_file)
                    migrated_files.append(str(legacy_path))

            elif legacy_path.is_dir():
                # Directory migration
                for file_path in legacy_path.iterdir():
                    if file_path.name == 'settings.json':
                        self._migrate_file(file_path, self.settings_file)
                        migrated_files.append(str(file_path))
                    elif file_path.name == 'profiles.json':
                        self._migrate_file(file_path, self.profiles_file)
                        migrated_files.append(str(file_path))
                    elif file_path.suffix == '.log':
                        # Migrate log files to new logs directory
                        new_log_path = self.logs_dir / file_path.name
                        self._migrate_file(file_path, new_log_path)
                        migrated_files.append(str(file_path))

                # Remove empty legacy directory
                if legacy_path.exists() and not any(legacy_path.iterdir()):
                    legacy_path.rmdir()
                    self.logger.debug(f"Removed empty legacy directory: {legacy_path}")

        except Exception as e:
            self.handle_error(e, f"_migrate_from_legacy_path({legacy_path})")

        return migrated_files

    def _migrate_file(self, source: Path, destination: Path) -> None:
        """Migrate a single file from source to destination."""
        try:
            if source.exists() and source != destination:
                # Ensure destination directory exists
                destination.parent.mkdir(parents=True, exist_ok=True)

                # Copy file content
                import shutil
                shutil.copy2(source, destination)

                # Remove original file
                source.unlink()

                self.logger.debug(f"Migrated file: {source} -> {destination}")

        except Exception as e:
            self.handle_error(e, f"_migrate_file({source}, {destination})")

    def _migrate_configuration_version(self) -> None:
        """Migrate configuration from older versions if needed."""
        try:
            current_version = self.get_setting('app.version', '0.0.0')

            # Add migration logic here for future versions
            if current_version != self.DEFAULT_SETTINGS['app']['version']:
                self.set_setting('app.version', self.DEFAULT_SETTINGS['app']['version'], save=False)
                self.logger.info(f"Configuration version migrated from {current_version}")

        except Exception as e:
            self.handle_error(e, "_migrate_configuration_version")

    def _load_profiles(self) -> None:
        """Load profiles from file."""
        try:
            if self.profiles_file.exists():
                with open(self.profiles_file, 'r', encoding='utf-8') as f:
                    self.profiles = json.load(f)
            else:
                self.profiles = {'default': self.settings.copy()}

            # Ensure default profile exists
            if 'default' not in self.profiles:
                self.profiles['default'] = self._get_default_settings()

        except Exception as e:
            self.handle_error(e, "_load_profiles")
            self.profiles = {'default': self.settings.copy()}

    def _save_profiles(self) -> None:
        """Save profiles to file."""
        try:
            with open(self.profiles_file, 'w', encoding='utf-8') as f:
                json.dump(self.profiles, f, indent=2, ensure_ascii=False)

        except Exception as e:
            self.handle_error(e, "_save_profiles")

    def _save_qt_settings(self) -> None:
        """Save important settings to Qt settings for system integration."""
        try:
            # Save window geometry and state
            if self.get_setting('app.window_geometry'):
                self.qt_settings.setValue('geometry', self.get_setting('app.window_geometry'))
            if self.get_setting('app.window_state'):
                self.qt_settings.setValue('windowState', self.get_setting('app.window_state'))

            # Save last folder path
            self.qt_settings.setValue('lastFolderPath', self.get_setting('app.last_folder_path'))

            self.qt_settings.sync()

        except Exception as e:
            self.handle_error(e, "_save_qt_settings")

    # ========================================
    # Directory Access Methods (for other managers)
    # ========================================

    def get_base_directory(self) -> Path:
        """Get the base SentrySix directory path."""
        return self.base_dir

    def get_config_directory(self) -> Path:
        """Get the configuration directory path."""
        return self.config_dir

    def get_logs_directory(self) -> Path:
        """Get the logs directory path."""
        return self.logs_dir

    def get_cache_directory(self) -> Path:
        """Get the cache directory path."""
        return self.cache_dir

    def ensure_directory_exists(self, directory_type: str) -> Path:
        """
        Ensure a specific directory exists and return its path.

        Args:
            directory_type: Type of directory ('config', 'logs', 'cache', 'base')

        Returns:
            Path to the requested directory
        """
        try:
            directory_map = {
                'base': self.base_dir,
                'config': self.config_dir,
                'logs': self.logs_dir,
                'cache': self.cache_dir
            }

            if directory_type not in directory_map:
                raise ValueError(f"Unknown directory type: {directory_type}")

            directory = directory_map[directory_type]
            directory.mkdir(parents=True, exist_ok=True)
            return directory

        except Exception as e:
            self.handle_error(e, f"ensure_directory_exists({directory_type})")
            return self.base_dir  # Fallback to base directory

    def get_migration_status(self) -> dict:
        """Get information about the migration status."""
        try:
            return {
                'migration_completed': self.migration_marker.exists(),
                'migration_marker_path': str(self.migration_marker),
                'base_directory': str(self.base_dir),
                'config_directory': str(self.config_dir),
                'logs_directory': str(self.logs_dir),
                'cache_directory': str(self.cache_dir),
                'legacy_paths_checked': [str(p) for p in self.legacy_paths],
                'directory_structure_exists': all(d.exists() for d in [self.base_dir, self.config_dir, self.logs_dir, self.cache_dir])
            }

        except Exception as e:
            self.handle_error(e, "get_migration_status")
            return {}
