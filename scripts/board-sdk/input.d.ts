import { BoardContact, BoardContactType } from "./types.js";
/** Callback for touch frame events. */
export type TouchFrameCallback = (contacts: ReadonlyArray<BoardContact>) => void;
/**
 * Board touch input API.
 *
 * Provides access to physical touch contacts (fingers and tracked pieces)
 * on the Board surface. Contacts are pushed from the native layer at the
 * sensor frame rate (~60fps).
 *
 * @example
 * ```ts
 * import { Board } from "@harrishill/board-sdk";
 *
 * // Subscribe to touch frames
 * Board.input.subscribe((contacts) => {
 *   for (const c of contacts) {
 *     if (c.type === BoardContactType.Glyph) {
 *       console.log(`Piece ${c.glyphId} at (${c.x}, ${c.y})`);
 *     }
 *   }
 * });
 *
 * // Or read current state any time
 * const contacts = Board.input.getContacts();
 * ```
 */
export declare const input: {
    /**
     * Subscribe to the touch push channel. The callback fires on every
     * inference frame (~60fps) with the current set of active contacts.
     *
     * Contacts persist across frames -- a piece sitting still will appear
     * with phase=Stationary until it is removed (phase=Ended).
     */
    subscribe(callback: TouchFrameCallback): void;
    /** Remove a previously registered callback. */
    unsubscribe(callback: TouchFrameCallback): void;
    /**
     * Get the current set of active contacts (snapshot).
     * This reads from the internal state maintained by the push channel.
     * If the push channel is not subscribed, returns an empty array.
     */
    getContacts(): ReadonlyArray<BoardContact>;
    /**
     * Get contacts filtered by type.
     */
    getContactsByType(type: BoardContactType): ReadonlyArray<BoardContact>;
    /** Whether the push channel is active. */
    readonly isSubscribed: boolean;
};
//# sourceMappingURL=input.d.ts.map