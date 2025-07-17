"""
Plugin Manager for SentrySix.

This module provides an extensible plugin architecture for future functionality
expansion and third-party integrations. Supports dynamic plugin loading,
lifecycle management, and secure plugin execution.
"""

import sys
import json
import importlib
import importlib.util
from typing import Dict, List, Optional, Any, Type
from pathlib import Path
from abc import ABC, abstractmethod
from PyQt6.QtCore import QObject, pyqtSignal

from .base import BaseManager


class PluginManagerSignals(QObject):
    """Signals for PluginManager communication with UI and other managers."""

    # Plugin lifecycle signals
    plugin_loaded = pyqtSignal(str, str)  # plugin_id, plugin_name
    plugin_unloaded = pyqtSignal(str)  # plugin_id
    plugin_enabled = pyqtSignal(str)  # plugin_id
    plugin_disabled = pyqtSignal(str)  # plugin_id

    # Plugin operation signals
    plugin_error = pyqtSignal(str, str)  # plugin_id, error_message
    plugin_warning = pyqtSignal(str, str)  # plugin_id, warning_message
    plugin_action_executed = pyqtSignal(str, str)  # plugin_id, action_name

    # Plugin discovery signals
    plugins_discovered = pyqtSignal(int)  # plugin_count
    plugin_registry_updated = pyqtSignal()


class PluginInterface(ABC):
    """
    Abstract base class for all SentrySix plugins.
    
    All plugins must inherit from this class and implement the required methods.
    """

    def __init__(self):
        self.plugin_id: str = ""
        self.plugin_name: str = ""
        self.plugin_version: str = "1.0.0"
        self.plugin_description: str = ""
        self.plugin_author: str = ""
        self.required_version: str = "1.0.0"
        self.dependencies: List[str] = []
        self.enabled: bool = True

    @abstractmethod
    def initialize(self, manager_container) -> bool:
        """
        Initialize the plugin with access to manager container.
        
        Args:
            manager_container: DependencyContainer with access to all managers
            
        Returns:
            bool: True if initialization was successful
        """
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """Clean up plugin resources."""
        pass

    def get_plugin_info(self) -> Dict[str, Any]:
        """Get plugin information."""
        return {
            'id': self.plugin_id,
            'name': self.plugin_name,
            'version': self.plugin_version,
            'description': self.plugin_description,
            'author': self.plugin_author,
            'required_version': self.required_version,
            'dependencies': self.dependencies,
            'enabled': self.enabled
        }

    def get_menu_actions(self) -> List[Dict[str, Any]]:
        """
        Get menu actions that this plugin provides.
        
        Returns:
            List of menu action dictionaries with 'name', 'callback', 'shortcut', etc.
        """
        return []

    def get_toolbar_actions(self) -> List[Dict[str, Any]]:
        """
        Get toolbar actions that this plugin provides.
        
        Returns:
            List of toolbar action dictionaries
        """
        return []

    def on_video_loaded(self, video_path: str) -> None:
        """Called when a video is loaded."""
        pass

    def on_export_started(self, export_settings: Dict[str, Any]) -> None:
        """Called when export starts."""
        pass

    def on_export_completed(self, export_path: str) -> None:
        """Called when export completes."""
        pass


class PluginManager(BaseManager):
    """
    Manages plugin loading, lifecycle, and execution.

    Handles:
    - Plugin discovery and loading from designated directories
    - Plugin lifecycle management (load, unload, enable, disable)
    - Plugin registry and metadata management
    - Secure plugin execution with error isolation
    - Plugin dependency resolution
    - Integration with SentrySix manager system
    - Plugin configuration and settings
    """

    def __init__(self, parent_widget, dependency_container):
        """Initialize the PluginManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = PluginManagerSignals()

        # Plugin storage
        self.plugins: Dict[str, PluginInterface] = {}
        self.plugin_modules: Dict[str, Any] = {}
        self.plugin_metadata: Dict[str, Dict[str, Any]] = {}

        # Plugin directories
        self.plugin_directories: List[Path] = []
        self.plugins_directory: Optional[Path] = None

        # Plugin configuration
        self.auto_load_plugins = True
        self.enable_third_party_plugins = True
        self.plugin_security_enabled = True

        # Plugin registry
        self.plugin_registry_file: Optional[Path] = None

        self.logger.debug("PluginManager created")

    def initialize(self) -> bool:
        """
        Initialize plugin manager.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Set up plugin directories
            self._setup_plugin_directories()

            # Load plugin configuration
            self._load_plugin_configuration()

            # Load plugin registry
            self._load_plugin_registry()

            # Discover available plugins
            discovered_count = self._discover_plugins()

            # Auto-load plugins if enabled
            if self.auto_load_plugins:
                self._auto_load_plugins()

            self.signals.plugins_discovered.emit(discovered_count)
            self.logger.info(f"PluginManager initialized successfully, discovered {discovered_count} plugins")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "PluginManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up plugin resources."""
        try:
            self._mark_cleanup_started()

            # Unload all plugins
            for plugin_id in list(self.plugins.keys()):
                self.unload_plugin(plugin_id)

            # Save plugin registry
            self._save_plugin_registry()

            self.logger.info("PluginManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "PluginManager cleanup")

    # ========================================
    # Plugin Management
    # ========================================

    def load_plugin(self, plugin_path: Path) -> bool:
        """
        Load a plugin from file path.

        Args:
            plugin_path: Path to plugin file

        Returns:
            bool: True if plugin was loaded successfully
        """
        try:
            # Validate plugin file
            if not self._validate_plugin_file(plugin_path):
                return False

            # Load plugin module
            plugin_module = self._load_plugin_module(plugin_path)
            if not plugin_module:
                return False

            # Get plugin class
            plugin_class = self._get_plugin_class(plugin_module)
            if not plugin_class:
                return False

            # Create plugin instance
            plugin_instance = plugin_class()
            if not isinstance(plugin_instance, PluginInterface):
                self.logger.error(f"Plugin {plugin_path} does not implement PluginInterface")
                return False

            # Initialize plugin
            if not plugin_instance.initialize(self.container):
                self.logger.error(f"Plugin {plugin_path} initialization failed")
                return False

            # Register plugin
            plugin_id = plugin_instance.plugin_id or plugin_path.stem
            self.plugins[plugin_id] = plugin_instance
            self.plugin_modules[plugin_id] = plugin_module
            self.plugin_metadata[plugin_id] = plugin_instance.get_plugin_info()

            self.signals.plugin_loaded.emit(plugin_id, plugin_instance.plugin_name)
            self.logger.info(f"Plugin loaded: {plugin_id} ({plugin_instance.plugin_name})")
            return True

        except Exception as e:
            self.handle_error(e, f"load_plugin({plugin_path})")
            return False

    def unload_plugin(self, plugin_id: str) -> bool:
        """
        Unload a plugin.

        Args:
            plugin_id: Plugin identifier

        Returns:
            bool: True if plugin was unloaded successfully
        """
        try:
            if plugin_id not in self.plugins:
                self.logger.warning(f"Plugin not found: {plugin_id}")
                return False

            # Cleanup plugin
            plugin = self.plugins[plugin_id]
            plugin.cleanup()

            # Remove from registry
            del self.plugins[plugin_id]
            del self.plugin_modules[plugin_id]
            del self.plugin_metadata[plugin_id]

            self.signals.plugin_unloaded.emit(plugin_id)
            self.logger.info(f"Plugin unloaded: {plugin_id}")
            return True

        except Exception as e:
            self.handle_error(e, f"unload_plugin({plugin_id})")
            return False

    def enable_plugin(self, plugin_id: str) -> bool:
        """Enable a plugin."""
        try:
            if plugin_id not in self.plugins:
                return False

            plugin = self.plugins[plugin_id]
            plugin.enabled = True
            self.plugin_metadata[plugin_id]['enabled'] = True

            self.signals.plugin_enabled.emit(plugin_id)
            self.logger.info(f"Plugin enabled: {plugin_id}")
            return True

        except Exception as e:
            self.handle_error(e, f"enable_plugin({plugin_id})")
            return False

    def disable_plugin(self, plugin_id: str) -> bool:
        """Disable a plugin."""
        try:
            if plugin_id not in self.plugins:
                return False

            plugin = self.plugins[plugin_id]
            plugin.enabled = False
            self.plugin_metadata[plugin_id]['enabled'] = False

            self.signals.plugin_disabled.emit(plugin_id)
            self.logger.info(f"Plugin disabled: {plugin_id}")
            return True

        except Exception as e:
            self.handle_error(e, f"disable_plugin({plugin_id})")
            return False

    def get_loaded_plugins(self) -> Dict[str, Dict[str, Any]]:
        """Get information about all loaded plugins."""
        return self.plugin_metadata.copy()

    def get_plugin(self, plugin_id: str) -> Optional[PluginInterface]:
        """Get a specific plugin instance."""
        return self.plugins.get(plugin_id)

    def is_plugin_enabled(self, plugin_id: str) -> bool:
        """Check if a plugin is enabled."""
        if plugin_id not in self.plugins:
            return False
        return self.plugins[plugin_id].enabled

    # ========================================
    # Plugin Events and Hooks
    # ========================================

    def notify_video_loaded(self, video_path: str) -> None:
        """Notify all enabled plugins that a video was loaded."""
        try:
            for plugin_id, plugin in self.plugins.items():
                if plugin.enabled:
                    try:
                        plugin.on_video_loaded(video_path)
                    except Exception as e:
                        self.signals.plugin_error.emit(plugin_id, f"Error in on_video_loaded: {e}")

        except Exception as e:
            self.handle_error(e, f"notify_video_loaded({video_path})")

    def notify_export_started(self, export_settings: Dict[str, Any]) -> None:
        """Notify all enabled plugins that export started."""
        try:
            for plugin_id, plugin in self.plugins.items():
                if plugin.enabled:
                    try:
                        plugin.on_export_started(export_settings)
                    except Exception as e:
                        self.signals.plugin_error.emit(plugin_id, f"Error in on_export_started: {e}")

        except Exception as e:
            self.handle_error(e, f"notify_export_started({export_settings})")

    def notify_export_completed(self, export_path: str) -> None:
        """Notify all enabled plugins that export completed."""
        try:
            for plugin_id, plugin in self.plugins.items():
                if plugin.enabled:
                    try:
                        plugin.on_export_completed(export_path)
                    except Exception as e:
                        self.signals.plugin_error.emit(plugin_id, f"Error in on_export_completed: {e}")

        except Exception as e:
            self.handle_error(e, f"notify_export_completed({export_path})")

    def execute_plugin_action(self, plugin_id: str, action_name: str, *args, **kwargs) -> Any:
        """Execute a specific action from a plugin."""
        try:
            if plugin_id not in self.plugins:
                self.logger.warning(f"Plugin not found: {plugin_id}")
                return None

            plugin = self.plugins[plugin_id]
            if not plugin.enabled:
                self.logger.warning(f"Plugin disabled: {plugin_id}")
                return None

            # Get the action method
            action_method = getattr(plugin, action_name, None)
            if not action_method or not callable(action_method):
                self.logger.warning(f"Action not found: {plugin_id}.{action_name}")
                return None

            # Execute the action
            result = action_method(*args, **kwargs)
            self.signals.plugin_action_executed.emit(plugin_id, action_name)
            return result

        except Exception as e:
            self.signals.plugin_error.emit(plugin_id, f"Error executing {action_name}: {e}")
            self.handle_error(e, f"execute_plugin_action({plugin_id}, {action_name})")
            return None

    def get_plugin_menu_actions(self) -> List[Dict[str, Any]]:
        """Get all menu actions from enabled plugins."""
        try:
            actions = []
            for plugin_id, plugin in self.plugins.items():
                if plugin.enabled:
                    try:
                        plugin_actions = plugin.get_menu_actions()
                        for action in plugin_actions:
                            action['plugin_id'] = plugin_id
                            actions.append(action)
                    except Exception as e:
                        self.signals.plugin_error.emit(plugin_id, f"Error getting menu actions: {e}")

            return actions

        except Exception as e:
            self.handle_error(e, "get_plugin_menu_actions")
            return []

    def get_plugin_toolbar_actions(self) -> List[Dict[str, Any]]:
        """Get all toolbar actions from enabled plugins."""
        try:
            actions = []
            for plugin_id, plugin in self.plugins.items():
                if plugin.enabled:
                    try:
                        plugin_actions = plugin.get_toolbar_actions()
                        for action in plugin_actions:
                            action['plugin_id'] = plugin_id
                            actions.append(action)
                    except Exception as e:
                        self.signals.plugin_error.emit(plugin_id, f"Error getting toolbar actions: {e}")

            return actions

        except Exception as e:
            self.handle_error(e, "get_plugin_toolbar_actions")
            return []

    # ========================================
    # Helper Methods
    # ========================================

    def _setup_plugin_directories(self) -> None:
        """Set up plugin directories."""
        try:
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                base_dir = config_manager.get_base_directory()
                self.plugins_directory = base_dir / 'plugins'
            else:
                # Fallback to default location
                self.plugins_directory = Path.home() / '.sentrysix' / 'plugins'

            # Ensure plugins directory exists
            self.plugins_directory.mkdir(parents=True, exist_ok=True)

            # Set up plugin registry file
            self.plugin_registry_file = self.plugins_directory / 'registry.json'

            # Add plugin directories
            self.plugin_directories = [
                self.plugins_directory,
                Path(__file__).parent.parent / 'plugins',  # Built-in plugins
            ]

            # Create built-in plugins directory if it doesn't exist
            builtin_plugins_dir = Path(__file__).parent.parent / 'plugins'
            builtin_plugins_dir.mkdir(exist_ok=True)

        except Exception as e:
            self.handle_error(e, "_setup_plugin_directories")

    def _load_plugin_configuration(self) -> None:
        """Load plugin configuration from ConfigurationManager."""
        try:
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                self.auto_load_plugins = config_manager.get_setting('plugins.auto_load', True)
                self.enable_third_party_plugins = config_manager.get_setting('plugins.enable_third_party', True)
                self.plugin_security_enabled = config_manager.get_setting('plugins.security_enabled', True)

        except Exception as e:
            self.handle_error(e, "_load_plugin_configuration")

    def _discover_plugins(self) -> int:
        """Discover available plugins in plugin directories."""
        try:
            discovered_count = 0

            for plugin_dir in self.plugin_directories:
                if not plugin_dir.exists():
                    continue

                for plugin_file in plugin_dir.glob("*.py"):
                    if plugin_file.name.startswith("__"):
                        continue

                    if self._validate_plugin_file(plugin_file):
                        discovered_count += 1
                        self.logger.debug(f"Discovered plugin: {plugin_file}")

            return discovered_count

        except Exception as e:
            self.handle_error(e, "_discover_plugins")
            return 0

    def _auto_load_plugins(self) -> None:
        """Automatically load discovered plugins."""
        try:
            for plugin_dir in self.plugin_directories:
                if not plugin_dir.exists():
                    continue

                for plugin_file in plugin_dir.glob("*.py"):
                    if plugin_file.name.startswith("__"):
                        continue

                    # Check if plugin should be auto-loaded
                    if self._should_auto_load_plugin(plugin_file):
                        self.load_plugin(plugin_file)

        except Exception as e:
            self.handle_error(e, "_auto_load_plugins")

    def _validate_plugin_file(self, plugin_path: Path) -> bool:
        """Validate that a file is a valid plugin."""
        try:
            if not plugin_path.exists() or not plugin_path.is_file():
                return False

            if plugin_path.suffix != '.py':
                return False

            # Basic security check - ensure it's in allowed directories
            if self.plugin_security_enabled:
                allowed = any(plugin_path.is_relative_to(allowed_dir)
                            for allowed_dir in self.plugin_directories)
                if not allowed:
                    self.logger.warning(f"Plugin outside allowed directories: {plugin_path}")
                    return False

            return True

        except Exception as e:
            self.handle_error(e, f"_validate_plugin_file({plugin_path})")
            return False

    def _load_plugin_module(self, plugin_path: Path) -> Optional[Any]:
        """Load a plugin module from file."""
        try:
            module_name = f"sentrysix_plugin_{plugin_path.stem}"

            # Load module from file
            spec = importlib.util.spec_from_file_location(module_name, plugin_path)
            if not spec or not spec.loader:
                self.logger.error(f"Could not create module spec for {plugin_path}")
                return None

            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)

            return module

        except Exception as e:
            self.handle_error(e, f"_load_plugin_module({plugin_path})")
            return None

    def _get_plugin_class(self, module: Any) -> Optional[Type[PluginInterface]]:
        """Get the plugin class from a module."""
        try:
            # Look for classes that inherit from PluginInterface
            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                if (isinstance(attr, type) and
                    issubclass(attr, PluginInterface) and
                    attr != PluginInterface):
                    return attr

            self.logger.error(f"No PluginInterface subclass found in module")
            return None

        except Exception as e:
            self.handle_error(e, "_get_plugin_class")
            return None

    def _should_auto_load_plugin(self, plugin_path: Path) -> bool:
        """Check if a plugin should be auto-loaded."""
        try:
            # Check plugin registry for auto-load preference
            plugin_id = plugin_path.stem
            registry = self._load_plugin_registry()

            if plugin_id in registry:
                return registry[plugin_id].get('auto_load', True)

            # Default to auto-load for new plugins
            return True

        except Exception as e:
            self.handle_error(e, f"_should_auto_load_plugin({plugin_path})")
            return False

    def _load_plugin_registry(self) -> Dict[str, Any]:
        """Load plugin registry from file."""
        try:
            if not self.plugin_registry_file or not self.plugin_registry_file.exists():
                return {}

            with open(self.plugin_registry_file, 'r', encoding='utf-8') as f:
                return json.load(f)

        except Exception as e:
            self.handle_error(e, "_load_plugin_registry")
            return {}

    def _save_plugin_registry(self) -> None:
        """Save plugin registry to file."""
        try:
            if not self.plugin_registry_file:
                return

            registry = {}
            for plugin_id, metadata in self.plugin_metadata.items():
                registry[plugin_id] = {
                    'enabled': metadata.get('enabled', True),
                    'auto_load': True,
                    'last_loaded': metadata.get('last_loaded'),
                    'version': metadata.get('version')
                }

            with open(self.plugin_registry_file, 'w', encoding='utf-8') as f:
                json.dump(registry, f, indent=2, ensure_ascii=False)

        except Exception as e:
            self.handle_error(e, "_save_plugin_registry")

    # ========================================
    # Public Utility Methods
    # ========================================

    def get_plugins_directory(self) -> Path:
        """Get the main plugins directory path."""
        return self.plugins_directory

    def get_plugin_directories(self) -> List[Path]:
        """Get all plugin directories."""
        return self.plugin_directories.copy()

    def reload_plugin(self, plugin_id: str) -> bool:
        """Reload a plugin."""
        try:
            if plugin_id not in self.plugins:
                return False

            # Get plugin path from module
            module = self.plugin_modules[plugin_id]
            plugin_path = Path(module.__file__)

            # Unload and reload
            if self.unload_plugin(plugin_id):
                return self.load_plugin(plugin_path)

            return False

        except Exception as e:
            self.handle_error(e, f"reload_plugin({plugin_id})")
            return False

    def get_plugin_info(self) -> Dict[str, Any]:
        """Get comprehensive plugin system information."""
        try:
            return {
                'plugins_directory': str(self.plugins_directory),
                'plugin_directories': [str(d) for d in self.plugin_directories],
                'auto_load_plugins': self.auto_load_plugins,
                'enable_third_party_plugins': self.enable_third_party_plugins,
                'plugin_security_enabled': self.plugin_security_enabled,
                'loaded_plugins': len(self.plugins),
                'enabled_plugins': len([p for p in self.plugins.values() if p.enabled]),
                'plugin_registry_file': str(self.plugin_registry_file) if self.plugin_registry_file else None,
                'plugins': self.plugin_metadata.copy()
            }

        except Exception as e:
            self.handle_error(e, "get_plugin_info")
            return {}

    def create_sample_plugin(self, plugin_name: str) -> bool:
        """Create a sample plugin file for development."""
        try:
            if not self.plugins_directory:
                return False

            plugin_filename = f"{plugin_name.lower().replace(' ', '_')}_plugin.py"
            plugin_path = self.plugins_directory / plugin_filename

            if plugin_path.exists():
                self.logger.warning(f"Plugin file already exists: {plugin_path}")
                return False

            sample_code = f'''"""
{plugin_name} Plugin for SentrySix.

This is a sample plugin that demonstrates the plugin architecture.
"""

from viewer.managers.plugin import PluginInterface


class {plugin_name.replace(' ', '')}Plugin(PluginInterface):
    """Sample plugin implementation."""

    def __init__(self):
        super().__init__()
        self.plugin_id = "{plugin_name.lower().replace(' ', '_')}"
        self.plugin_name = "{plugin_name}"
        self.plugin_version = "1.0.0"
        self.plugin_description = "Sample plugin for SentrySix"
        self.plugin_author = "SentrySix Developer"
        self.required_version = "1.0.0"

    def initialize(self, manager_container) -> bool:
        """Initialize the plugin."""
        try:
            self.manager_container = manager_container

            # Get access to managers
            self.config_manager = manager_container.get_service('configuration')
            self.logging_manager = manager_container.get_service('logging')
            self.cache_manager = manager_container.get_service('cache')

            # Plugin initialization code here
            print(f"{{self.plugin_name}} plugin initialized successfully")
            return True

        except Exception as e:
            print(f"Error initializing {{self.plugin_name}} plugin: {{e}}")
            return False

    def cleanup(self) -> None:
        """Clean up plugin resources."""
        print(f"{{self.plugin_name}} plugin cleaned up")

    def get_menu_actions(self):
        """Get menu actions for this plugin."""
        return [
            {{
                'name': f'{{self.plugin_name}} Action',
                'callback': self.sample_action,
                'shortcut': 'Ctrl+Shift+S',
                'tooltip': f'Execute {{self.plugin_name}} sample action'
            }}
        ]

    def sample_action(self):
        """Sample plugin action."""
        print(f"{{self.plugin_name}} action executed!")

    def on_video_loaded(self, video_path: str) -> None:
        """Called when a video is loaded."""
        print(f"{{self.plugin_name}}: Video loaded - {{video_path}}")

    def on_export_started(self, export_settings) -> None:
        """Called when export starts."""
        print(f"{{self.plugin_name}}: Export started")

    def on_export_completed(self, export_path: str) -> None:
        """Called when export completes."""
        print(f"{{self.plugin_name}}: Export completed - {{export_path}}")
'''

            with open(plugin_path, 'w', encoding='utf-8') as f:
                f.write(sample_code)

            self.logger.info(f"Sample plugin created: {plugin_path}")
            return True

        except Exception as e:
            self.handle_error(e, f"create_sample_plugin({plugin_name})")
            return False
