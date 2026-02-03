/**
 * Docker Paths Configuration Module
 * Handles environment detection and path configuration for Docker deployments
 * 
 * In Docker mode:
 * - /config: Settings, machine ID, and app configuration
 * - /data: Tesla footage processing and storage
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Docker environment detection
const DOCKER_ENV = {
  // Check multiple indicators for Docker environment
  isDocker: () => {
    // Check for explicit environment variable
    if (process.env.SENTRY_SIX_DOCKER === '1' || process.env.SENTRY_SIX_DOCKER === 'true') {
      return true;
    }
    // Check for /.dockerenv file (standard Docker indicator)
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }
    // Check for Docker in cgroup (Linux containers)
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (cgroup.includes('docker') || cgroup.includes('kubepods')) {
        return true;
      }
    } catch (e) {
      // Not Linux or no access to cgroup
    }
    return false;
  },

  // Check if running in headless mode (CLI flag or env var)
  isHeadless: () => {
    return process.argv.includes('--headless') || 
           process.env.SENTRY_SIX_HEADLESS === '1' ||
           process.env.SENTRY_SIX_HEADLESS === 'true';
  }
};

// Path configuration
const DOCKER_PATHS = {
  config: '/config',
  data: '/data'
};

// Cache the Docker detection result
let _isDockerCached = null;

/**
 * Check if running in Docker environment
 * @returns {boolean}
 */
function isDockerEnvironment() {
  if (_isDockerCached === null) {
    _isDockerCached = DOCKER_ENV.isDocker();
    if (_isDockerCached) {
      console.log('[DOCKER] Running in Docker environment');
    }
  }
  return _isDockerCached;
}

/**
 * Check if running in headless mode
 * @returns {boolean}
 */
function isHeadlessMode() {
  return DOCKER_ENV.isHeadless();
}

/**
 * Get the configuration directory path
 * In Docker: /config
 * Otherwise: Electron's userData path
 * @param {Function} getElectronUserData - Function to get Electron's userData path (app.getPath('userData'))
 * @returns {string}
 */
function getConfigPath(getElectronUserData) {
  if (isDockerEnvironment()) {
    // Ensure Docker config directory exists
    if (!fs.existsSync(DOCKER_PATHS.config)) {
      try {
        fs.mkdirSync(DOCKER_PATHS.config, { recursive: true });
      } catch (err) {
        console.error('[DOCKER] Failed to create config directory:', err.message);
      }
    }
    return DOCKER_PATHS.config;
  }
  return getElectronUserData();
}

/**
 * Get the data directory path (for Tesla footage)
 * In Docker: /data
 * Otherwise: User's home directory or specified path
 * @returns {string}
 */
function getDataPath() {
  if (isDockerEnvironment()) {
    // Ensure Docker data directory exists
    if (!fs.existsSync(DOCKER_PATHS.data)) {
      try {
        fs.mkdirSync(DOCKER_PATHS.data, { recursive: true });
      } catch (err) {
        console.error('[DOCKER] Failed to create data directory:', err.message);
      }
    }
    return DOCKER_PATHS.data;
  }
  return os.homedir();
}

/**
 * Get the settings.json file path
 * @param {Function} getElectronUserData - Function to get Electron's userData path
 * @returns {string}
 */
function getSettingsPath(getElectronUserData) {
  return path.join(getConfigPath(getElectronUserData), 'settings.json');
}

/**
 * Get the machine ID file path for Docker persistence
 * This ensures the same fingerprint is used across container rebuilds
 * @param {Function} getElectronUserData - Function to get Electron's userData path
 * @returns {string}
 */
function getMachineIdPath(getElectronUserData) {
  return path.join(getConfigPath(getElectronUserData), '.machine-id');
}

/**
 * Get the diagnostics directory path
 * @param {Function} getElectronUserData - Function to get Electron's userData path
 * @returns {string}
 */
function getDiagnosticsPath(getElectronUserData) {
  return path.join(getConfigPath(getElectronUserData), 'diagnostics');
}

/**
 * Get Electron app flags for Docker/headless mode
 * @returns {string[]} Array of command line flags to add
 */
function getDockerElectronFlags() {
  const flags = [];
  
  if (isDockerEnvironment() || isHeadlessMode()) {
    // Required for running Electron in Docker without sandbox
    flags.push('--no-sandbox');
    // Disable GPU hardware acceleration (not available in Docker)
    flags.push('--disable-gpu');
    // Disable GPU compositing
    flags.push('--disable-software-rasterizer');
    // Use software rendering
    flags.push('--disable-dev-shm-usage');
    // Disable setuid sandbox
    flags.push('--disable-setuid-sandbox');
  }
  
  return flags;
}

/**
 * Apply Docker-specific Electron flags to the app
 * Should be called before app.whenReady()
 * @param {Electron.App} app - Electron app instance
 */
function applyDockerFlags(app) {
  const flags = getDockerElectronFlags();
  
  for (const flag of flags) {
    const [name, value] = flag.replace('--', '').split('=');
    if (value !== undefined) {
      app.commandLine.appendSwitch(name, value);
    } else {
      app.commandLine.appendSwitch(name);
    }
    console.log(`[DOCKER] Applied flag: ${flag}`);
  }
}

/**
 * Log environment information for debugging
 */
function logEnvironmentInfo() {
  console.log('[DOCKER] Environment Info:');
  console.log(`  - Docker Mode: ${isDockerEnvironment()}`);
  console.log(`  - Headless Mode: ${isHeadlessMode()}`);
  console.log(`  - Platform: ${process.platform}`);
  console.log(`  - Arch: ${process.arch}`);
  console.log(`  - Node Version: ${process.version}`);
  
  if (isDockerEnvironment()) {
    console.log(`  - Config Path: ${DOCKER_PATHS.config}`);
    console.log(`  - Data Path: ${DOCKER_PATHS.data}`);
    console.log(`  - DISPLAY: ${process.env.DISPLAY || 'not set'}`);
  }
}

module.exports = {
  isDockerEnvironment,
  isHeadlessMode,
  getConfigPath,
  getDataPath,
  getSettingsPath,
  getMachineIdPath,
  getDiagnosticsPath,
  getDockerElectronFlags,
  applyDockerFlags,
  logEnvironmentInfo,
  DOCKER_PATHS
};
