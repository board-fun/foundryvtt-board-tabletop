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
export declare const avatar: {
    /**
     * Load an avatar image as a data URI.
     * @param avatarId Avatar ID (1-8)
     * @returns Data URI string (data:image/png;base64,...)
     */
    loadPNG(avatarId: number): Promise<string>;
};
//# sourceMappingURL=avatar.d.ts.map