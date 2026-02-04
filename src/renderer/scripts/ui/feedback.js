/**
 * Feedback submission module
 * Handles user feedback with optional diagnostics and media attachments
 */

const $ = id => document.getElementById(id);

let feedbackModalInitialized = false;
let selectedFile = null;

/**
 * Show the feedback modal
 */
export function showFeedbackModal() {
    let modal = $('feedbackModal');
    
    if (!modal) {
        createFeedbackModal();
        modal = $('feedbackModal');
    }
    
    if (!feedbackModalInitialized) {
        initFeedbackModal();
        feedbackModalInitialized = true;
    }
    
    // Reset form state
    resetFeedbackForm();
    
    modal.classList.remove('hidden');
}

/**
 * Create the feedback modal HTML
 */
function createFeedbackModal() {
    const modal = document.createElement('div');
    modal.id = 'feedbackModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content feedback-modal">
            <div class="modal-header">
                <svg class="modal-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #5865F2;">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <h2>Send Feedback</h2>
                <button id="closeFeedbackModal" class="modal-close">&times;</button>
            </div>
            <div class="modal-body modal-body-padded">
                <p class="feedback-intro">Help us improve Sentry Six by sharing your feedback, suggestions, or bug reports.</p>
                <p class="feedback-retention-note">All data (feedback, diagnostics, and attachments) is automatically deleted after 72 hours.</p>
                
                <div class="feedback-form">
                    <textarea id="feedbackText" class="feedback-textarea" placeholder="Tell us what's on your mind... bug reports, feature requests, or general feedback" rows="5" maxlength="10000"></textarea>
                    <div class="feedback-char-count"><span id="feedbackCharCount">0</span>/10000</div>
                    
                    <div class="feedback-attachment">
                        <label class="feedback-file-label">
                            <input type="file" id="feedbackFile" accept="image/*,video/*" style="display: none;">
                            <div class="feedback-file-btn">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                                </svg>
                                Attach Screenshot/Video
                            </div>
                        </label>
                        <div id="feedbackFileInfo" class="feedback-file-info hidden">
                            <span id="feedbackFileName"></span>
                            <button id="feedbackFileClear" class="feedback-file-clear" title="Remove">&times;</button>
                        </div>
                        <div class="feedback-file-note">Max 100MB • Images or video recordings</div>
                    </div>
                    
                    <label class="toggle-row" style="margin-top: 12px;">
                        <div class="toggle-row-info">
                            <span class="toggle-row-label">Include Diagnostic Data</span>
                        </div>
                        <div class="toggle-switch">
                            <input type="checkbox" id="feedbackIncludeDiagnostics">
                            <div class="toggle-switch-track"><div class="toggle-switch-thumb"></div></div>
                        </div>
                    </label>
                    <div class="feedback-privacy-note">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink: 0;">
                            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
                        </svg>
                        <span>We redact usernames from file paths and GPS coordinates for your privacy.</span>
                    </div>
                    
                    <div id="feedbackStatus" class="feedback-status hidden"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="submitFeedbackBtn" class="btn btn-primary">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                    Submit Feedback
                </button>
                <button id="cancelFeedbackBtn" class="btn btn-secondary">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

/**
 * Initialize feedback modal event handlers
 */
function initFeedbackModal() {
    const modal = $('feedbackModal');
    const feedbackText = $('feedbackText');
    const feedbackCharCount = $('feedbackCharCount');
    const feedbackFile = $('feedbackFile');
    const feedbackFileInfo = $('feedbackFileInfo');
    const feedbackFileName = $('feedbackFileName');
    const feedbackFileClear = $('feedbackFileClear');
    const submitFeedbackBtn = $('submitFeedbackBtn');
    const closeFeedbackModal = $('closeFeedbackModal');
    const cancelFeedbackBtn = $('cancelFeedbackBtn');
    
    // Close handlers
    const closeModal = () => modal.classList.add('hidden');
    closeFeedbackModal.onclick = closeModal;
    cancelFeedbackBtn.onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // Character counter
    feedbackText.addEventListener('input', () => {
        feedbackCharCount.textContent = feedbackText.value.length;
    });
    
    // File selection
    feedbackFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const maxSize = 100 * 1024 * 1024;
            if (file.size > maxSize) {
                showFeedbackStatus('File too large. Maximum size is 100MB.', 'error');
                feedbackFile.value = '';
                return;
            }
            
            selectedFile = file;
            feedbackFileName.textContent = `${file.name} (${formatFileSize(file.size)})`;
            feedbackFileInfo.classList.remove('hidden');
        }
    });
    
    // Clear file
    feedbackFileClear.onclick = () => {
        selectedFile = null;
        feedbackFile.value = '';
        feedbackFileInfo.classList.add('hidden');
    };
    
    // Submit feedback
    submitFeedbackBtn.onclick = handleFeedbackSubmit;
}

/**
 * Handle feedback form submission
 */
async function handleFeedbackSubmit() {
    const feedbackText = $('feedbackText');
    const feedbackIncludeDiagnostics = $('feedbackIncludeDiagnostics');
    const submitFeedbackBtn = $('submitFeedbackBtn');
    
    const text = feedbackText?.value?.trim();
    
    if (!text) {
        showFeedbackStatus('Please enter your feedback.', 'error');
        return;
    }
    
    submitFeedbackBtn.disabled = true;
    showFeedbackStatus('Submitting feedback...', 'loading');
    
    try {
        // Collect diagnostics if enabled
        let diagnostics = null;
        if (feedbackIncludeDiagnostics?.checked) {
            const { collectDiagnostics } = await import('./diagnostics.js');
            diagnostics = await collectDiagnostics();
        }
        
        // Prepare media info
        let mediaInfo = null;
        if (selectedFile) {
            mediaInfo = {
                name: selectedFile.name,
                type: selectedFile.type,
                size: selectedFile.size
            };
        }
        
        // Submit feedback
        if (window.electronAPI?.submitFeedback) {
            const result = await window.electronAPI.submitFeedback({
                feedback: text,
                diagnostics: diagnostics,
                mediaInfo: mediaInfo
            });
            
            if (result.success) {
                // Upload media if present
                if (selectedFile && result.feedbackId) {
                    showFeedbackStatus('Uploading attachment...', 'loading');
                    
                    const mediaData = await readFileAsBase64(selectedFile);
                    
                    const mediaResult = await window.electronAPI.uploadFeedbackMedia({
                        feedbackId: result.feedbackId,
                        mediaData: mediaData,
                        fileName: selectedFile.name,
                        fileType: selectedFile.type,
                        fileSize: selectedFile.size
                    });
                    
                    if (!mediaResult.success) {
                        console.warn('Media upload failed:', mediaResult.error);
                    }
                }
                
                showFeedbackStatus('Thank you! Your feedback has been submitted.', 'success');
                
                // Close modal after short delay
                setTimeout(() => {
                    $('feedbackModal').classList.add('hidden');
                    resetFeedbackForm();
                }, 2000);
            } else {
                showFeedbackStatus('Failed to submit: ' + (result.error || 'Unknown error'), 'error');
            }
        } else {
            showFeedbackStatus('Feedback service not available', 'error');
        }
    } catch (err) {
        console.error('Feedback submission error:', err);
        showFeedbackStatus('Error: ' + err.message, 'error');
    } finally {
        submitFeedbackBtn.disabled = false;
    }
}

/**
 * Reset the feedback form to initial state
 */
function resetFeedbackForm() {
    const feedbackText = $('feedbackText');
    const feedbackCharCount = $('feedbackCharCount');
    const feedbackFile = $('feedbackFile');
    const feedbackFileInfo = $('feedbackFileInfo');
    const feedbackIncludeDiagnostics = $('feedbackIncludeDiagnostics');
    const feedbackStatus = $('feedbackStatus');
    
    if (feedbackText) feedbackText.value = '';
    if (feedbackCharCount) feedbackCharCount.textContent = '0';
    if (feedbackFile) feedbackFile.value = '';
    if (feedbackFileInfo) feedbackFileInfo.classList.add('hidden');
    if (feedbackIncludeDiagnostics) feedbackIncludeDiagnostics.checked = false;
    if (feedbackStatus) feedbackStatus.classList.add('hidden');
    selectedFile = null;
}

/**
 * Show feedback status message
 */
function showFeedbackStatus(message, type) {
    const feedbackStatus = $('feedbackStatus');
    if (feedbackStatus) {
        feedbackStatus.textContent = message;
        feedbackStatus.className = `feedback-status ${type}`;
        feedbackStatus.classList.remove('hidden');
    }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Read file as base64
 */
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
