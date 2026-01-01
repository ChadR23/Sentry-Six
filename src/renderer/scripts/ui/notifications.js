/**
 * Toast Notification System
 * Displays temporary toast messages to the user
 */

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {Object} opts - Options
 * @param {string} opts.type - 'info' | 'success' | 'warn' | 'error'
 * @param {number} opts.timeoutMs - Duration to show (auto-calculated if not provided)
 */
export function notify(message, opts = {}) {
    const type = opts.type || 'info'; // 'info' | 'success' | 'warn' | 'error'
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (type === 'error' ? 5500 : 3200);

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
    el.innerHTML = `<span class="dot" aria-hidden="true"></span><div class="msg"></div>`;
    el.querySelector('.msg').textContent = String(message || '');
    container.appendChild(el);

    // Animate in
    requestAnimationFrame(() => el.classList.add('show'));

    // Auto remove
    const remove = () => {
        el.classList.remove('show');
        setTimeout(() => { try { el.remove(); } catch { } }, 180);
    };
    setTimeout(remove, timeoutMs);
}
