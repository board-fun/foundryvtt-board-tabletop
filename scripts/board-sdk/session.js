import { callAsync, getBridge } from "./bridge.js";
import { BoardPlayerType } from "./types.js";
function parsePlayer(raw) {
    return {
        playerId: raw.playerId,
        sessionId: raw.sessionId,
        name: raw.name,
        type: raw.type === "guest" ? BoardPlayerType.Guest : BoardPlayerType.Profile,
        avatarId: raw.avatarId,
    };
}
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
export const session = {
    /** Get all players in the current session. */
    getPlayers() {
        const json = getBridge().getPlayers();
        const raw = JSON.parse(json);
        return raw.map(parsePlayer);
    },
    /** Get the number of players in the current session. */
    getPlayerCount() {
        return getBridge().getPlayerCount();
    },
    /**
     * Add a guest player to the session.
     * @param sessionId Session-unique ID to assign to the new guest. Must not collide with any existing `BoardPlayer.sessionId` in the session.
     */
    addGuest(sessionId) {
        getBridge().addGuest(sessionId);
    },
    /**
     * Remove a player from the session by session ID.
     * @param sessionId `BoardPlayer.sessionId` of the player to remove (from `getPlayers()`).
     */
    removePlayer(sessionId) {
        getBridge().removePlayer(sessionId);
    },
    /** Whether the session manager is ready. */
    isReady() {
        return getBridge().isReady();
    },
    /** Whether the underlying OS services (UDS, SOS) are connected. */
    areServicesReady() {
        return getBridge().areServicesReady();
    },
    /**
     * Reset session to initial state (only active profile remains).
     * @returns true if reset succeeded
     */
    resetPlayers() {
        return getBridge().resetPlayers();
    },
    /** Get the current system-wide active profile. */
    getActiveProfile() {
        const json = getBridge().getActiveProfile();
        if (json === "null")
            return null;
        return parsePlayer(JSON.parse(json));
    },
    /**
     * Present the OS player selector overlay to add a new player.
     * Returns a Promise that resolves when the selector is dismissed.
     */
    async presentAddPlayer() {
        await callAsync("presentAddPlayerSelector");
    },
    /**
     * Present the OS player selector overlay to replace an existing player.
     * @param sessionId Session ID of the player to replace
     */
    async presentReplacePlayer(sessionId) {
        await callAsync("presentReplacePlayerSelector", sessionId);
    },
    /** Show the profile switcher overlay. */
    showProfileSwitcher() {
        getBridge().showProfileSwitcher();
    },
    /** Hide the profile switcher overlay. */
    hideProfileSwitcher() {
        getBridge().hideProfileSwitcher();
    },
};
//# sourceMappingURL=session.js.map