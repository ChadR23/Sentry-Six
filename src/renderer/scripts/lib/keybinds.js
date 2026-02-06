/**
 * Keybind System
 * Manages customizable keyboard shortcuts
 */

// Currently recording keybind input
let recordingKeybindInput = null;

// Keybind action handlers - set via initKeybindActions
let keybindActions = {};

/**
 * Initialize keybind action handlers
 * @param {Object} actions - Map of action names to handler functions
 */
export function initKeybindActions(actions) {
    keybindActions = actions;
}

/**
 * Load keybinds from storage
 * @returns {Promise<Object>} Saved keybinds
 */
async function loadKeybinds() {
    try {
        if (window.electronAPI?.getSetting) {
            const saved = await window.electronAPI.getSetting('keybinds');
            return saved || {};
        }
        return {};
    } catch (e) {
        console.error('Failed to load keybinds:', e);
        return {};
    }
}

/**
 * Save keybinds to storage
 * @param {Object} keybinds - Keybinds to save
 */
function saveKeybinds(keybinds) {
    if (window.electronAPI?.setSetting) {
        window.electronAPI.setSetting('keybinds', keybinds);
    }
}

/**
 * Format a key event into a readable string
 * @param {KeyboardEvent} e - Keyboard event
 * @returns {string} Formatted key string
 */
function formatKeyEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    
    // Get the key name
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key === 'ArrowUp') key = '↑';
    else if (key === 'ArrowDown') key = '↓';
    else if (key === 'ArrowLeft') key = '←';
    else if (key === 'ArrowRight') key = '→';
    else if (key.length === 1) key = key.toUpperCase();
    
    // Don't add modifier keys as the main key
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        parts.push(key);
    }
    
    return parts.join(' + ');
}

/**
 * Create a unique key identifier for matching
 * @param {KeyboardEvent} e - Keyboard event
 * @returns {string} Key identifier
 */
function getKeyIdentifier(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('meta');
    mods.push(e.code || e.key);
    return mods.join('+').toLowerCase();
}

/**
 * Initialize keybind settings UI
 */
export async function initKeybindSettings() {
    const keybinds = await loadKeybinds();
    const keybindInputs = document.querySelectorAll('.keybind-input');
    const keybindClears = document.querySelectorAll('.keybind-clear');
    
    // Populate existing keybinds
    keybindInputs.forEach(input => {
        const action = input.dataset.action;
        if (keybinds[action]) {
            input.value = keybinds[action].display;
        }
    });
    
    // Handle keybind input focus (start recording)
    keybindInputs.forEach(input => {
        input.addEventListener('focus', () => {
            // Clear recording state from any previously active input
            // (modifier+click can bypass normal blur, leaving multiple inputs "selected")
            if (recordingKeybindInput && recordingKeybindInput !== input) {
                recordingKeybindInput.classList.remove('recording');
                const prevAction = recordingKeybindInput.dataset.action;
                loadKeybinds().then(kb => {
                    recordingKeybindInput.value = kb[prevAction]?.display || '';
                });
            }
            recordingKeybindInput = input;
            input.classList.add('recording');
            input.value = 'Press a key...';
        });
        
        input.addEventListener('blur', async () => {
            if (recordingKeybindInput === input) {
                input.classList.remove('recording');
                // Restore previous value if no key was pressed
                const action = input.dataset.action;
                const keybinds = await loadKeybinds();
                input.value = keybinds[action]?.display || '';
                recordingKeybindInput = null;
            }
        });
    });
    
    // Handle clear buttons
    keybindClears.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const action = btn.dataset.action;
            const keybinds = await loadKeybinds();
            delete keybinds[action];
            saveKeybinds(keybinds);
            
            // Clear the input
            const input = document.querySelector(`.keybind-input[data-action="${action}"]`);
            if (input) input.value = '';
        });
    });
}

/**
 * Global keyboard event handler for keybind recording and execution
 * @param {KeyboardEvent} e - Keyboard event
 */
async function handleGlobalKeydown(e) {
    // If we're recording a keybind
    if (recordingKeybindInput) {
        e.preventDefault();
        e.stopPropagation();
        
        // Ignore lone modifier keys
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
            return;
        }
        
        const action = recordingKeybindInput.dataset.action;
        const display = formatKeyEvent(e);
        const identifier = getKeyIdentifier(e);
        
        // Check for conflicts with other keybinds
        const keybinds = await loadKeybinds();
        for (const [existingAction, binding] of Object.entries(keybinds)) {
            if (existingAction !== action && binding.identifier === identifier) {
                // Remove the conflicting keybind
                delete keybinds[existingAction];
                const conflictInput = document.querySelector(`.keybind-input[data-action="${existingAction}"]`);
                if (conflictInput) conflictInput.value = '';
            }
        }
        
        // Save the new keybind
        keybinds[action] = { display, identifier };
        saveKeybinds(keybinds);
        
        // Update UI
        recordingKeybindInput.value = display;
        recordingKeybindInput.classList.remove('recording');
        recordingKeybindInput.blur();
        recordingKeybindInput = null;
        return;
    }
    
    // Check if we're in a text input field (don't trigger keybinds)
    // Allow keybinds for range sliders (e.g., progress bar) since they're not text entry
    const activeEl = document.activeElement;
    const isTextInput = activeEl && (
        (activeEl.tagName === 'INPUT' && activeEl.type !== 'range') ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
    );
    if (isTextInput) {
        return;
    }
    
    // Check if settings modal is open (don't trigger keybinds)
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal && !settingsModal.classList.contains('hidden')) {
        return;
    }
    
    // Execute keybind action if matched
    const identifier = getKeyIdentifier(e);
    const keybinds = await loadKeybinds();
    
    for (const [action, binding] of Object.entries(keybinds)) {
        if (binding.identifier === identifier) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (keybindActions[action]) {
                keybindActions[action]();
            }
            return;
        }
    }
}

/**
 * Initialize the global keybind listener
 */
export function initGlobalKeybindListener() {
    document.addEventListener('keydown', handleGlobalKeydown);
}
