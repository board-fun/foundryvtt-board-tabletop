import { BoardSaveGameMetadata } from "./types.js";
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
export declare const save: {
    /**
     * Create a new save game.
     * @param description Human-readable save name (max 100 chars)
     * @param data Save data (max 16MB)
     * @param playedTime Total played time in milliseconds
     * @param gameVersion Game version string
     * @returns Metadata of the created save
     */
    create(description: string, data: Uint8Array, playedTime: number, gameVersion: string): Promise<BoardSaveGameMetadata>;
    /**
     * Load save game data by ID.
     * @returns The raw save data as a Uint8Array
     */
    load(saveId: string): Promise<Uint8Array>;
    /** List all save games for the current app. */
    list(): Promise<BoardSaveGameMetadata[]>;
    /**
     * Update an existing save game.
     * @param saveId Save game ID to update
     * @param description New description
     * @param data New save data
     * @param playedTime Updated played time in milliseconds
     * @param gameVersion Updated game version string
     */
    update(saveId: string, description: string, data: Uint8Array, playedTime: number, gameVersion: string): Promise<void>;
    /**
     * Delete a save game.
     * @param saveId Save game ID to delete
     */
    delete(saveId: string): Promise<void>;
    /**
     * Remove all players from a save game.
     * The save data remains but is no longer associated with any players.
     */
    removePlayersFromSave(saveId: string): Promise<void>;
    /**
     * Remove the active profile from a save game.
     */
    removeActiveProfileFromSave(saveId: string): Promise<void>;
    /**
     * Load a save game's cover image.
     * @returns Data URI string (data:image/png;base64,...) or null
     */
    loadCoverImage(saveId: string): Promise<string>;
    /** Maximum size of a single save game's data in bytes. */
    getMaxDataSize(): number;
    /** Maximum total storage for all saves in bytes. */
    getMaxAppStorageSize(): number;
    /** Maximum length of a save description string. */
    getMaxDescriptionLength(): number;
};
//# sourceMappingURL=save.d.ts.map