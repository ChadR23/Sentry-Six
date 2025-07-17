#!/usr/bin/env python3
"""
Test script for SentrySix Manager Infrastructure

This script tests the basic functionality of the manager infrastructure
created in Week 1 of the refactoring roadmap.
"""

import sys
import os
import logging

# Add the project root to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def setup_logging():
    """Set up logging for testing."""
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

def test_dependency_container():
    """Test the DependencyContainer functionality."""
    print("\n=== Testing DependencyContainer ===")

    from viewer.managers.container import DependencyContainer

    container = DependencyContainer()

    # Test service registration
    test_service = {"name": "test", "value": 42}
    container.register_service("test_service", test_service)

    # Test service retrieval
    retrieved = container.get_service("test_service")
    assert retrieved == test_service, "Service retrieval failed"

    # Test factory registration
    def create_test_object():
        return {"factory_created": True}

    container.register_factory("factory_service", create_test_object)
    factory_result = container.get_service("factory_service")
    assert factory_result["factory_created"] == True, "Factory service failed"

    # Test service existence check
    assert container.has_service("test_service"), "Service existence check failed"
    assert not container.has_service("nonexistent"), "Non-existent service check failed"

    print("✓ DependencyContainer tests passed")

def test_error_handling():
    """Test the ErrorHandler functionality."""
    print("\n=== Testing ErrorHandler ===")

    from viewer.managers.error_handling import ErrorHandler, ErrorContext, ErrorSeverity

    error_handler = ErrorHandler()

    # Test error context creation
    context = ErrorContext("TestComponent", "test_operation", "user_clicked_button")
    assert context.component == "TestComponent", "Error context creation failed"

    # Test error handling (this will log but not crash)
    try:
        raise ValueError("Test error")
    except Exception as e:
        error_handler.handle_error(e, context, ErrorSeverity.WARNING)

    # Test error statistics
    stats = error_handler.get_error_statistics()
    assert stats["total_errors"] > 0, "Error statistics failed"

    print("✓ ErrorHandler tests passed")

def test_base_manager():
    """Test the BaseManager functionality."""
    print("\n=== Testing BaseManager ===")

    from viewer.managers.base import BaseManager
    from viewer.managers.container import DependencyContainer

    # Create a concrete implementation for testing
    class TestManager(BaseManager):
        def initialize(self) -> bool:
            self._mark_initialized()
            return True

        def cleanup(self) -> None:
            self._mark_cleanup_started()

    container = DependencyContainer()
    manager = TestManager(None, container)

    # Test initialization
    assert not manager.is_initialized(), "Manager should not be initialized initially"
    result = manager.initialize()
    assert result == True, "Manager initialization failed"
    assert manager.is_initialized(), "Manager should be initialized after initialize()"

    # Test cleanup
    manager.cleanup()

    print("✓ BaseManager tests passed")

def test_manager_placeholders():
    """Test the placeholder manager classes."""
    print("\n=== Testing Manager Placeholders ===")

    from viewer.managers.container import DependencyContainer
    from viewer.managers.video_playback import VideoPlaybackManager
    from viewer.managers.export import ExportManager

    container = DependencyContainer()

    # Test VideoPlaybackManager
    video_manager = VideoPlaybackManager(None, container)
    assert video_manager.initialize(), "VideoPlaybackManager initialization failed"
    video_manager.cleanup()

    # Test ExportManager
    export_manager = ExportManager(None, container)
    assert export_manager.initialize(), "ExportManager initialization failed"
    assert not export_manager.can_export(), "ExportManager should not be able to export initially"
    export_manager.cleanup()

    print("✓ Manager placeholder tests passed")

def test_manager_imports():
    """Test that all manager imports work correctly."""
    print("\n=== Testing Manager Imports ===")

    try:
        from viewer.managers import (
            BaseManager, DependencyContainer, ErrorHandler,
            ErrorContext, ErrorSeverity, VideoPlaybackManager, ExportManager
        )
        print("✓ All manager imports successful")
    except ImportError as e:
        print(f"✗ Import failed: {e}")
        raise

def main():
    """Run all tests."""
    print("SentrySix Manager Infrastructure Test Suite")
    print("=" * 50)

    setup_logging()

    try:
        test_manager_imports()
        test_dependency_container()
        test_error_handling()
        test_base_manager()
        test_manager_placeholders()

        print("\n" + "=" * 50)
        print("🎉 All tests passed! Manager infrastructure is working correctly.")
        print("\nNext steps:")
        print("- Week 2: Implement VideoPlaybackManager extraction")
        print("- Week 3: Continue VideoPlaybackManager implementation")
        print("- Week 4: Implement ExportManager extraction")
        print("- Week 5: Integration testing and validation")

    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
