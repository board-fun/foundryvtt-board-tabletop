export { isBoardDevice } from "./bridge.js";
export { input } from "./input.js";
export { session } from "./session.js";
export { save } from "./save.js";
export { avatar } from "./avatar.js";
export { pause } from "./pause.js";
export { BoardContact, BoardContactType, BoardContactPhase, BoardPlayer, BoardPlayerType, BoardSaveGameMetadata, BoardPauseButton, BoardPauseAudioTrack, BoardPauseAudioTrackResult, BoardPauseContext, BoardPauseResult, } from "./types.js";
export type { TouchFrameCallback } from "./input.js";
export { SDK_VERSION } from "./version.js";
/**
 * Board Web SDK - main namespace.
 *
 * Entry point for all Board APIs when running inside a Board WebView. Check
 * `Board.isOnDevice` before calling any API to confirm the bridges are available.
 *
 * @example
 * ```ts
 * import { Board } from "@harrishill/board-sdk";
 *
 * if (Board.isOnDevice) {
 *   // Touch input at ~60fps+
 *   Board.input.subscribe((contacts) => { ... });
 *
 *   // Session
 *   const players = Board.session.getPlayers();
 *   await Board.session.presentAddPlayer();
 *   Board.session.showProfileSwitcher();
 *
 *   // Save games
 *   const saves = await Board.save.list();
 *   const data = await Board.save.load(saves[0].id);
 *
 *   // Pause screen
 *   Board.pause.setContext({ gameName: "My Game", ... });
 * }
 * ```
 */
export declare const Board: {
    readonly input: {
        subscribe(callback: import("./input.js").TouchFrameCallback): void;
        unsubscribe(callback: import("./input.js").TouchFrameCallback): void;
        getContacts(): ReadonlyArray<import("./types.js").BoardContact>;
        getContactsByType(type: import("./types.js").BoardContactType): ReadonlyArray<import("./types.js").BoardContact>;
        readonly isSubscribed: boolean;
    };
    readonly session: {
        getPlayers(): import("./types.js").BoardPlayer[];
        getPlayerCount(): number;
        addGuest(sessionId: number): void;
        removePlayer(sessionId: number): void;
        isReady(): boolean;
        areServicesReady(): boolean;
        resetPlayers(): boolean;
        getActiveProfile(): import("./types.js").BoardPlayer | null;
        presentAddPlayer(): Promise<void>;
        presentReplacePlayer(sessionId: number): Promise<void>;
        showProfileSwitcher(): void;
        hideProfileSwitcher(): void;
    };
    readonly save: {
        create(description: string, data: Uint8Array, playedTime: number, gameVersion: string): Promise<import("./types.js").BoardSaveGameMetadata>;
        load(saveId: string): Promise<Uint8Array>;
        list(): Promise<import("./types.js").BoardSaveGameMetadata[]>;
        update(saveId: string, description: string, data: Uint8Array, playedTime: number, gameVersion: string): Promise<void>;
        delete(saveId: string): Promise<void>;
        removePlayersFromSave(saveId: string): Promise<void>;
        removeActiveProfileFromSave(saveId: string): Promise<void>;
        loadCoverImage(saveId: string): Promise<string>;
        getMaxDataSize(): number;
        getMaxAppStorageSize(): number;
        getMaxDescriptionLength(): number;
    };
    readonly avatar: {
        loadPNG(avatarId: number): Promise<string>;
    };
    readonly pause: {
        setContext(context: import("./types.js").BoardPauseContext): void;
        clearContext(): void;
        pollResult(): import("./types.js").BoardPauseResult | null;
    };
    /** True when running inside a Board WebView with the SDK bridges available. Always check before calling any other `Board.*` API. */
    readonly isOnDevice: boolean;
    /** SDK version string (semver), matching the `@harrishill/board-sdk` package version. */
    readonly sdkVersion: string;
    /**
     * Bridge API version reported by the host OS, or `null` if not running on
     * a Board device. Older OS builds may not implement the version call; those
     * are reported as `0`. Use this to feature-gate calls that depend on
     * newer OS capabilities.
     *
     * @example
     * ```ts
     * if ((Board.bridgeVersion ?? 0) >= 2) {
     *   // call a V2-only API
     * }
     * ```
     */
    readonly bridgeVersion: number | null;
};
//# sourceMappingURL=index.d.ts.map