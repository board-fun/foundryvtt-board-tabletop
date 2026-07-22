import { BoardContactPhase } from "./types.js";
// Active contact state (maintained from push events)
const contactState = new Map();
let frameCallbacks = [];
let subscribed = false;
function parseContact(raw) {
    return {
        contactId: raw.id,
        x: raw.x,
        y: raw.y,
        orientation: raw.o,
        type: raw.t,
        phase: raw.p,
        glyphId: raw.g,
        isTouched: raw.touched === 1,
    };
}
function parseBinaryFrame(buffer) {
    const view = new DataView(buffer);
    const count = view.getInt32(8, true);
    const contacts = [];
    for (let i = 0; i < count; i++) {
        const off = 12 + i * 36;
        contacts.push({
            contactId: view.getInt32(off, true),
            x: view.getFloat32(off + 4, true),
            y: view.getFloat32(off + 8, true),
            orientation: view.getFloat32(off + 12, true),
            type: view.getInt32(off + 16, true),
            phase: view.getInt32(off + 20, true),
            glyphId: view.getInt32(off + 24, true),
            isTouched: view.getInt32(off + 28, true) === 1,
        });
    }
    return contacts;
}
function handlePushFrame(event) {
    let events;
    if (event.data instanceof ArrayBuffer) {
        events = parseBinaryFrame(event.data);
    }
    else if (typeof event.data === "string") {
        const frame = JSON.parse(event.data);
        events = (frame.c || []).map(parseContact);
    }
    else {
        return;
    }
    // Update contact state from events
    const updatedIds = new Set();
    for (const c of events) {
        if (c.phase === BoardContactPhase.Ended ||
            c.phase === BoardContactPhase.Canceled) {
            contactState.delete(c.contactId);
        }
        else {
            contactState.set(c.contactId, c);
            updatedIds.add(c.contactId);
        }
    }
    // Contacts not in this frame become Stationary
    for (const [id, contact] of contactState) {
        if (!updatedIds.has(id)) {
            contact.phase = BoardContactPhase.Stationary;
        }
    }
    const current = Array.from(contactState.values());
    for (const cb of frameCallbacks) {
        cb(current);
    }
}
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
export const input = {
    /**
     * Subscribe to the touch push channel. The callback fires on every
     * inference frame (~60fps) with the current set of active contacts.
     *
     * Contacts persist across frames -- a piece sitting still will appear
     * with phase=Stationary until it is removed (phase=Ended).
     */
    subscribe(callback) {
        frameCallbacks.push(callback);
        // Auto-subscribe to the native push channel on first listener
        if (!subscribed && window.boardTouch) {
            window.boardTouch.onmessage = handlePushFrame;
            window.boardTouch.postMessage("subscribe");
            subscribed = true;
        }
    },
    /** Remove a previously registered callback. */
    unsubscribe(callback) {
        frameCallbacks = frameCallbacks.filter((cb) => cb !== callback);
        if (frameCallbacks.length === 0 && subscribed && window.boardTouch) {
            window.boardTouch.postMessage("unsubscribe");
            subscribed = false;
        }
    },
    /**
     * Get the current set of active contacts (snapshot).
     * This reads from the internal state maintained by the push channel.
     * If the push channel is not subscribed, returns an empty array.
     */
    getContacts() {
        return Array.from(contactState.values());
    },
    /**
     * Get contacts filtered by type.
     */
    getContactsByType(type) {
        return Array.from(contactState.values()).filter((c) => c.type === type);
    },
    /** Whether the push channel is active. */
    get isSubscribed() {
        return subscribed;
    },
};
//# sourceMappingURL=input.js.map