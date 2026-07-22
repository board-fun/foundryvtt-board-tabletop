import { BoardPlayer } from "./types.js";
/**
 * Board session and player management API.
 *
 * @example
 * ```ts
 * import { Board } from "@harrishill/board-sdk";
 *
 * const players = Board.session.getPlayers();
 * console.log(`${players.length} players in session`);
 * ```
 */
export declare const session: {
    /** Get all players in the current session. */
    getPlayers(): BoardPlayer[];
    /** Get the number of players in the current session. */
    getPlayerCount(): number;
    /**
     * Add a guest player to the session.
     * @param sessionId Session-unique ID to assign to the new guest. Must not collide with any existing `BoardPlayer.sessionId` in the session.
     */
    addGuest(sessionId: number): void;
    /**
     * Remove a player from the session by session ID.
     * @param sessionId `BoardPlayer.sessionId` of the player to remove (from `getPlayers()`).
     */
    removePlayer(sessionId: number): void;
    /** Whether the session manager is ready. */
    isReady(): boolean;
    /** Whether the underlying OS services (UDS, SOS) are connected. */
    areServicesReady(): boolean;
    /**
     * Reset session to initial state (only active profile remains).
     * @returns true if reset succeeded
     */
    resetPlayers(): boolean;
    /** Get the current system-wide active profile. */
    getActiveProfile(): BoardPlayer | null;
    /**
     * Present the OS player selector overlay to add a new player.
     * Returns a Promise that resolves when the selector is dismissed.
     */
    presentAddPlayer(): Promise<void>;
    /**
     * Present the OS player selector overlay to replace an existing player.
     * @param sessionId Session ID of the player to replace
     */
    presentReplacePlayer(sessionId: number): Promise<void>;
    /** Show the profile switcher overlay. */
    showProfileSwitcher(): void;
    /** Hide the profile switcher overlay. */
    hideProfileSwitcher(): void;
};
//# sourceMappingURL=session.d.ts.map