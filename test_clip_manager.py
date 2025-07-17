#!/usr/bin/env python3
"""
Test script for ClipManager functionality.
Week 6 implementation verification.
"""

import sys
import os
from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import QTimer

# Add the project root to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from viewer.managers import ClipManager, DependencyContainer
from viewer.state import AppState

class MockParentWidget:
    """Mock parent widget for testing."""
    def __init__(self):
        self.app_state = AppState()
        self.camera_name_to_index = {
            "front": 0, "left_repeater": 1, "right_repeater": 2, 
            "back": 3, "left_pillar": 4, "right_pillar": 5
        }

def test_clip_manager():
    """Test ClipManager functionality."""
    print("🧪 Testing ClipManager functionality...")
    
    # Create mock dependencies
    parent_widget = MockParentWidget()
    container = DependencyContainer()
    
    # Register services
    container.register_service('app_state', parent_widget.app_state)
    container.register_service('camera_map', parent_widget.camera_name_to_index)
    
    # Create ClipManager
    clip_manager = ClipManager(parent_widget, container)
    
    # Test initialization
    print("1. Testing initialization...")
    if clip_manager.initialize():
        print("   ✅ ClipManager initialized successfully")
    else:
        print("   ❌ ClipManager initialization failed")
        return False
    
    # Test state methods
    print("2. Testing state methods...")
    state = clip_manager.get_clip_manager_state()
    print(f"   📊 Manager state: {state}")
    
    # Test cache info
    print("3. Testing cache functionality...")
    cache_info = clip_manager.get_cache_info()
    print(f"   💾 Cache info: {cache_info}")
    
    # Test file system diagnostics
    print("4. Testing file system diagnostics...")
    diagnostics = clip_manager.get_file_system_diagnostics()
    print(f"   🔍 Diagnostics: {diagnostics}")
    
    # Test with a real folder if available
    test_folder = "G:/TeslaCam/SavedClips"
    if os.path.exists(test_folder):
        print(f"5. Testing with real folder: {test_folder}")
        if clip_manager.set_root_clips_path(test_folder):
            print("   ✅ Root path set successfully")
            
            available_dates = clip_manager.get_available_dates()
            print(f"   📅 Found {len(available_dates)} available dates")
            
            if available_dates:
                test_date = available_dates[0]
                print(f"   🧪 Testing file index for {test_date}")
                file_index = clip_manager.build_file_index_for_date(test_date)
                total_files = sum(len(files) for files in file_index.values())
                print(f"   📁 Found {total_files} total files for {test_date}")
                
                # Test file validation
                print("   🔍 Testing file validation...")
                for camera_name, files in file_index.items():
                    if files:
                        test_file = files[0]
                        is_valid = clip_manager.validate_video_file(test_file)
                        print(f"      {camera_name}: {os.path.basename(test_file)} - {'✅ Valid' if is_valid else '❌ Invalid'}")
                        break
        else:
            print("   ❌ Failed to set root path")
    else:
        print(f"5. Test folder {test_folder} not available, skipping real folder tests")
    
    # Test cleanup
    print("6. Testing cleanup...")
    clip_manager.cleanup()
    print("   ✅ ClipManager cleaned up successfully")
    
    print("\n🎉 ClipManager testing completed successfully!")
    return True

def main():
    """Main test function."""
    app = QApplication(sys.argv)
    
    # Set up application properties
    app.setOrganizationName("JR Media")
    app.setApplicationName("SentrySix")
    
    # Run tests
    success = test_clip_manager()
    
    # Exit with appropriate code
    if success:
        print("\n✅ All tests passed!")
        QTimer.singleShot(100, app.quit)  # Exit after a short delay
        sys.exit(0)
    else:
        print("\n❌ Some tests failed!")
        QTimer.singleShot(100, app.quit)
        sys.exit(1)

if __name__ == "__main__":
    main()
