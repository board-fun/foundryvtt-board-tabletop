import { getBridge } from "./bridge.js";
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
export const pause = {
    /**
     * Set the pause screen context. This configures what the system pause
     * menu shows when the user opens it via the system menu button.
     */
    setContext(context) {
        getBridge().setPauseContext(JSON.stringify(context));
    },
    /** Clear the pause screen context. */
    clearContext() {
        getBridge().clearPauseContext();
    },
    /**
     * Poll for a pause screen result. Returns null if no action has been
     * taken, or a result object with the action and any updated audio values.
     *
     * Call this periodically (e.g. in your game loop) to check for pause
     * screen interactions.
     */
    pollResult() {
        const json = getBridge().getPauseResult();
        if (json === "null")
            return null;
        return JSON.parse(json);
    },
};
//# sourceMappingURL=pause.js.map