"""
Dependency Injection Container

Provides service registration and retrieval for manager communication
and dependency injection in the SentrySix application.
"""

from typing import Dict, Any, Type, TypeVar, Callable, Optional
import logging
from threading import Lock


T = TypeVar('T')


class DependencyContainer:
    """
    Simple dependency injection container for manager communication.

    Supports:
    - Service registration and retrieval
    - Factory functions for lazy instantiation
    - Thread-safe operations
    - Service lifecycle management
    """

    def __init__(self):
        """Initialize the dependency container."""
        self._services: Dict[str, Any] = {}
        self._factories: Dict[str, Callable] = {}
        self._singletons: Dict[str, bool] = {}
        self._lock = Lock()
        self.logger = logging.getLogger(__name__)

        self.logger.debug("DependencyContainer created")

    def register_service(self, name: str, instance: Any) -> None:
        """
        Register a service instance.

        Args:
            name: Service name for retrieval
            instance: The service instance to register
        """
        with self._lock:
            if name in self._services:
                self.logger.warning(f"Overriding existing service: {name}")

            self._services[name] = instance
            self._singletons[name] = True  # Instances are always singletons
            self.logger.debug(f"Registered service: {name} ({type(instance).__name__})")

    def register_factory(self, name: str, factory: Callable, singleton: bool = True) -> None:
        """
        Register a factory function for lazy instantiation.

        Args:
            name: Service name for retrieval
            factory: Factory function that creates the service
            singleton: Whether to cache the created instance
        """
        with self._lock:
            if name in self._factories:
                self.logger.warning(f"Overriding existing factory: {name}")

            self._factories[name] = factory
            self._singletons[name] = singleton
            self.logger.debug(f"Registered factory: {name} (singleton={singleton})")

    def register_type(self, name: str, service_type: Type[T], *args, **kwargs) -> None:
        """
        Register a type with constructor arguments for lazy instantiation.

        Args:
            name: Service name for retrieval
            service_type: The class to instantiate
            *args: Constructor arguments
            **kwargs: Constructor keyword arguments
        """
        factory = lambda: service_type(*args, **kwargs)
        self.register_factory(name, factory, singleton=True)

    def get_service(self, name: str) -> Any:
        """
        Get a service instance, creating it if necessary.

        Args:
            name: Service name to retrieve

        Returns:
            The service instance

        Raises:
            ValueError: If service is not found
        """
        with self._lock:
            # Return existing instance if available
            if name in self._services:
                return self._services[name]

            # Create from factory if available
            if name in self._factories:
                try:
                    instance = self._factories[name]()

                    # Cache if singleton
                    if self._singletons.get(name, True):
                        self._services[name] = instance
                        self.logger.debug(f"Created and cached service: {name}")
                    else:
                        self.logger.debug(f"Created transient service: {name}")

                    return instance

                except Exception as e:
                    self.logger.error(f"Failed to create service '{name}': {e}", exc_info=True)
                    raise ValueError(f"Failed to create service '{name}': {e}")

            raise ValueError(f"Service '{name}' not found")

    def has_service(self, name: str) -> bool:
        """
        Check if a service is available.

        Args:
            name: Service name to check

        Returns:
            True if service is available, False otherwise
        """
        with self._lock:
            return name in self._services or name in self._factories

    def get_service_names(self) -> list[str]:
        """
        Get all registered service names.

        Returns:
            List of service names
        """
        with self._lock:
            return list(set(self._services.keys()) | set(self._factories.keys()))

    def remove_service(self, name: str) -> bool:
        """
        Remove a service from the container.

        Args:
            name: Service name to remove

        Returns:
            True if service was removed, False if not found
        """
        with self._lock:
            removed = False

            if name in self._services:
                # Call cleanup if service has it
                service = self._services[name]
                if hasattr(service, 'cleanup'):
                    try:
                        service.cleanup()
                    except Exception as e:
                        self.logger.error(f"Error during cleanup of {name}: {e}")

                del self._services[name]
                removed = True

            if name in self._factories:
                del self._factories[name]
                removed = True

            if name in self._singletons:
                del self._singletons[name]

            if removed:
                self.logger.debug(f"Removed service: {name}")

            return removed

    def clear(self) -> None:
        """Clear all services and factories."""
        with self._lock:
            # Cleanup all services that support it
            for name, service in self._services.items():
                if hasattr(service, 'cleanup'):
                    try:
                        service.cleanup()
                    except Exception as e:
                        self.logger.error(f"Error during cleanup of {name}: {e}")

            self._services.clear()
            self._factories.clear()
            self._singletons.clear()
            self.logger.debug("Cleared all services and factories")
