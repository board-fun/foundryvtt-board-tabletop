/**
 * Low-level bridge to the Android @JavascriptInterface and WebMessageListener APIs.
 * Not intended for direct use by game developers -- use the Board.* APIs instead.
 * @internal
 */
/** Returns true if running inside a Board WebView with bridges available. */
export function isBoardDevice() {
    return typeof window.BoardSDK !== "undefined";
}
/** Get the raw @JavascriptInterface bridge. Throws if not on a Board device. */
export function getBridge() {
    if (!window.BoardSDK) {
        throw new Error("BoardSDK bridge not available. Are you running inside a Board WebView?");
    }
    return window.BoardSDK;
}
/**
 * Initialize the async callback registry used by @JavascriptInterface async methods.
 * Must be called before any async bridge calls (save games, avatars).
 */
export function initAsyncBridge() {
    if (window.__board)
        return;
    window.__board = {
        _pending: new Map(),
        resolve(id, result) {
            const p = this._pending.get(id);
            if (p) {
                this._pending.delete(id);
                p.resolve(JSON.parse(result));
            }
        },
        reject(id, error) {
            const p = this._pending.get(id);
            if (p) {
                this._pending.delete(id);
                p.reject(new Error(error));
            }
        },
    };
}
/** Call an async @JavascriptInterface method and return a Promise. */
export function callAsync(method, ...args) {
    initAsyncBridge();
    return new Promise((resolve, reject) => {
        const bridge = getBridge();
        const fn = bridge[method];
        if (typeof fn !== "function") {
            reject(new Error(`BoardSDK.${method} is not a function`));
            return;
        }
        const id = fn.apply(bridge, args);
        window.__board._pending.set(id, { resolve, reject });
    });
}
//# sourceMappingURL=bridge.js.map