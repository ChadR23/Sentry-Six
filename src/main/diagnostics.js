const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// Diagnostics storage directory
const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');

// Ensure diagnostics directory exists
function ensureDiagnosticsDir() {
  if (!fs.existsSync(diagnosticsDir)) {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
  }
}

// Upload to support server (no auth required)
function uploadToSupportServer(serverUrl, diagnostics) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(serverUrl);
    const payload = JSON.stringify({ data: diagnostics });
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const httpModule = urlObj.protocol === 'https:' ? https : http;
    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 200 && result.supportId) {
            resolve(result.supportId);
          } else {
            reject(new Error(result.error || `Server error: ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error('Invalid server response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Upload timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// Update the diagnostics index file
function updateDiagnosticsIndex(supportId, diagnostics) {
  const indexPath = path.join(diagnosticsDir, 'index.json');
  let index = {};
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch {}
  }
  index[supportId] = {
    createdAt: new Date().toISOString(),
    appVersion: diagnostics.appVersion || diagnostics.app?.version,
    os: diagnostics.os || diagnostics.system?.platform
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// Retrieve from support server (requires passcode)
function retrieveFromSupportServer(serverUrl, supportId, passcode) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(serverUrl);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: `/retrieve/${supportId}`,
      method: 'GET',
      headers: {
        'X-Passcode': passcode
      }
    };

    const httpModule = urlObj.protocol === 'https:' ? https : http;
    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 200) {
            resolve(result);
          } else if (res.statusCode === 401) {
            reject(new Error('Invalid passcode'));
          } else if (res.statusCode === 404) {
            reject(new Error('Support ID not found'));
          } else {
            reject(new Error(result.error || `Server error: ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error('Invalid server response'));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`Connection failed: ${e.message}`)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// Fetch content from URL (kept for backwards compatibility)
function fetchFromUrl(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const httpModule = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET'
    };

    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid JSON in paste'));
          }
        } else {
          reject(new Error(`Fetch error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Fetch timeout'));
    });
    req.end();
  });
}

function registerDiagnosticsStorageIpc(serverUrl) {
  // Upload diagnostics to support server (no auth required for upload)
  ipcMain.handle('diagnostics:upload', async (_event, _unused, diagnostics) => {
    try {
      ensureDiagnosticsDir();
      
      // Upload to support server
      const supportId = await uploadToSupportServer(serverUrl, diagnostics);
      
      if (supportId) {
        // Save locally with support ID
        diagnostics.supportId = supportId;
        const localPath = path.join(diagnosticsDir, `${supportId}.json`);
        fs.writeFileSync(localPath, JSON.stringify(diagnostics, null, 2));
        
        // Update index
        updateDiagnosticsIndex(supportId, diagnostics);
        
        console.log(`[DIAGNOSTICS] Uploaded with Support ID: ${supportId}`);
        return { success: true, supportId };
      }
      
      throw new Error('Upload returned no support ID');
    } catch (err) {
      console.error('[DIAGNOSTICS] Upload failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Retrieve diagnostics by Support ID (requires passcode to fetch from server)
  ipcMain.handle('diagnostics:retrieve', async (_event, supportId, passcode) => {
    try {
      const cleanId = supportId.trim();
      
      if (!passcode || passcode.length !== 4) {
        return { success: false, error: 'Invalid passcode' };
      }
      
      // Check local storage first
      ensureDiagnosticsDir();
      const localPath = path.join(diagnosticsDir, `${cleanId}.json`);
      if (fs.existsSync(localPath)) {
        const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
        console.log(`[DIAGNOSTICS] Retrieved from local: ${localPath}`);
        return { success: true, data };
      }
      
      // Fetch from server with passcode
      console.log(`[DIAGNOSTICS] Fetching from server: ${cleanId}`);
      const data = await retrieveFromSupportServer(serverUrl, cleanId, passcode);
      return { success: true, data };
    } catch (err) {
      console.error('[DIAGNOSTICS] Retrieval failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Save diagnostics locally (fallback)
  ipcMain.handle('diagnostics:saveLocal', async (_event, supportId, diagnostics) => {
    try {
      ensureDiagnosticsDir();
      const localPath = path.join(diagnosticsDir, `${supportId}.json`);
      fs.writeFileSync(localPath, JSON.stringify(diagnostics, null, 2));
      updateDiagnosticsIndex(supportId, diagnostics);
      console.log(`[DIAGNOSTICS] Saved locally: ${localPath}`);
      return { success: true, path: localPath };
    } catch (err) {
      console.error('[DIAGNOSTICS] Local save failed:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { diagnosticsDir, ensureDiagnosticsDir, fetchFromUrl, registerDiagnosticsStorageIpc };
