/** Contact type: finger touch or tracked piece (glyph). */
export var BoardContactType;
(function (BoardContactType) {
    /** A finger touch. `glyphId` will be 0. */
    BoardContactType[BoardContactType["Finger"] = 0] = "Finger";
    /** A tracked piece (physical game piece with a glyph pattern). `glyphId` identifies the piece type. */
    BoardContactType[BoardContactType["Glyph"] = 1] = "Glyph";
})(BoardContactType || (BoardContactType = {}));
/**
 * Contact lifecycle phase.
 *
 * A contact progresses Began → Moved/Stationary → Ended (or Canceled).
 * Contacts persist across frames: a piece sitting still appears every frame
 * with phase Stationary until it is lifted (phase Ended).
 */
export var BoardContactPhase;
(function (BoardContactPhase) {
    /** No phase reported. Not typically seen in subscriber callbacks. */
    BoardContactPhase[BoardContactPhase["None"] = 0] = "None";
    /** Contact was just created this frame (first appearance). */
    BoardContactPhase[BoardContactPhase["Began"] = 1] = "Began";
    /** Contact moved since the previous frame. */
    BoardContactPhase[BoardContactPhase["Moved"] = 2] = "Moved";
    /** Contact was lifted. This is the final frame the contact appears in. */
    BoardContactPhase[BoardContactPhase["Ended"] = 3] = "Ended";
    /** Contact was canceled by the system (e.g. palm rejection). Final frame. */
    BoardContactPhase[BoardContactPhase["Canceled"] = 4] = "Canceled";
    /** Contact is still present but did not move this frame. Emitted every frame until Ended. */
    BoardContactPhase[BoardContactPhase["Stationary"] = 5] = "Stationary";
})(BoardContactPhase || (BoardContactPhase = {}));
/** Player type. */
export var BoardPlayerType;
(function (BoardPlayerType) {
    /** A signed-in Board profile with a persistent identity across sessions. */
    BoardPlayerType["Profile"] = "profile";
    /** An ephemeral guest player that exists only for the current session. */
    BoardPlayerType["Guest"] = "guest";
})(BoardPlayerType || (BoardPlayerType = {}));
//# sourceMappingURL=types.js.map