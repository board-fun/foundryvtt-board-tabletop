/**
 * Low-level bridge to the Android @JavascriptInterface and WebMessageListener APIs.
 * Not intended for direct use by game developers -- use the Board.* APIs instead.
 * @internal
 */
/** Raw bridge object injected by BoardJsBridge.java via @JavascriptInterface. */
export interface BoardSDKBridge {
    /**
     * Bridge API version reported by the OS. Monotonically increasing integer.
     * Callers must handle the case where this method is absent (very old OS
     * builds) by treating the bridge as version 0.
     */
    getApiVersion?(): number;
    getPlayers(): string;
    getPlayerCount(): number;
    addGuest(sessionId: number): void;
    removePlayer(sessionId: number): void;
    resetPlayers(): boolean;
    getActiveProfile(): string;
    isReady(): boolean;
    areServicesReady(): boolean;
    getCurrentContacts(): string;
    createSave(description: string, dataBase64: string, playedTime: number, gameVersion: string): number;
    loadSave(saveId: string): number;
    listSaves(): number;
    deleteSave(saveId: string): number;
    updateSave(saveId: string, description: string, dataBase64: string, playedTime: number, gameVersion: string): number;
    removePlayersFromSave(saveId: string): number;
    removeActiveProfileFromSave(saveId: string): number;
    loadCoverImage(saveId: string): number;
    getMaxSaveDataSize(): number;
    getMaxAppStorageSize(): number;
    getMaxSaveDescriptionLength(): number;
    loadAvatarPNG(avatarId: number): number;
    showProfileSwitcher(): void;
    hideProfileSwitcher(): void;
    setPauseContext(jsonConfig: string): void;
    clearPauseContext(): void;
    getPauseResult(): string;
    presentAddPlayerSelector(): number;
    presentReplacePlayerSelector(sessionId: number): number;
}
/** Touch push channel injected by BoardTouchChannel.java via addWebMessageListener. */
export interface BoardTouchBridge {
    postMessage(data: string): void;
    onmessage: ((event: MessageEvent) => void) | null;
}
declare global {
    interface Window {
        BoardSDK?: BoardSDKBridge;
        boardTouch?: BoardTouchBridge;
        __board?: {
            _pending: Map<number, {
                resolve: (v: any) => void;
                reject: (e: Error) => void;
            }>;
            resolve(id: number, result: string): void;
            reject(id: number, error: string): void;
        };
    }
}
/** Returns true if running inside a Board WebView with bridges available. */
export declare function isBoardDevice(): boolean;
/** Get the raw @JavascriptInterface bridge. Throws if not on a Board device. */
export declare function getBridge(): BoardSDKBridge;
/**
 * Initialize the async callback registry used by @JavascriptInterface async methods.
 * Must be called before any async bridge calls (save games, avatars).
 */
export declare function initAsyncBridge(): void;
/** Call an async @JavascriptInterface method and return a Promise. */
export declare function callAsync<T>(method: string, ...args: any[]): Promise<T>;
//# sourceMappingURL=bridge.d.ts.map