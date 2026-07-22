import { BoardPauseContext, BoardPauseResult } from "./types.js";
/**
 * Board pause screen API.
 *
 * Controls the system pause menu overlay, including custom buttons
 * and audio track sliders.
 *
 * @example
 * ```ts
 * import { Board } from "@harrishill/board-sdk";
 *
 * Board.pause.setContext({
 *   gameName: "My Game",
 *   offerSaveOption: true,
 *   customButtons: [
 *     { id: "restart", title: "Restart", icon: "circulararrow" },
 *   ],
 *   audioTracks: [
 *     { id: "music", name: "Music", value: 75 },
 *     { id: "sfx", name: "Sound Effects", value: 85 },
 *   ],
 * });
 * ```
 */
export declare const pause: {
    /**
     * Set the pause screen context. This configures what the system pause
     * menu shows when the user opens it via the system menu button.
     */
    setContext(context: BoardPauseContext): void;
    /** Clear the pause screen context. */
    clearContext(): void;
    /**
     * Poll for a pause screen result. Returns null if no action has been
     * taken, or a result object with the action and any updated audio values.
     *
     * Call this periodically (e.g. in your game loop) to check for pause
     * screen interactions.
     */
    pollResult(): BoardPauseResult | null;
};
//# sourceMappingURL=pause.d.ts.map