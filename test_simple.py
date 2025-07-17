#!/usr/bin/env python3
"""Simple test to check if our imports work."""

import sys
import os

try:
    # Add current directory to path
    sys.path.insert(0, os.getcwd())
    
    print("Testing imports...")
    
    # Test basic imports
    from viewer.state import AppState
    print("✅ AppState import successful")
    
    from viewer.managers.container import DependencyContainer
    print("✅ DependencyContainer import successful")
    
    from viewer.managers.error_handling import ErrorHandler
    print("✅ ErrorHandler import successful")
    
    # Test VideoPlaybackManager import
    from viewer.managers.video_playback import VideoPlaybackManager
    print("✅ VideoPlaybackManager import successful")
    
    print("\n🎉 All imports successful!")
    
except Exception as e:
    print(f"❌ Import error: {e}")
    import traceback
    traceback.print_exc()
