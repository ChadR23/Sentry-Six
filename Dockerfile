# Sentry-Six Docker Image
# Uses jlesage/baseimage-gui for WebUI access via noVNC
# 
# Build: docker build -t sentry-six .
# Run:   docker run -d -p 5800:5800 -v /path/to/config:/config -v /path/to/tesla:/data sentry-six

FROM jlesage/baseimage-gui:ubuntu-22.04-v4

# Set application metadata
ARG APP_VERSION="2026.6.5"
LABEL maintainer="Sentry Six Revamped"
LABEL org.opencontainers.image.title="Sentry-Six"
LABEL org.opencontainers.image.description="Tesla Dashcam Viewer with WebUI"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/ChadR23/Sentry-Six"

# Environment variables for jlesage/baseimage-gui
ENV APP_NAME="Sentry-Six"
ENV KEEP_APP_RUNNING=1
ENV DISPLAY_WIDTH=1400
ENV DISPLAY_HEIGHT=900
ENV DARK_MODE=1

# Sentry-Six specific environment variables
ENV SENTRY_SIX_DOCKER=1
ENV SENTRY_SIX_HEADLESS=1
ENV ELECTRON_DISABLE_GPU=1
ENV ELECTRON_NO_SANDBOX=1

# Install system dependencies required for Electron
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Basic tools
    curl \
    ca-certificates \
    gnupg \
    # Electron dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxshmfence1 \
    # FFmpeg for video processing
    ffmpeg \
    # Canvas dependencies (for node-canvas)
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    build-essential \
    python3 \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Install Node.js (LTS) separately to ensure proper installation
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && node --version \
    && npm --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create app directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install Node.js dependencies (include dev dependencies for Electron)
RUN npm ci || npm install

# Copy application source
COPY src/ ./src/
COPY assets/ ./assets/
COPY version.json ./
COPY LICENSE.txt ./

# Create required directories
RUN mkdir -p /config /data

# Set permissions
RUN chmod -R 755 /app

# Copy startapp script for jlesage/baseimage-gui
COPY docker/startapp.sh /startapp.sh
RUN chmod +x /startapp.sh

# Volume definitions
VOLUME ["/config", "/data"]

# Expose WebUI port (noVNC)
EXPOSE 5800
# Expose VNC port (optional direct VNC access)
EXPOSE 5900

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:5800/ || exit 1
