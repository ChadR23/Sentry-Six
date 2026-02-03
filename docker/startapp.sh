#!/bin/bash
# Sentry-Six startup script for jlesage/baseimage-gui
# This script is called by the base image to start the application

set -e

# Log startup
echo "[SENTRY-SIX] Starting Sentry-Six in Docker mode..."
echo "[SENTRY-SIX] DISPLAY=$DISPLAY"
echo "[SENTRY-SIX] Config path: /config"
echo "[SENTRY-SIX] Data path: /data"

# Ensure config directory has proper permissions
if [ -d "/config" ]; then
    echo "[SENTRY-SIX] Config directory exists"
else
    echo "[SENTRY-SIX] Creating config directory..."
    mkdir -p /config
fi

# Ensure data directory has proper permissions
if [ -d "/data" ]; then
    echo "[SENTRY-SIX] Data directory exists"
else
    echo "[SENTRY-SIX] Creating data directory..."
    mkdir -p /data
fi

# Change to app directory
cd /app

# Start Electron with required flags for Docker environment
# Use locally installed electron from node_modules
exec /app/node_modules/.bin/electron \
    --no-sandbox \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-dev-shm-usage \
    --disable-setuid-sandbox \
    --headless \
    /app/src/main.js
