"""
Sample Plugin for SentrySix.

This is a demonstration plugin that shows how to implement the plugin architecture.
It provides sample menu actions and responds to application events.
"""

from viewer.managers.plugin import PluginInterface


class SamplePlugin(PluginInterface):
    """Sample plugin implementation demonstrating the plugin architecture."""

    def __init__(self):
        super().__init__()
        self.plugin_id = "sample_plugin"
        self.plugin_name = "Sample Plugin"
        self.plugin_version = "1.0.0"
        self.plugin_description = "Demonstration plugin for SentrySix plugin architecture"
        self.plugin_author = "SentrySix Development Team"
        self.required_version = "1.0.0"

    def initialize(self, manager_container) -> bool:
        """Initialize the plugin."""
        try:
            self.manager_container = manager_container
            
            # Get access to managers
            self.config_manager = manager_container.get_service('configuration')
            self.logging_manager = manager_container.get_service('logging')
            self.cache_manager = manager_container.get_service('cache')
            
            # Get a logger for this plugin
            if self.logging_manager:
                self.logger = self.logging_manager.get_logger('SamplePlugin')
                self.logger.info(f"{self.plugin_name} plugin initialized successfully")
            else:
                print(f"{self.plugin_name} plugin initialized successfully")
            
            return True
            
        except Exception as e:
            print(f"Error initializing {self.plugin_name} plugin: {e}")
            return False

    def cleanup(self) -> None:
        """Clean up plugin resources."""
        if hasattr(self, 'logger'):
            self.logger.info(f"{self.plugin_name} plugin cleaned up")
        else:
            print(f"{self.plugin_name} plugin cleaned up")

    def get_menu_actions(self):
        """Get menu actions for this plugin."""
        return [
            {
                'name': f'{self.plugin_name} Action',
                'callback': self.sample_action,
                'shortcut': 'Ctrl+Shift+S',
                'tooltip': f'Execute {self.plugin_name} sample action'
            },
            {
                'name': 'Show Plugin Info',
                'callback': self.show_plugin_info,
                'shortcut': 'Ctrl+Shift+I',
                'tooltip': 'Show information about this plugin'
            }
        ]

    def get_toolbar_actions(self):
        """Get toolbar actions for this plugin."""
        return [
            {
                'name': 'Sample Tool',
                'callback': self.sample_tool_action,
                'icon': None,  # Could specify an icon path
                'tooltip': 'Sample toolbar action'
            }
        ]

    def sample_action(self):
        """Sample plugin action."""
        message = f"{self.plugin_name} action executed!"
        if hasattr(self, 'logger'):
            self.logger.info(message)
        else:
            print(message)

    def show_plugin_info(self):
        """Show plugin information."""
        info = self.get_plugin_info()
        message = f"Plugin Info:\n"
        message += f"Name: {info['name']}\n"
        message += f"Version: {info['version']}\n"
        message += f"Description: {info['description']}\n"
        message += f"Author: {info['author']}\n"
        
        if hasattr(self, 'logger'):
            self.logger.info(f"Plugin info displayed: {info['name']}")
        
        print(message)

    def sample_tool_action(self):
        """Sample toolbar action."""
        message = f"{self.plugin_name} toolbar action executed!"
        if hasattr(self, 'logger'):
            self.logger.info(message)
        else:
            print(message)

    def on_video_loaded(self, video_path: str) -> None:
        """Called when a video is loaded."""
        message = f"{self.plugin_name}: Video loaded - {video_path}"
        if hasattr(self, 'logger'):
            self.logger.debug(message)
        else:
            print(message)

    def on_export_started(self, export_settings) -> None:
        """Called when export starts."""
        message = f"{self.plugin_name}: Export started with settings: {export_settings}"
        if hasattr(self, 'logger'):
            self.logger.info(message)
        else:
            print(message)

    def on_export_completed(self, export_path: str) -> None:
        """Called when export completes."""
        message = f"{self.plugin_name}: Export completed - {export_path}"
        if hasattr(self, 'logger'):
            self.logger.info(message)
        else:
            print(message)

    def get_cache_stats(self):
        """Example of using the cache manager."""
        if self.cache_manager:
            stats = self.cache_manager.get_cache_stats()
            message = f"{self.plugin_name}: Cache stats - {stats}"
            if hasattr(self, 'logger'):
                self.logger.debug(message)
            return stats
        return {}

    def get_configuration_setting(self, key: str, default=None):
        """Example of using the configuration manager."""
        if self.config_manager:
            return self.config_manager.get_setting(key, default)
        return default
