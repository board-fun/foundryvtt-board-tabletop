import { callAsync } from "./bridge.js";
/**
 * Board avatar API.
 *
 * @example
 * ```ts
 * import { Board } from "@harrishill/board-sdk";
 *
 * const dataUri = await Board.avatar.loadPNG(3);
 * img.src = dataUri; // "data:image/png;base64,..."
 * ```
 */
export const avatar = {
    /**
     * Load an avatar image as a data URI.
     * @param avatarId Avatar ID (1-8)
     * @returns Data URI string (data:image/png;base64,...)
     */
    async loadPNG(avatarId) {
        const result = await callAsync("loadAvatarPNG", avatarId);
        return result.dataUri;
    },
};
//# sourceMappingURL=avatar.js.map