/**
 * Support Chat Module
 * Replaces the old feedback/support ID system with an interactive chat
 */

import { collectDiagnostics } from './diagnostics.js';
import { notify } from './notifications.js';
import { t } from '../lib/i18n.js';

const $ = id => document.getElementById(id);

let chatInitialized = false;
let selectedFiles = [];
let currentTicket = null; // { ticketId, authToken, threadId }
let messagePollingInterval = null;
let lastMessageId = null;
let unreadCount = 0; // Track cumulative unread messages

// Constants
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB (Cloudflare limit)
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total
const POLL_INTERVAL = 3500; // 3.5 seconds
const SUPPORT_SERVER_URL = 'https://api.sentry-six.com'; // Must match main.js

/**
 * Initialize the support chat system
 */
export function initSupportChat() {
    if (chatInitialized) return;
    
    // Load existing ticket from storage
    loadTicketFromStorage();
    
    // Start polling if we have an active ticket
    if (currentTicket) {
        startMessagePolling();
    }
    
    chatInitialized = true;
}

/**
 * Show the support chat panel
 */
export function showSupportChat() {
    let panel = $('supportChatPanel');
    
    if (!panel) {
        createSupportChatPanel();
        panel = $('supportChatPanel');
        initChatEventHandlers();
    }
    
    // Update UI based on ticket state
    updateChatUI();
    
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    
    // Clear unread count, dismiss notification, and mark messages as read when chat is opened
    clearUnreadCount();
    dismissSupportNotification();
    markMessagesAsRead();
}

/**
 * Hide the support chat panel
 */
export function hideSupportChat() {
    const panel = $('supportChatPanel');
    if (panel) {
        panel.classList.remove('visible');
        panel.classList.add('hidden');
    }
}

/**
 * Toggle the support chat panel
 */
export function toggleSupportChat() {
    const panel = $('supportChatPanel');
    if (panel && panel.classList.contains('visible')) {
        hideSupportChat();
    } else {
        showSupportChat();
    }
}

/**
 * Create the support chat panel HTML
 */
function createSupportChatPanel() {
    const panel = document.createElement('div');
    panel.id = 'supportChatPanel';
    panel.className = 'support-chat-panel hidden';
    panel.innerHTML = `
        <div class="support-chat-header">
            <div class="support-chat-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <span data-i18n="ui.supportChat.title">${t('ui.supportChat.title')}</span>
                <span id="supportTicketId" class="support-ticket-id hidden"></span>
            </div>
            <div class="support-chat-actions">
                <button id="supportCloseTicketBtn" class="support-chat-btn support-close-ticket-btn hidden" title="${t('ui.supportChat.closeTicket')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                </button>
                <button id="supportChatMinimize" class="support-chat-btn" title="${t('ui.supportChat.minimize')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                </button>
                <button id="supportChatClose" class="support-chat-btn" title="${t('ui.supportChat.closePanel')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        </div>
        
        <div id="supportChatMessages" class="support-chat-messages">
            <!-- Messages will be inserted here -->
            <div id="supportChatWelcome" class="support-chat-welcome">
                <div class="welcome-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
                    </svg>
                </div>
                <h3 data-i18n="ui.supportChat.needHelp">${t('ui.supportChat.needHelp')}</h3>
                <p data-i18n="ui.supportChat.welcomeDesc">${t('ui.supportChat.welcomeDesc')}</p>
                <p class="welcome-note" data-i18n="ui.supportChat.welcomeNote">${t('ui.supportChat.welcomeNote')}</p>
            </div>
        </div>
        
        <div id="supportChatComposer" class="support-chat-composer">
            <div id="supportChatAttachments" class="support-chat-attachments hidden">
                <div id="supportChatAttachmentList" class="attachment-list"></div>
            </div>
            
            <div class="composer-options">
                <label class="composer-option" title="${t('ui.supportChat.includeDiagnostics')}">
                    <input type="checkbox" id="supportIncludeDiagnostics">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                        <polyline points="10 9 9 9 8 9"/>
                    </svg>
                    <span data-i18n="ui.supportChat.diagnostics">${t('ui.supportChat.diagnostics')}</span>
                </label>
                <label class="composer-option attach-btn" title="${t('ui.supportChat.attachFiles')}">
                    <input type="file" id="supportFileInput" accept="image/*,video/*,.zip" multiple style="display: none;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                    <span data-i18n="ui.supportChat.attach">${t('ui.supportChat.attach')}</span>
                </label>
            </div>
            
            <div class="composer-input-row">
                <textarea id="supportMessageInput" class="composer-textarea" placeholder="${t('ui.supportChat.placeholder')}" rows="3" maxlength="5000"></textarea>
                <button id="supportSendBtn" class="composer-send-btn" title="${t('ui.supportChat.sendMessage')}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                </button>
            </div>
            
            <div class="composer-footer">
                <span class="char-count"><span id="supportCharCount">0</span>/5000</span>
                <span class="privacy-note">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
                    </svg>
                    <span data-i18n="ui.supportChat.privacyNote">${t('ui.supportChat.privacyNote')}</span>
                </span>
            </div>
        </div>
        
        <div id="supportTicketClosed" class="support-ticket-closed hidden">
            <div class="ticket-closed-content">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <p data-i18n="ui.supportChat.ticketClosed">${t('ui.supportChat.ticketClosed')}</p>
                <button id="supportNewTicketBtn" class="new-ticket-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    <span data-i18n="ui.supportChat.createNewTicket">${t('ui.supportChat.createNewTicket')}</span>
                </button>
            </div>
        </div>
        
        <div id="supportChatStatus" class="support-chat-status hidden"></div>
    `;
    document.body.appendChild(panel);
}

/**
 * Initialize chat event handlers
 */
function initChatEventHandlers() {
    // Close/minimize buttons
    $('supportChatClose').onclick = hideSupportChat;
    $('supportChatMinimize').onclick = hideSupportChat;
    
    // Close ticket button
    $('supportCloseTicketBtn').onclick = handleCloseTicket;
    
    // New ticket button (after closing)
    $('supportNewTicketBtn').onclick = handleNewTicket;
    
    // Character counter
    const messageInput = $('supportMessageInput');
    const charCount = $('supportCharCount');
    messageInput.addEventListener('input', () => {
        charCount.textContent = messageInput.value.length;
    });
    
    // File attachment
    const fileInput = $('supportFileInput');
    fileInput.addEventListener('change', handleFileSelection);
    
    // Send button
    $('supportSendBtn').onclick = handleSendMessage;
    
    // Enter to send (Shift+Enter for newline)
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    
    // Draggable header
    initDraggablePanel();
}

/**
 * Make the support chat panel draggable by its header
 */
function initDraggablePanel() {
    const panel = $('supportChatPanel');
    const header = panel.querySelector('.support-chat-header');
    
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;
    
    header.addEventListener('mousedown', (e) => {
        // Don't drag if clicking on buttons
        if (e.target.closest('.support-chat-btn') || e.target.closest('.support-chat-actions')) {
            return;
        }
        
        isDragging = true;
        panel.classList.add('dragging');
        
        const rect = panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        let newX = e.clientX - offsetX;
        let newY = e.clientY - offsetY;
        
        // Keep within viewport bounds
        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;
        
        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));
        
        panel.style.left = newX + 'px';
        panel.style.top = newY + 'px';
        panel.style.right = 'auto';
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            panel.classList.remove('dragging');
        }
    });
}

/**
 * Handle file selection (limited to 1 attachment per message)
 */
function handleFileSelection(e) {
    const files = Array.from(e.target.files);
    
    if (files.length === 0) return;
    
    // Only allow 1 attachment per message
    if (selectedFiles.length > 0) {
        notify(t('ui.notifications.onlyOneAttachment'), { type: 'warning' });
        e.target.value = '';
        return;
    }
    
    const file = files[0]; // Take only first file
    
    // Check file size
    if (file.size > MAX_ATTACHMENT_SIZE) {
        notify(t('ui.notifications.fileTooLarge', { filename: file.name }), { type: 'error' });
        e.target.value = '';
        return;
    }
    
    selectedFiles = [file];
    updateAttachmentsList();
    e.target.value = ''; // Reset input
}

/**
 * Update the attachments list UI
 */
function updateAttachmentsList() {
    const container = $('supportChatAttachments');
    const list = $('supportChatAttachmentList');
    
    if (selectedFiles.length === 0) {
        container.classList.add('hidden');
        return;
    }
    
    container.classList.remove('hidden');
    list.innerHTML = selectedFiles.map((file, idx) => `
        <div class="attachment-item" data-idx="${idx}">
            <span class="attachment-icon">${getFileIcon(file.type)}</span>
            <span class="attachment-name">${file.name}</span>
            <span class="attachment-size">${formatFileSize(file.size)}</span>
            <button class="attachment-remove" data-idx="${idx}" title="Remove">&times;</button>
        </div>
    `).join('');
    
    // Remove handlers
    list.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.onclick = (e) => {
            const idx = parseInt(e.target.dataset.idx);
            selectedFiles.splice(idx, 1);
            updateAttachmentsList();
        };
    });
}

/**
 * Handle sending a message
 */
async function handleSendMessage() {
    const messageInput = $('supportMessageInput');
    const sendBtn = $('supportSendBtn');
    const includeDiagnostics = $('supportIncludeDiagnostics').checked;
    
    const message = messageInput.value.trim();
    
    if (!message && selectedFiles.length === 0) {
        notify(t('ui.notifications.enterMessageOrAttach'), { type: 'warning' });
        return;
    }
    
    sendBtn.disabled = true;
    showChatStatus('Sending...', 'loading');
    
    try {
        // Collect diagnostics if enabled
        let diagnostics = null;
        if (includeDiagnostics) {
            showChatStatus('Collecting diagnostics...', 'loading');
            diagnostics = await collectDiagnostics();
        }
        
        // If no ticket exists, create one
        if (!currentTicket) {
            showChatStatus('Creating support ticket...', 'loading');
            const ticketResult = await window.electronAPI.createSupportTicket({
                message,
                diagnostics,
                hasAttachments: selectedFiles.length > 0
            });
            
            if (!ticketResult.success) {
                throw new Error(ticketResult.error || 'Failed to create ticket');
            }
            
            currentTicket = {
                ticketId: ticketResult.ticketId,
                authToken: ticketResult.authToken,
                threadId: ticketResult.threadId
            };
            
            saveTicketToStorage();
            startMessagePolling();
            updateChatUI(); // Show close ticket button immediately
        } else {
            // If we have attachments, include message with first attachment
            // Otherwise send message alone
            if (selectedFiles.length === 0) {
                showChatStatus('Sending message...', 'loading');
                const msgResult = await window.electronAPI.sendSupportMessage({
                    ticketId: currentTicket.ticketId,
                    authToken: currentTicket.authToken,
                    message,
                    diagnostics
                });
                
                if (!msgResult.success) {
                    throw new Error(msgResult.error || 'Failed to send message');
                }
            }
        }
        
        // Upload attachment (limited to 1 per message)
        if (selectedFiles.length > 0) {
            showChatStatus('Uploading attachment...', 'loading');
            
            const file = selectedFiles[0]; // Only first attachment
            const mediaData = await readFileAsBase64(file);
            
            await window.electronAPI.uploadSupportMedia({
                ticketId: currentTicket.ticketId,
                authToken: currentTicket.authToken,
                mediaData,
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size,
                message,
                diagnostics
            });
        }
        
        // Success - clear input and refresh
        messageInput.value = '';
        $('supportCharCount').textContent = '0';
        $('supportIncludeDiagnostics').checked = false;
        selectedFiles = [];
        updateAttachmentsList();
        
        showChatStatus('Message sent!', 'success');
        setTimeout(() => hideChatStatus(), 2000);
        
        // Fetch latest messages from server (includes the one we just sent)
        await fetchMessages();
        
    } catch (err) {
        console.error('[SupportChat] Send error:', err);
        showChatStatus('Error: ' + err.message, 'error');
    } finally {
        sendBtn.disabled = false;
    }
}

/**
 * Update the chat UI based on ticket state
 */
function updateChatUI() {
    const welcome = $('supportChatWelcome');
    const ticketIdEl = $('supportTicketId');
    const closeTicketBtn = $('supportCloseTicketBtn');
    
    if (currentTicket) {
        welcome.classList.add('hidden');
        ticketIdEl.textContent = `#${currentTicket.ticketId}`;
        ticketIdEl.classList.remove('hidden');
        
        // Show close ticket button if ticket is open
        if (currentTicket.status !== 'closed') {
            closeTicketBtn.classList.remove('hidden');
        } else {
            closeTicketBtn.classList.add('hidden');
        }
        
        // Fetch and display messages
        fetchMessages();
    } else {
        welcome.classList.remove('hidden');
        ticketIdEl.classList.add('hidden');
        closeTicketBtn.classList.add('hidden');
    }
}

/**
 * Handle closing a ticket
 */
async function handleCloseTicket() {
    if (!currentTicket) return;
    
    const confirmed = confirm('Are you sure you want to close this ticket? You can start a new one later if needed.');
    if (!confirmed) return;
    
    try {
        showChatStatus('Closing ticket...', 'loading');
        
        const result = await window.electronAPI.closeSupportTicket({
            ticketId: currentTicket.ticketId,
            authToken: currentTicket.authToken,
            reason: 'Closed by user'
        });
        
        // Handle ticket not found - still clear local data
        if (!result.success) {
            const isNotFound = result.error?.toLowerCase().includes('not found');
            if (!isNotFound) {
                throw new Error(result.error || 'Failed to close ticket');
            }
            // Ticket doesn't exist on server, just clear locally
            console.log('[SupportChat] Ticket not found on server, clearing local data');
        }
        
        // Stop polling
        stopMessagePolling();
        
        // Clear ticket data
        currentTicket = null;
        lastMessageId = null;
        
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('supportTicket', null);
        }
        
        // Show closed ticket UI
        showClosedTicketUI();
        
        hideChatStatus();
        notify(t('ui.notifications.supportTicketClosed'), { type: 'success' });
        
    } catch (err) {
        console.error('[SupportChat] Close ticket error:', err);
        showChatStatus('Error: ' + err.message, 'error');
    }
}

/**
 * Show the closed ticket UI (hide composer, show new ticket button)
 */
function showClosedTicketUI() {
    const composer = $('supportChatComposer');
    const closedUI = $('supportTicketClosed');
    const closeBtn = $('supportCloseTicketBtn');
    const ticketIdEl = $('supportTicketId');
    
    composer.classList.add('hidden');
    closedUI.classList.remove('hidden');
    closeBtn.classList.add('hidden');
    ticketIdEl.classList.add('hidden');
}

/**
 * Handle creating a new ticket (reset UI)
 */
function handleNewTicket() {
    const composer = $('supportChatComposer');
    const closedUI = $('supportTicketClosed');
    const welcome = $('supportChatWelcome');
    const messagesContainer = $('supportChatMessages');
    
    // Hide closed UI, show composer
    closedUI.classList.add('hidden');
    composer.classList.remove('hidden');
    
    // Clear messages and show welcome
    const messages = messagesContainer.querySelectorAll('.chat-message');
    messages.forEach(m => m.remove());
    welcome.classList.remove('hidden');
    
    // Reset input fields
    $('supportMessageInput').value = '';
    $('supportCharCount').textContent = '0';
    $('supportIncludeDiagnostics').checked = false;
    selectedFiles = [];
    updateAttachmentsList();
    
    // Reset ticket state
    currentTicket = null;
    lastMessageId = null;
}

/**
 * Add a message to the UI
 */
function addMessageToUI(msg) {
    const messagesContainer = $('supportChatMessages');
    const welcome = $('supportChatWelcome');
    
    // Skip if panel hasn't been created yet (messages will be loaded when panel opens)
    if (!messagesContainer || !welcome) return;
    
    // Hide welcome message
    welcome.classList.add('hidden');
    
    // Check if message already exists
    if (msg.id && messagesContainer.querySelector(`[data-msg-id="${msg.id}"]`)) {
        return;
    }
    
    const msgEl = document.createElement('div');
    msgEl.className = `chat-message ${msg.sender === 'user' ? 'user-message' : 'support-message'}`;
    if (msg.id) msgEl.dataset.msgId = msg.id;
    
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
        attachmentsHtml = `
            <div class="message-attachments">
                ${msg.attachments.map(a => {
                    if (typeof a === 'string') {
                        return `<span class="attachment-badge">${a}</span>`;
                    }
                    // Construct absolute URL for attachments
                    const attachmentUrl = a.url?.startsWith('http') 
                        ? a.url 
                        : `${SUPPORT_SERVER_URL}${a.url}`;
                    
                    // If attachment is an object with URL
                    if (a.url && isImageOrVideo(a.type)) {
                        return `<a href="${attachmentUrl}" target="_blank" class="attachment-preview" title="Click to view ${a.name}">
                            ${a.type?.startsWith('image/') 
                                ? `<img src="${attachmentUrl}" alt="${a.name}" />` 
                                : `<video src="${attachmentUrl}" controls></video>`}
                        </a>`;
                    }
                    return `<a href="${attachmentUrl}" target="_blank" class="attachment-badge" title="Download ${a.name}">${a.name || a}</a>`;
                }).join('')}
            </div>
        `;
    }
    
    let badgesHtml = '';
    if (msg.hasDiagnostics) {
        badgesHtml += '<span class="message-badge diagnostics">📊 Diagnostics</span>';
    }
    
    msgEl.innerHTML = `
        <div class="message-content">
            ${msg.content ? `<p>${escapeHtml(msg.content)}</p>` : ''}
            ${attachmentsHtml}
            ${badgesHtml}
        </div>
        <div class="message-meta">
            <span class="message-sender">${msg.sender === 'user' ? 'You' : (msg.responder || 'Support')}</span>
            <span class="message-time">${time}</span>
        </div>
    `;
    
    messagesContainer.appendChild(msgEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Mark support messages as read (triggers Discord :eyes: reaction)
 */
async function markMessagesAsRead() {
    if (!currentTicket) return;
    
    try {
        await window.electronAPI.markSupportRead({
            ticketId: currentTicket.ticketId,
            authToken: currentTicket.authToken
        });
    } catch (err) {
        console.error('[SupportChat] Mark read error:', err);
    }
}

/**
 * Fetch messages from server
 */
async function fetchMessages() {
    if (!currentTicket) return;
    
    try {
        const result = await window.electronAPI.fetchSupportMessages({
            ticketId: currentTicket.ticketId,
            authToken: currentTicket.authToken,
            since: lastMessageId
        });
        
        if (result.success && result.messages) {
            // Check panel visibility BEFORE processing
            const panel = $('supportChatPanel');
            const isPanelVisible = panel && panel.classList.contains('visible');
            
            // Count unread support messages BEFORE marking as read
            const unreadSupportMsgs = result.messages.filter(m => m.sender === 'support' && m.read === false);
            
            // Add messages to UI (only update lastMessageId if panel exists)
            const messagesContainer = $('supportChatMessages');
            for (const msg of result.messages) {
                addMessageToUI(msg);
                // Only track lastMessageId if messages were actually added to UI
                if (msg.id && messagesContainer) lastMessageId = msg.id;
            }
            
            // Only mark messages as read if panel is visible
            if (isPanelVisible) {
                markMessagesAsRead();
            } else if (unreadSupportMsgs.length > 0) {
                // Show notification for new unread support messages when panel is hidden
                unreadCount += unreadSupportMsgs.length;
                showNewMessageNotification(unreadCount);
            }
            
            // Check if ticket was closed (by support)
            if (result.status === 'closed') {
                stopMessagePolling();
                currentTicket = null;
                lastMessageId = null;
                if (window.electronAPI?.setSetting) {
                    window.electronAPI.setSetting('supportTicket', null);
                }
                showClosedTicketUI();
                return;
            }
        }
    } catch (err) {
        console.error('[SupportChat] Fetch error:', err);
    }
}

/**
 * Start polling for new messages
 */
function startMessagePolling() {
    if (messagePollingInterval) return;
    
    messagePollingInterval = setInterval(() => {
        fetchMessages();
    }, POLL_INTERVAL);
    
    // Initial fetch
    fetchMessages();
}

/**
 * Stop polling for messages
 */
function stopMessagePolling() {
    if (messagePollingInterval) {
        clearInterval(messagePollingInterval);
        messagePollingInterval = null;
    }
}

/**
 * Show new message notification popup (persistent until dismissed or chat opened)
 */
let supportNotificationId = null;

function showNewMessageNotification(count) {
    // Remove existing notification if any
    dismissSupportNotification();
    
    // Create persistent notification with X button
    supportNotificationId = notify(`📩 ${t('ui.notifications.newSupportMessages', { count })}`, { 
        type: 'info', 
        timeoutMs: 0, // Persistent - no auto-dismiss
        dismissible: true, // Shows X button
        action: {
            label: 'Open Chat',
            callback: () => {
                showSupportChat();
                dismissSupportNotification();
            }
        }
    });
}

/**
 * Dismiss the support notification
 */
function dismissSupportNotification() {
    if (supportNotificationId) {
        const notif = document.querySelector(`[data-notif-id="${supportNotificationId}"]`);
        if (notif) notif.remove();
        supportNotificationId = null;
    }
}

/**
 * Clear unread count
 */
function clearUnreadCount() {
    unreadCount = 0;
}

/**
 * Save ticket to storage
 */
function saveTicketToStorage() {
    if (currentTicket && window.electronAPI?.setSetting) {
        window.electronAPI.setSetting('supportTicket', currentTicket);
    }
}

/**
 * Load ticket from storage
 */
async function loadTicketFromStorage() {
    try {
        if (window.electronAPI?.getSetting) {
            const ticket = await window.electronAPI.getSetting('supportTicket');
            if (ticket && ticket.ticketId && ticket.authToken) {
                currentTicket = ticket;
            }
        }
    } catch (e) {
        console.error('[SupportChat] Failed to load ticket:', e);
    }
}

/**
 * Clear current ticket (close support session)
 */
export function clearTicket() {
    currentTicket = null;
    lastMessageId = null;
    stopMessagePolling();
    
    if (window.electronAPI?.setSetting) {
        window.electronAPI.setSetting('supportTicket', null);
    }
    
    // Clear UI
    const messagesContainer = $('supportChatMessages');
    if (messagesContainer) {
        messagesContainer.innerHTML = `
            <div id="supportChatWelcome" class="support-chat-welcome">
                <div class="welcome-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                </div>
                <h3 data-i18n="ui.supportChat.needHelp">${t('ui.supportChat.needHelp')}</h3>
                <p data-i18n="ui.supportChat.welcomeDesc">${t('ui.supportChat.welcomeDesc')}</p>
                <p class="welcome-note" data-i18n="ui.supportChat.welcomeNote">${t('ui.supportChat.welcomeNote')}</p>
            </div>
        `;
    }
    
    updateChatUI();
}

/**
 * Check for active ticket on app start
 */
export async function checkForActiveTicket() {
    await loadTicketFromStorage();
    
    if (currentTicket) {
        startMessagePolling();
    }
}

// Utility functions
function showChatStatus(message, type) {
    const status = $('supportChatStatus');
    if (status) {
        status.textContent = message;
        status.className = `support-chat-status ${type}`;
        status.classList.remove('hidden');
    }
}

function hideChatStatus() {
    const status = $('supportChatStatus');
    if (status) {
        status.classList.add('hidden');
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(mimeType) {
    if (mimeType?.startsWith('image/')) return '🖼️';
    if (mimeType?.startsWith('video/')) return '🎬';
    if (mimeType?.includes('zip')) return '📦';
    return '📎';
}

function isImageOrVideo(mimeType) {
    return mimeType?.startsWith('image/') || mimeType?.startsWith('video/');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
