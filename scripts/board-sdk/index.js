export { isBoardDevice } from "./bridge.js";
export { input } from "./input.js";
export { session } from "./session.js";
export { save } from "./save.js";
export { avatar } from "./avatar.js";
export { pause } from "./pause.js";
export { BoardContactType, BoardContactPhase, BoardPlayerType, } from "./types.js";
import { isBoardDevice } from "./bridge.js";
import { input } from "./input.js";
import { session } from "./session.js";
import { save } from "./save.js";
import { avatar } from "./avatar.js";
import { pause } from "./pause.js";
import { SDK_VERSION } from "./version.js";
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
export const Board = {
    input,
    session,
    save,
    avatar,
    pause,
    /** True when running inside a Board WebView with the SDK bridges available. Always check before calling any other `Board.*` API. */
    get isOnDevice() {
        return isBoardDevice();
    },
    /** SDK version string (semver), matching the `@harrishill/board-sdk` package version. */
    get sdkVersion() {
        return SDK_VERSION;
    },
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
    get bridgeVersion() {
        if (!isBoardDevice())
            return null;
        const bridge = window.BoardSDK;
        return typeof bridge.getApiVersion === "function" ? bridge.getApiVersion() : 0;
    },
};
//# sourceMappingURL=index.js.map