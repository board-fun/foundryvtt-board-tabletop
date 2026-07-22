import { callAsync, getBridge } from "./bridge.js";
/**
 * Board save game API.
 *
 * All async methods communicate with the UserDataService via AIDL.
 *
 * @example
 * ```ts
 * import { Board } from "@harrishill/board-sdk";
 *
 * // Create a save
 * const data = new TextEncoder().encode("game state here");
 * const meta = await Board.save.create("My Save", data, 12345, "1.0.0");
 *
 * // List saves
 * const saves = await Board.save.list();
 *
 * // Load a save
 * const loaded = await Board.save.load(saves[0].id);
 *
 * // Update a save
 * await Board.save.update(saves[0].id, "Updated", newData, 23456, "1.1.0");
 *
 * // Delete a save
 * await Board.save.delete(saves[0].id);
 * ```
 */
export const save = {
    /**
     * Create a new save game.
     * @param description Human-readable save name (max 100 chars)
     * @param data Save data (max 16MB)
     * @param playedTime Total played time in milliseconds
     * @param gameVersion Game version string
     * @returns Metadata of the created save
     */
    async create(description, data, playedTime, gameVersion) {
        const base64 = uint8ArrayToBase64(data);
        return callAsync("createSave", description, base64, playedTime, gameVersion);
    },
    /**
     * Load save game data by ID.
     * @returns The raw save data as a Uint8Array
     */
    async load(saveId) {
        const result = await callAsync("loadSave", saveId);
        return base64ToUint8Array(result.data);
    },
    /** List all save games for the current app. */
    async list() {
        return callAsync("listSaves");
    },
    /**
     * Update an existing save game.
     * @param saveId Save game ID to update
     * @param description New description
     * @param data New save data
     * @param playedTime Updated played time in milliseconds
     * @param gameVersion Updated game version string
     */
    async update(saveId, description, data, playedTime, gameVersion) {
        const base64 = uint8ArrayToBase64(data);
        await callAsync("updateSave", saveId, description, base64, playedTime, gameVersion);
    },
    /**
     * Delete a save game.
     * @param saveId Save game ID to delete
     */
    async delete(saveId) {
        await callAsync("deleteSave", saveId);
    },
    /**
     * Remove all players from a save game.
     * The save data remains but is no longer associated with any players.
     */
    async removePlayersFromSave(saveId) {
        await callAsync("removePlayersFromSave", saveId);
    },
    /**
     * Remove the active profile from a save game.
     */
    async removeActiveProfileFromSave(saveId) {
        await callAsync("removeActiveProfileFromSave", saveId);
    },
    /**
     * Load a save game's cover image.
     * @returns Data URI string (data:image/png;base64,...) or null
     */
    async loadCoverImage(saveId) {
        const result = await callAsync("loadCoverImage", saveId);
        return result.dataUri;
    },
    /** Maximum size of a single save game's data in bytes. */
    getMaxDataSize() {
        return getBridge().getMaxSaveDataSize();
    },
    /** Maximum total storage for all saves in bytes. */
    getMaxAppStorageSize() {
        return getBridge().getMaxAppStorageSize();
    },
    /** Maximum length of a save description string. */
    getMaxDescriptionLength() {
        return getBridge().getMaxSaveDescriptionLength();
    },
};
function uint8ArrayToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
//# sourceMappingURL=save.js.map