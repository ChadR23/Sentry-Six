const { ipcMain } = require('electron');
const https = require('https');
const http = require('http');

// Support server configuration
const SUPPORT_SERVER_URL = 'https://api.sentry-six.com';

// Helper function to make support server requests
function makeSupportRequest(method, reqPath, payload = null, authToken = null, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(SUPPORT_SERVER_URL);
    
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    
    if (authToken) {
      headers['X-Auth-Token'] = authToken;
    }
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: reqPath,
      method: method,
      headers: headers
    };

    const httpModule = urlObj.protocol === 'https:' ? https : http;
    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(result);
          } else {
            reject(new Error(result.error || `Server error: ${res.statusCode}`));
          }
        } catch (e) {
          // Include status code and response preview for debugging
          const preview = body.substring(0, 100).replace(/\s+/g, ' ').trim();
          if (res.statusCode === 413) {
            reject(new Error('File too large for server (max ~100MB)'));
          } else if (res.statusCode >= 500) {
            reject(new Error(`Server error ${res.statusCode} - please try again later`));
          } else {
            console.error(`[SUPPORT] Non-JSON response (${res.statusCode}): ${preview}...`);
            reject(new Error(`Server error ${res.statusCode}: Invalid response`));
          }
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function registerSupportChatIpc() {
  // Create a new support ticket
  ipcMain.handle('support:createTicket', async (_event, data) => {
    try {
      const { message, diagnostics, hasAttachments } = data;
      const payload = JSON.stringify({ message, diagnostics, hasAttachments });
      const result = await makeSupportRequest('POST', '/chat/ticket', payload);
      console.log(`[SUPPORT] Created ticket: ${result.ticketId}`);
      return result;
    } catch (err) {
      console.error('[SUPPORT] Create ticket failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Send a message to an existing ticket
  ipcMain.handle('support:sendMessage', async (_event, data) => {
    try {
      const { ticketId, authToken, message, diagnostics } = data;
      const payload = JSON.stringify({ message, diagnostics });
      const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/message`, payload, authToken);
      console.log(`[SUPPORT] Sent message to ticket: ${ticketId}`);
      return result;
    } catch (err) {
      console.error('[SUPPORT] Send message failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Upload media attachment for a ticket
  ipcMain.handle('support:uploadMedia', async (_event, data) => {
    try {
      const { ticketId, authToken, mediaData, fileName, fileType, fileSize, message, diagnostics } = data;
      const payload = JSON.stringify({ mediaData, fileName, fileType, fileSize, message, diagnostics });
      // Scale timeout based on file size: 3 min base + 1 min per 50MB (max 10 min)
      const uploadTimeout = Math.min(600000, 180000 + Math.floor(fileSize / (50 * 1024 * 1024)) * 60000);
      const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/media`, payload, authToken, uploadTimeout);
      console.log(`[SUPPORT] Uploaded media to ticket: ${ticketId}`);
      return result;
    } catch (err) {
      console.error('[SUPPORT] Media upload failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Fetch messages for a ticket
  ipcMain.handle('support:fetchMessages', async (_event, data) => {
    try {
      const { ticketId, authToken, since } = data;
      const query = since ? `?since=${since}` : '';
      const result = await makeSupportRequest('GET', `/chat/ticket/${ticketId}/messages${query}`, null, authToken);
      return result;
    } catch (err) {
      console.error('[SUPPORT] Fetch messages failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Close a support ticket
  ipcMain.handle('support:closeTicket', async (_event, data) => {
    try {
      const { ticketId, authToken, reason } = data;
      const payload = JSON.stringify({ closedBy: 'User', reason });
      const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/close`, payload, authToken);
      console.log(`[SUPPORT] Closed ticket: ${ticketId}`);
      return result;
    } catch (err) {
      console.error('[SUPPORT] Close ticket failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Mark support messages as read (triggers Discord :eyes: reaction)
  ipcMain.handle('support:markRead', async (_event, data) => {
    try {
      const { ticketId, authToken } = data;
      const result = await makeSupportRequest('POST', `/chat/ticket/${ticketId}/mark-read`, null, authToken);
      if (result.markedRead > 0) {
        console.log(`[SUPPORT] Marked ${result.markedRead} messages as read for ticket: ${ticketId}`);
      }
      return result;
    } catch (err) {
      console.error('[SUPPORT] Mark read failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { SUPPORT_SERVER_URL, makeSupportRequest, registerSupportChatIpc };
