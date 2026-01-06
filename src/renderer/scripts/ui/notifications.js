/**
 * Toast Notification System
 * Displays temporary toast messages to the user
 */

let notificationIdCounter = 0;

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {Object} opts - Options
 * @param {string} opts.type - 'info' | 'success' | 'warn' | 'error'
 * @param {number} opts.timeoutMs - Duration to show (0 = persistent, auto-calculated if not provided)
 * @param {boolean} opts.dismissible - Show X button to dismiss
 * @param {Object} opts.action - Action button { label, callback }
 * @returns {string} Notification ID
 */
export function notify(message, opts = {}) {
    const type = opts.type || 'info';
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (type === 'error' ? 5500 : 3200);
    const notifId = `notif-${++notificationIdCounter}`;

    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.dataset.notifId = notifId;
    
    let html = `<span class="dot" aria-hidden="true"></span><div class="msg"></div>`;
    
    // Add action button if provided
    if (opts.action && opts.action.label) {
        html += `<button class="toast-action">${opts.action.label}</button>`;
    }
    
    // Add dismiss button if dismissible
    if (opts.dismissible) {
        html += `<button class="toast-dismiss" title="Dismiss">&times;</button>`;
    }
    
    el.innerHTML = html;
    el.querySelector('.msg').textContent = String(message || '');
    container.appendChild(el);

    // Remove function
    const remove = () => {
        el.classList.remove('show');
        setTimeout(() => { try { el.remove(); } catch { } }, 180);
    };

    // Setup action button click
    if (opts.action && opts.action.callback) {
        const actionBtn = el.querySelector('.toast-action');
        if (actionBtn) {
            actionBtn.onclick = () => {
                opts.action.callback();
                remove();
            };
        }
    }
    
    // Setup dismiss button click
    if (opts.dismissible) {
        const dismissBtn = el.querySelector('.toast-dismiss');
        if (dismissBtn) {
            dismissBtn.onclick = remove;
        }
    }

    // Animate in
    requestAnimationFrame(() => el.classList.add('show'));

    // Auto remove (only if timeoutMs > 0)
    if (timeoutMs > 0) {
        setTimeout(remove, timeoutMs);
    }
    
    return notifId;
}
