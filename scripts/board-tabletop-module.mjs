/**
 * Board Tabletop — Foundry module entry (v14+)
 *
 * - Non-GM clients: hide core UI, stop the PIXI ticker, mount #game, load the Phaser bundle.
 * - GM clients: keep normal Foundry UI; emit throttled pointer position in scene space over the module socket.
 * - All clients: expose window.__BOARD_PHASER_FOUNDRY for the Phaser build (scene image URL + GM cursor).
 *
 * Scene background: we re-read the active scene image on every canvas scene transition and a few delayed
 * ticks so the Board gets the new image after Foundry finishes loading textures.
 */
const MODULE_ID = "board-tabletop";
const SOCKET_EVENT = `module.${MODULE_ID}`;
const POINTER_INTERVAL_MS = 50;
const GLYPH_SOCKET_THROTTLE_MS = 100;
const FOG_SOCKET_THROTTLE_MS = 100;
const DEBUG = false;

/**
 * Build tag for this module script. `deploy.sh` runs a global replace of the
 * `b504` placeholder with the deploy build number (e.g. "b364").
 * Logged at init and included in the boot diagnostics so we can confirm the
 * device is running the expected build.
 *
 * NOTE: the guard below intentionally tests the bare substring "MODULE_BUILD"
 * (no surrounding underscores) so the deploy `sed s|b504|...|g`
 * does NOT rewrite it. Un-deployed: placeholder still contains it -> "dev".
 * Deployed: placeholder became e.g. "b364", no longer contains it -> "b364".
 */
const MODULE_BUILD_VERSION = "b504".includes("MODULE_BUILD")
  ? "dev"
  : "b504";

/** Exposed for Playtable boot probes before `collectBootSnapshot` exists. */
if (typeof globalThis !== "undefined") {
  globalThis.__boardPhaserModuleBuild = MODULE_BUILD_VERSION;
}

/** @typedef {"free"|"combat"|"disabled"} BoardMovementMode */

/** @type {BoardMovementMode} */
const DEFAULT_MOVEMENT_MODE = "combat";
const DEFAULT_MAX_MOVE_GRID_SQUARES = 12;

const glyphMoveResultListeners = new Set();

/** @type {string | null} */
let lastGlyphBindingSceneId = null;
/** contactId (Board session) -> placed token document id (scene PC, e.g. Sally / Dirk) */
const glyphContactToTokenId = new Map();
/** contactId -> last apply time (ms) */
const glyphLastSocketApply = new Map();
/** contactId -> coalesced drag payload while throttling (apply latest, never reject for speed) */
const glyphMoveQueue = new Map();

/** @type {{ slots: number[], map: Record<string, string> }} */
let cachedPieceAssignments = { slots: [1, 2, 3, 4], map: {} };

const state = {
  lastSceneInfo: null,
  lastGmCursor: null,
  lastTokenSnapshot: null,
  lastTokenSnapshotSerialized: "",
  lastFogUpdate: null,
  /** Last explored mask we shipped — sent again only when canvas.fog._updated fires. */
  lastFogExploredBase64: null,
  /** Foundry's server-wide pause state; drives the Board pause overlay + move freeze. */
  lastPaused: false,
  mapListeners: new Set(),
  sceneTransitionListeners: new Set(),
  cursorListeners: new Set(),
  tokenListeners: new Set(),
  fogListeners: new Set(),
  pieceAssignmentListeners: new Set(),
  gmPointerCleanup: null,
  bridgeWatchdogId: null,
  phaserMounted: false,
};

let fogEmitThrottleTimer = null;
let fogEmitLastSent = 0;
let fogEmitInFlight = false;

let refreshDebounceTimer = null;
let tokenDebounceTimer = null;
let tokensLastEmit = 0;
let sceneTransitioning = false;
let queuedSceneRefresh = false;
let queuedTokenRefresh = false;
let sceneRefreshBatchTimer = null;
let transitionReleaseTimer = null;

function debugLog(...args) {
  if (!DEBUG) return;
  console.log("[board-tabletop]", ...args);
}

const DEFAULT_PIECE_SLOTS = [1, 2, 3, 4];

/**
 * Validated shape for Board "Pieces" UI: ordered glyph ids + token doc id map.
 * @param {unknown} raw
 * @returns {{ slots: number[], map: Record<string, string> }}
 */
function normalizePieceAssignments(raw) {
  let slots =
    raw && typeof raw === "object" && Array.isArray(raw.slots)
      ? raw.slots
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [...DEFAULT_PIECE_SLOTS];
  slots = [...new Set(slots)];
  slots.sort((a, b) => a - b);
  if (slots.length === 0) slots = [...DEFAULT_PIECE_SLOTS];

  /** @type {Record<string, string>} */
  const map = {};
  if (raw && typeof raw === "object" && raw.map && typeof raw.map === "object") {
    for (const [k, v] of Object.entries(raw.map)) {
      const g = Number(k);
      if (!Number.isFinite(g) || g <= 0) continue;
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "string" && v.length > 0) map[String(g)] = v;
    }
  }

  // Durable glyph → actor id map: the binding key that survives scene / map changes (token
  // document ids in `map` are per-scene and re-derived from this by the Board client).
  /** @type {Record<string, string>} */
  const actors = {};
  if (raw && typeof raw === "object" && raw.actors && typeof raw.actors === "object") {
    for (const [k, v] of Object.entries(raw.actors)) {
      const g = Number(k);
      if (!Number.isFinite(g) || g <= 0) continue;
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "string" && v.length > 0) actors[String(g)] = v;
    }
  }

  /** @type {Record<string, string>} */
  const effects = {};
  if (raw && typeof raw === "object" && raw.effects && typeof raw.effects === "object") {
    for (const [k, v] of Object.entries(raw.effects)) {
      const g = Number(k);
      if (!Number.isFinite(g) || g <= 0) continue;
      if (typeof v === "string" && v.length > 0) effects[String(g)] = v;
    }
  }

  /** @type {Record<string, string>} */
  const tokenEffects = {};
  if (
    raw &&
    typeof raw === "object" &&
    raw.tokenEffects &&
    typeof raw.tokenEffects === "object"
  ) {
    for (const [k, v] of Object.entries(raw.tokenEffects)) {
      if (typeof k !== "string" || k.length === 0) continue;
      if (typeof v === "string" && v.length > 0) tokenEffects[k] = v;
    }
  }

  return { slots, map, actors, effects, tokenEffects };
}

function notifyPieceAssignmentListeners() {
  for (const cb of state.pieceAssignmentListeners) {
    try {
      cb();
    } catch (e) {
      console.error("[board-tabletop] piece assignment listener failed", e);
    }
  }
}

/** @param {*} actor @param {*} doc */
function tokenSubtitle(actor, doc) {
  if (actor?.system) {
    const sys = actor.system;
    const cls =
      sys?.details?.class?.name ??
      sys?.details?.class?.value ??
      sys?.class?.name ??
      sys?.class?.value;
    if (cls && String(cls).length > 0) return String(cls).toUpperCase();
  }
  const type = actor?.type;
  if (type && String(type).length > 0) return String(type).toUpperCase();
  return tokenDispositionLabel(doc).toUpperCase();
}

/** @param {*} doc */
function tokenDispositionLabel(doc) {
  if (!doc || typeof doc !== "object") return "Unknown";
  const d = doc.disposition;
  const TD = globalThis.CONST?.TOKEN_DISPOSITIONS;
  if (TD && typeof d === "number") {
    for (const [name, val] of Object.entries(TD)) {
      if (typeof val === "number" && val === d) {
        const n = String(name);
        return n.charAt(0) + n.slice(1).toLowerCase();
      }
    }
  }
  return typeof d === "number" ? String(d) : "Unknown";
}

function firstNonEmptyString(values) {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function getLevelTextureSrcFromDocs(scene, fieldName) {
  const levelEntries = scene?.levels?.contents ?? [];
  if (!Array.isArray(levelEntries) || levelEntries.length === 0) return null;
  const sorted = [...levelEntries].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  for (const level of sorted) {
    const src = level?.[fieldName]?.src;
    if (typeof src === "string" && src.length > 0) return src;
  }
  return null;
}

function getLevelTextureSrcFromSource(scene, fieldName) {
  const levelEntries = scene?._source?.levels;
  if (!Array.isArray(levelEntries) || levelEntries.length === 0) return null;
  const sorted = [...levelEntries].sort((a, b) => (a?.sort ?? 0) - (b?.sort ?? 0));
  for (const level of sorted) {
    const src = level?.[fieldName]?.src;
    if (typeof src === "string" && src.length > 0) return src;
  }
  return null;
}

function getBackgroundUrl() {
  const scene = canvas?.scene;
  if (!scene) return null;

  let tex = null;
  let resource = null;
  let source = null;
  try {
    tex = canvas.primary?.background?.texture ?? null;
    resource = tex?.baseTexture?.resource ?? null;
    source = resource?.source ?? null;
  } catch (err) {
    debugLog("background texture unavailable during transition", String(err));
  }
  const levelBgDocSrc = getLevelTextureSrcFromDocs(scene, "background");
  const levelBgSourceSrc = getLevelTextureSrcFromSource(scene, "background");
  const levelFgDocSrc = getLevelTextureSrcFromDocs(scene, "foreground");
  const levelFgSourceSrc = getLevelTextureSrcFromSource(scene, "foreground");
  const sourceBg = scene?._source?.background?.src;
  const sourceImg = scene?._source?.img;

  // Avoid deprecated Scene#background access in v14+.
  // Prefer scene source fields first; canvas texture source is fallback.
  const src = firstNonEmptyString([
    levelBgDocSrc,
    levelBgSourceSrc,
    sourceBg,
    sourceImg,
    levelFgDocSrc,
    levelFgSourceSrc,
    source?.currentSrc,
    source?.src,
    resource?.url,
  ]);
  if (!src || typeof src !== "string") return null;

  if (src.startsWith("http") || src.startsWith("blob:") || src.startsWith("data:")) {
    return resolveFoundryServerUrl(src);
  }

  const bust = foundry.utils?.getCacheBustURL?.(src);
  const candidate = typeof bust === "string" && bust.length > 0 ? bust : src;
  return resolveFoundryServerUrl(candidate);
}

/** Promote Foundry module / user paths to absolute same-origin URLs for the Board WebView. */
function resolveFoundryServerUrl(src) {
  if (!src || typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("data:")
  ) {
    return trimmed;
  }
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const origin = globalThis.location?.origin ?? "";
  return origin ? `${origin}${path}` : path;
}

/**
 * World-space rectangle where the level background is drawn (same coordinate system as token x/y).
 * Uses `sceneX` / `sceneY` / `sceneWidth` / `sceneHeight` so padding and off-map margins line up with
 * the image we load (previously we used full canvas size with origin 0, which skewed positions).
 */
function getBackgroundWorldRect() {
  const d = canvas?.dimensions;
  if (!d) return null;

  if (d.sceneWidth > 0 && d.sceneHeight > 0) {
    return {
      x: d.sceneX ?? 0,
      y: d.sceneY ?? 0,
      width: d.sceneWidth,
      height: d.sceneHeight,
    };
  }

  const r = d.sceneRect;
  if (r && r.width > 0 && r.height > 0) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  return null;
}

function readActiveSceneMap() {
  const scene = canvas?.scene;
  if (!scene) return null;

  const url = getBackgroundUrl();
  if (!url) return null;

  const w = canvas?.dimensions?.width ?? scene.width ?? canvas?.width;
  const h = canvas?.dimensions?.height ?? scene.height ?? canvas?.height;
  if (!w || !h) return null;

  const background = getBackgroundWorldRect() ?? { x: 0, y: 0, width: w, height: h };

  return {
    url,
    width: w,
    height: h,
    sceneId: scene.id,
    gridSize: canvas.grid?.size ?? 100,
    gridDistance: scene.grid?.distance ?? 5,
    gridUnits: scene.grid?.units ?? "ft",
    gridDiagonals: readGridDiagonals(),
    background,
  };
}

/**
 * Map Foundry's core `gridDiagonals` setting to the rule the Board ruler understands.
 * Best-effort: the setting/enum varies across Foundry versions, so default to "555"
 * (equidistant — core's square-grid default).
 */
function readGridDiagonals() {
  try {
    const mode = game.settings.get("core", "gridDiagonals");
    // CONST.GRID_DIAGONALS: EQUIDISTANT=0, EXACT=1, ALTERNATING_1=4 (5-10-5)
    if (mode === 1) return "euclidean";
    if (mode === 4) return "5105";
    return "555";
  } catch (e) {
    return "555";
  }
}

/** De-dupes transition notifications so repeated canvasInits for one switch fire once. */
let lastTransitionNotifiedSceneId = null;

function notifySceneTransitionStart(sceneId) {
  if (!sceneId || sceneId === lastTransitionNotifiedSceneId) return;
  // Only a *different* scene than the one the game is showing counts as a transition — a
  // canvasInit for the already-displayed scene (e.g. a background-field update) must not fire,
  // because no map load follows and the game's loading cover would have nothing to dismiss it.
  if (sceneId === state.lastSceneInfo?.sceneId) return;
  lastTransitionNotifiedSceneId = sceneId;
  for (const cb of state.sceneTransitionListeners) {
    try {
      cb(sceneId);
    } catch (e) {
      console.error("[board-tabletop] onSceneTransitionStart listener failed", e);
    }
  }
}

function notifyMapListeners(info) {
  for (const cb of state.mapListeners) {
    try {
      cb(info);
    } catch (e) {
      console.error("[board-tabletop] onActiveSceneMap listener failed", e);
    }
  }
  maybeNotifySessionReadyFromMap(info);
}

const PAUSED_DOM_ID = "board-phaser-game-paused";

/**
 * Board "Game Paused" banner. Rendered as a top-level `body` child above every game
 * surface (Phaser #game, the halo/VFX canvas, and #ui) — a React overlay inside #ui
 * can't win that z-order because #ui shares a stacking level with the halo canvas.
 * Non-blocking (`pointer-events:none`); moves are frozen separately in reportGlyphState.
 */
function showPausedDomOverlay() {
  if (typeof document === "undefined") return;
  // Only the Board surface hides Foundry's own #pause banner; a plain GM/player browser
  // keeps Foundry's banner, so don't inject ours there.
  if (!isBoardDevice()) return;
  if (document.getElementById(PAUSED_DOM_ID)) return;
  const el = document.createElement("div");
  el.id = PAUSED_DOM_ID;
  el.setAttribute("data-board-phaser", "");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  // Same chrome as the native modals (FoundryModalDialog / the session-loading card):
  // black-45% backdrop, #E8E6D9 card, radius 36, soft shadow, "Kabel ITC BQ" title.
  ensureSessionLoadingSpinnerStyle(); // idempotent — loads the Kabel ITC BQ @font-face
  el.style.cssText = `
    position:fixed;inset:0;z-index:2000000006;pointer-events:none;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.45);
  `;
  el.innerHTML = `
    <div style="
      padding:44px 96px;border-radius:36px;background:#e8e6d9;
      box-shadow:0 12px 32px rgba(0,0,0,0.18);text-align:center;
    ">
      <p style="
        margin:0;font-family:'Kabel ITC BQ',system-ui,sans-serif;
        font-size:40px;font-weight:500;line-height:1.1;color:#000;
      ">Game Paused</p>
    </div>
  `;
  document.body.appendChild(el);
}

function hidePausedDomOverlay() {
  if (typeof document === "undefined") return;
  document.getElementById(PAUSED_DOM_ID)?.remove();
}

function applyPausedState() {
  if (state.lastPaused) showPausedDomOverlay();
  else hidePausedDomOverlay();
}

/** Unblock the native overlay once the scene map is known and Phaser is up. */
function maybeNotifySessionReadyFromMap(info) {
  if (!info?.url) return;
  if (globalThis.__boardPhaserSessionReady === true) return;
  const canvases = document.getElementById("game")?.querySelectorAll("canvas")?.length ?? 0;
  const game = globalThis.__boardPhaserGame;
  if (!game && canvases <= 0) return;
  console.info("[board-tabletop] scene map ready + Phaser running — signaling session ready");
  notifyPlaytableSessionReady();
}

/**
 * After the Phaser bundle script loads, ensure the game canvas appears and the
 * native Playtable overlay is dismissed. Retries boot if the bundle executed but
 * no canvas was created (common when WebGL is exhausted by Foundry's canvas).
 */
function ensurePhaserGameRunning() {
  if (globalThis.__boardPhaserGameWatchdog) return;
  globalThis.__boardPhaserGameWatchdog = true;
  let polls = 0;
  const timer = globalThis.setInterval(() => {
    const canvases = document.getElementById("game")?.querySelectorAll("canvas")?.length ?? 0;
    const game = globalThis.__boardPhaserGame;
    if (game || canvases > 0) {
      globalThis.clearInterval(timer);
      setBootStage("phaser_game_running");
      notifyPlaytableSessionReady();
      return;
    }
    polls++;
    if (polls === 4) {
      try {
        globalThis.__playtableKickPhaserBoot?.();
      } catch (e) {
        console.warn("[board-tabletop] kick Phaser boot failed", e);
      }
    }
    if (state.lastSceneInfo?.url && polls >= 6) {
      maybeNotifySessionReadyFromMap(state.lastSceneInfo);
    }
    if (polls >= 60) {
      globalThis.clearInterval(timer);
      console.error("[board-tabletop] Phaser never created a canvas after bundle load");
      void retryPhaserGameBundle("post_bundle_canvas_timeout");
    }
  }, 500);
}

/** Relative to `/modules/board-tabletop/game/` — deploy.sh rewrites the hash. */
const PHASER_GAME_BUNDLE = "assets/index-BKkDyjfC.js";
const PHASER_GAME_STYLES = "assets/index-Df8zXMah.css";
const PHASER_GAME_STYLES_LINK_ID = "board-phaser-game-styles";

let cssInjectPromise = null;

function injectFetchedGameCss(cssText, href) {
  let el = document.getElementById(PHASER_GAME_STYLES_LINK_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = PHASER_GAME_STYLES_LINK_ID;
    document.head.appendChild(el);
  }
  el.textContent = cssText;
  globalThis.__boardPhaserCssLoaded = true;
  globalThis.__boardPhaserCssError = null;
  console.info(
    "[board-tabletop] game CSS injected",
    href,
    "(" + cssText.length + " bytes)",
  );
}

function injectCriticalSurfaceStyles() {
  const id = "board-phaser-critical-surface-css";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #game { position: fixed !important; inset: 0 !important; overflow: hidden !important;
      z-index: 2000000000 !important; background: #000 !important; }
    #game canvas { display: block !important; touch-action: none !important; }
    /* The halo/VFX canvas (a body child) sits at z 2000000001 — above #game, below
       #ui — so idle halos and piece VFX render over the map but under the HUD. */
    #ui { position: fixed !important; inset: 0 !important; pointer-events: none !important;
      z-index: 2000000002 !important; }
  `;
  document.head.appendChild(style);
}

async function fetchAndInjectGameCss(reason) {
  const cssPath = PHASER_GAME_STYLES;
  if (cssPath.includes("__FOUNDRY_BUILD_CSS__")) return;
  const href = `/modules/${MODULE_ID}/game/${cssPath}?v=${MODULE_BUILD_VERSION}`;
  console.info("[board-tabletop] fetching game CSS (" + reason + ")", href);
  const response = await fetch(href, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${href}`);
  const cssText = await response.text();
  if (!cssText.trim()) throw new Error(`empty CSS body for ${href}`);
  injectFetchedGameCss(cssText, href);
}

function ensurePhaserGameStylesheet(reason = "mount") {
  injectCriticalSurfaceStyles();
  if (globalThis.__boardPhaserCssLoaded === true) return;
  if (cssInjectPromise) return;

  cssInjectPromise = fetchAndInjectGameCss(reason).catch((err) => {
    cssInjectPromise = null;
    globalThis.__boardPhaserCssError = String(err);
    console.error("[board-tabletop] game CSS fetch failed (" + reason + ")", err);
  });
}

function retryPhaserGameStylesheet(reason) {
  if (globalThis.__boardPhaserCssLoaded === true) return;
  cssInjectPromise = null;
  ensurePhaserGameStylesheet(reason);
}

let phaserBundleLoadPromise = null;

function phaserBundleImportUrl() {
  return `/modules/${MODULE_ID}/game/${PHASER_GAME_BUNDLE}?v=${MODULE_BUILD_VERSION}`;
}

function isPhaserActuallyRunning() {
  const canvases = document.getElementById("game")?.querySelectorAll("canvas")?.length ?? 0;
  return canvases > 0 || !!globalThis.__boardPhaserGame;
}

let phaserBundleLastAttemptAt = 0;

async function loadPhaserGameBundle(reason = "mount") {
  if (phaserBundleLoadPromise) return phaserBundleLoadPromise;

  const url = phaserBundleImportUrl();
  phaserBundleLastAttemptAt = Date.now();
  setBootStage("phaser_bundle_loading");
  console.info("[board-tabletop] importing Phaser bundle (" + reason + ")", url);

  phaserBundleLoadPromise = (async () => {
    try {
      await import(/* @vite-ignore */ url);
      globalThis.__boardPhaserBundleError = null;
      globalThis.__boardPhaserBundleLoaded = true;
      setBootStage("phaser_bundle_loaded");
      ensurePhaserGameRunning();
      ensurePhaserGameStylesheet("bundle_loaded");
    } catch (err) {
      phaserBundleLoadPromise = null;
      state.phaserMounted = false;
      globalThis.__boardPhaserBundleError = String(err);
      setBootStage("phaser_bundle_error");
      console.error("[board-tabletop] Phaser bundle import failed:", err);
      restoreFoundryUiAfterPhaserFailure();
      throw err;
    }
  })();

  return phaserBundleLoadPromise;
}

/** Minimum wait before abandoning an in-flight import and re-issuing a fresh one. */
const PHASER_BUNDLE_RETRY_MIN_MS = 8000;

function retryPhaserGameBundle(reason) {
  if (isPhaserActuallyRunning()) return;

  // If the bundle already executed, re-importing is pointless — the module is
  // cached and its boot guard would no-op a re-evaluation. The game is booting
  // inside the loaded bundle; just (re)kick it and let ensurePhaserGameRunning
  // poll for the canvas.
  if (globalThis.__boardPhaserBundleExecuted === true) {
    try {
      globalThis.__playtableKickPhaserBoot?.();
    } catch (e) {
      console.warn("[board-tabletop] kick boot (post-exec retry) failed", e);
    }
    ensurePhaserGameRunning();
    return;
  }

  // If an import is in flight and hasn't had time to complete yet, let it run —
  // only abandon it (reset the promise) once it looks genuinely stalled. This
  // avoids thrashing the module loader while a legitimate ~2.5s load proceeds.
  if (
    phaserBundleLoadPromise &&
    Date.now() - phaserBundleLastAttemptAt < PHASER_BUNDLE_RETRY_MIN_MS
  ) {
    return phaserBundleLoadPromise;
  }
  phaserBundleLoadPromise = null;
  globalThis.__boardPhaserGameWatchdog = false;
  return loadPhaserGameBundle(reason).catch(() => {});
}

function notifyCursorListeners(cursor) {
  for (const cb of state.cursorListeners) {
    try {
      cb(cursor);
    } catch (e) {
      console.error("[board-tabletop] onGmCursor listener failed", e);
    }
  }
}

function resolveTokenImageUrl(doc) {
  const src = doc.texture?.src ?? doc.actor?.img;
  if (!src || typeof src !== "string") return null;
  if (src.startsWith("http") || src.startsWith("data:") || src.startsWith("blob:")) return src;
  const bust = foundry.utils?.getCacheBustURL?.(src);
  return typeof bust === "string" ? bust : src;
}

function placeablesToArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw[Symbol.iterator] === "function") return Array.from(raw);
  if (raw.contents) return Array.from(raw.contents);
  if (raw.values) return Array.from(raw.values());
  if (raw.children) return Array.from(raw.children.values ? raw.children.values() : raw.children);
  return [];
}

/**
 * Resolve a token's world Actor. `linked` mirrors Foundry's "Link Actor Data"
 * checkbox (`doc.actorLink`). Bind Pieces eligibility uses Owner ownership on the
 * world Actor (see {@link enrichTokenSnapshotForViewer}), not `linked` alone —
 * an unlinked token still references a world Actor via `doc.actorId`.
 * @param {*} doc
 */
function resolveTokenLinkedActor(doc) {
  const actorId = doc?.actorId ? String(doc.actorId) : "";
  const worldActor = actorId ? (game.actors?.get?.(actorId) ?? null) : null;
  // Prefer the world Actor; unlinked tokens also expose a synthetic `doc.actor`.
  const actor = worldActor ?? (actorId ? (doc.actor ?? null) : null);
  const linked = !!doc?.actorLink && !!actorId && !!worldActor;
  return { actorId, actor, worldActor, linked };
}

/** @returns {number} */
function ownershipOwnerLevel() {
  return (
    CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ??
    CONST.DOCUMENT_PERMISSION_LEVELS?.OWNER ??
    3
  );
}

/** @param {*} user @param {*} actor */
function userOwnsActor(user, actor) {
  if (!user || !actor) return false;
  try {
    return !!actor.testUserPermission(user, ownershipOwnerLevel());
  } catch {
    return false;
  }
}

/**
 * Annotate each token with whether the *local* Foundry user has OWNER on its
 * world Actor. Bind Pieces (on the Board client) uses this instead of Link Actor Data.
 * @param {ReturnType<typeof readTokensFromCanvas> | null} data
 */
function enrichTokenSnapshotForViewer(data) {
  if (!data?.tokens) return data;
  const user = game.user;
  const tokens = data.tokens.map((t) => {
    const actorId = t.actorId ? String(t.actorId) : "";
    const actor = actorId ? (game.actors?.get?.(actorId) ?? null) : null;
    return {
      ...t,
      actorOwnedByMe: userOwnsActor(user, actor),
    };
  });
  return { ...data, tokens };
}

/** @param {*} actor */
function readActorHpLabel(actor) {
  if (!actor?.system) return null;
  const sys = actor.system;
  const hp = sys.attributes?.hp ?? sys.resources?.hp ?? sys.hp;
  if (!hp || typeof hp !== "object") return null;
  // Foundry often leaves value as `null` when HP isn't used; `Number(null)` is 0.
  const raw = hp.value ?? hp.current;
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const max = Number(hp.max);
  if (Number.isFinite(max) && max > 0) {
    return `${Math.round(value)}/${Math.round(max)}`;
  }
  // Bare `0` with no max is almost always an unused HP track — omit it.
  if (value === 0) return null;
  return String(Math.round(value));
}

/** @param {*} actor @param {*} doc @param {boolean} useActorName */
function representedActorDisplayName(actor, doc, useActorName) {
  if (useActorName && actor?.name) {
    const fromActor = String(actor.name).trim();
    if (fromActor) return fromActor;
  }
  return String(doc?.name ?? actor?.name ?? "").trim();
}

function readTokensFromCanvas() {
  if (!canvas?.ready || !canvas.scene || !canvas.tokens) return null;
  const scene = canvas.scene;
  const placeables = placeablesToArray(canvas.tokens?.placeables ?? canvas.tokens);

  const sceneId = scene.id;
  const gs = canvas.grid?.size ?? 100;
  const list = [];

  for (const token of placeables) {
    try {
      const doc = token?.document;
      if (!doc) continue;
      const { actorId, actor, worldActor, linked: actorLinked } =
        resolveTokenLinkedActor(doc);
      const isCharacter = actor?.type === "character";
      if (!isCharacter && doc.hidden) continue;
      const img = resolveTokenImageUrl(doc);
      if (!img) continue;
      const wPx = (doc.width ?? 1) * gs;
      const hPx = (doc.height ?? 1) * gs;
      // Always export world actorId when present so Bind can key Ownership → Board
      // Owner without requiring Link Actor Data.
      const exportActorId = worldActor ? actorId : "";
      // This runs ONLY on the GM (refreshTokensBridge is GM-gated), where the PIXI ticker is
      // GM-gated export: `doc.x/y` is the committed token position (updates snap instantly on
      // piece drag / lift-and-place — no Foundry token.animate tween).
      list.push({
        id: String(doc.id),
        x: doc.x,
        y: doc.y,
        w: wPx,
        h: hPx,
        rotation: doc.rotation ?? 0,
        img,
        name: representedActorDisplayName(actor, doc, !!exportActorId),
        actorId: exportActorId,
        actorLinked,
        actorType: actor?.type ?? "",
        subtitle: tokenSubtitle(actor, doc),
        disposition: tokenDispositionLabel(doc),
        mirror: !!(doc.texture?.mirrorX),
        elevation: Number(doc.elevation) || 0,
        hp: worldActor ? readActorHpLabel(worldActor) : null,
      });
    } catch (err) {
      debugLog("token export failed", err);
    }
  }

  list.sort(
    (a, b) =>
      a.elevation - b.elevation ||
      String(a.id).localeCompare(String(b.id)),
  );
  return { sceneId, tokens: list };
}

function notifyTokenListeners(data) {
  for (const cb of state.tokenListeners) {
    try {
      cb(data);
    } catch (e) {
      console.error("[board-tabletop] onTokensChange failed", e);
    }
  }
}

/**
 * Apply a token snapshot to the bridge (and notify Phaser listeners).
 * Ownership is annotated for the local user so Bind Pieces can filter by Owner.
 * @param {ReturnType<typeof readTokensFromCanvas>} data
 */
function applyTokenSnapshot(data) {
  if (!data) return;
  const enriched = enrichTokenSnapshotForViewer(data);
  const ser = JSON.stringify(enriched);
  const unchanged = ser === state.lastTokenSnapshotSerialized;
  if (unchanged) return;
  state.lastTokenSnapshotSerialized = ser;
  state.lastTokenSnapshot = enriched;
  debugLog("applyTokenSnapshot", {
    count: enriched.tokens?.length ?? 0,
    sceneId: enriched.sceneId,
  });
  notifyTokenListeners(enriched);
}

/** GM reads the scene and pushes a full token list to Board clients. */
function refreshTokensBridge() {
  if (shouldMountPhaser()) return;
  if (!game.user?.isGM) return;

  let data = null;
  try {
    data = readTokensFromCanvas();
  } catch (e) {
    debugLog("refreshTokensBridge", e);
    return;
  }
  applyTokenSnapshot(data);
  if (game?.socket) {
    game.socket.emit(SOCKET_EVENT, {
      type: "tokensUpdate",
      value: data,
    });
  }
}

/**
 * Emit a token snapshot to the Board, THROTTLED (leading + trailing) — NOT a pure trailing
 * debounce. During a token's move animation `refreshToken` fires every frame; a trailing debounce
 * keeps resetting and only emits once the animation ENDS, which is why the Board used to jump to
 * the final position after the GM finished. A throttle emits every ~TOKENS_STREAM_MS during the
 * animation, so the Board receives the live position stream and can mirror the movement.
 */
const TOKENS_STREAM_MS = 50;
function scheduleTokensRefresh() {
  if (shouldMountPhaser()) return;
  if (sceneTransitioning) {
    queuedTokenRefresh = true;
    return;
  }
  const now = Date.now();
  const since = now - tokensLastEmit;
  if (since >= TOKENS_STREAM_MS) {
    if (tokenDebounceTimer) {
      clearTimeout(tokenDebounceTimer);
      tokenDebounceTimer = null;
    }
    tokensLastEmit = now;
    refreshTokensBridge();
    return;
  }
  if (tokenDebounceTimer) return;
  tokenDebounceTimer = setTimeout(() => {
    tokenDebounceTimer = null;
    if (sceneTransitioning) {
      queuedTokenRefresh = true;
      return;
    }
    tokensLastEmit = Date.now();
    refreshTokensBridge();
  }, TOKENS_STREAM_MS - since);
}

function notifyFogListeners(data) {
  for (const cb of state.fogListeners) {
    try {
      cb(data);
    } catch (e) {
      console.error("[board-tabletop] onFogUpdate listener failed", e);
    }
  }
}

/**
 * Collect active token vision polygons from the GM canvas in Foundry world space.
 * Each token's `vision.shape` is a PointSourcePolygon that already incorporates wall blocking
 * + sight range; `.points` is a flat `[x, y, x, y, ...]` array.
 */
function readActiveVisionPolygons() {
  if (!canvas?.ready || !canvas.tokens?.placeables) return [];
  const out = [];
  const skipped = [];
  for (const token of canvas.tokens.placeables) {
    const doc = token?.document;
    if (!doc) continue;
    if (doc.hidden) {
      skipped.push({ id: doc.id, reason: "hidden" });
      continue;
    }
    const vision = token.vision;
    if (!vision) {
      skipped.push({ id: doc.id, reason: "no-vision-source" });
      continue;
    }
    if (!vision.active) {
      skipped.push({ id: doc.id, reason: "vision-inactive" });
      continue;
    }
    const shape = vision.shape;
    const raw = shape?.points;
    if (!raw || raw.length < 6) {
      skipped.push({ id: doc.id, reason: "no-polygon", len: raw?.length ?? 0 });
      continue;
    }
    const polygon = Array.from(raw);
    out.push({ tokenId: String(doc.id), polygon });
  }
  debugLog("[board-tabletop fog] readActiveVisionPolygons", {
    total: canvas.tokens.placeables.length,
    included: out.length,
    skipped,
  });
  return out;
}

/** Cache for player-fog union: keyed by per-doc {id, content length} signature. */
let playerFogUnionCache = { signature: "", base64: null };
/** Cap on the union canvas dimension — `toDataURL` cost on the GM thread scales with pixel count. */
const PLAYER_FOG_UNION_MAX_DIM = 1024;
let playerFogUnionInFlight = false;

/**
 * Load a base64 dataURL into an HTMLImageElement. Resolves to `null` on error.
 * @param {string} b64
 * @returns {Promise<HTMLImageElement | null>}
 */
function loadImageFromBase64(b64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = b64.startsWith("data:") ? b64 : `data:image/webp;base64,${b64}`;
  });
}

/**
 * Compute the union of all NON-GM FogExploration documents for the active scene and return
 * it as a base64 dataURL. This is the "player point of view" — what at least one player has
 * seen. Cached by content signature so we only re-encode when something actually changed.
 *
 * Returns `null` when no player has any fog yet (Board client will render full-black void).
 */
async function getPlayerFogUnionBase64() {
  if (!canvas?.scene) return null;
  // If a previous union is still encoding (rare — toDataURL is sync but loads are async),
  // skip rather than queue. Caller will get the cached value or null.
  if (playerFogUnionInFlight) {
    return playerFogUnionCache.base64;
  }
  const sceneId = canvas.scene.id;
  const d = canvas.dimensions;
  if (!d?.width || !d?.height) return null;

  // Foundry stores FogExploration documents in a world-level collection. Try both common access
  // paths to be defensive across minor version differences.
  const collection =
    game.collections?.get?.("FogExploration") ??
    globalThis.game?.fogexplorations ??
    null;
  const all = collection?.contents ?? collection ?? [];

  const playerFogs = [];
  for (const f of all) {
    // Scene filter — handle `f.scene` being a Doc, an ID string, or having `.id`.
    const fogSceneId =
      typeof f?.scene === "string"
        ? f.scene
        : f?.scene?.id ?? f?.scene?._id ?? null;
    if (fogSceneId && fogSceneId !== sceneId) continue;
    // User filter — non-GM only.
    const userRef = f?.user;
    const userId = typeof userRef === "string" ? userRef : userRef?.id ?? userRef?._id;
    const userDoc = userId ? game.users?.get?.(userId) : null;
    if (!userDoc || userDoc.isGM) continue;
    if (typeof f.explored !== "string" || f.explored.length === 0) continue;
    playerFogs.push(f);
  }

  if (playerFogs.length === 0) return null;

  // Signature: changes whenever any included fog's content does.
  const signature = playerFogs
    .map((f) => `${f.id}:${f.explored.length}`)
    .sort()
    .join("|");
  if (signature === playerFogUnionCache.signature && playerFogUnionCache.base64) {
    return playerFogUnionCache.base64;
  }

  playerFogUnionInFlight = true;
  try {
    // Decode each player's fog to an HTMLImage in parallel.
    const images = await Promise.all(
      playerFogs.map((f) => loadImageFromBase64(f.explored)),
    );

    // Encode the union at a capped resolution to keep the synchronous `toDataURL` fast — full
    // canvas dimensions (often ~3000x3700) take several hundred ms and freeze the GM during
    // a drag (which fires `sightRefresh` continuously). The Board's renderer rescales to fit
    // the worldRect, so the lower-res mask is fine visually.
    const fullW = d.width;
    const fullH = d.height;
    // The fog texture covers only sceneRect (e.g. 6000×4200 @ 1600,1200 inside a 9200×6600
    // canvas), so paint each player's fog at that offset onto a full-canvas frame — matching the
    // [0..canvasWidth] space the Board's worldRect mapping expects.
    const rect = d.sceneRect ?? { x: 0, y: 0, width: fullW, height: fullH };
    const scale = Math.min(1, PLAYER_FOG_UNION_MAX_DIM / Math.max(fullW, fullH));
    const w = Math.max(1, Math.floor(fullW * scale));
    const h = Math.max(1, Math.floor(fullH * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d");
    if (!cx) return null;
    // Fog is a RED-channel mask (explored = red, alpha always 255); `lighten` keeps the per-pixel
    // max so overlapping player fogs union correctly. The Board re-encodes red→alpha on receipt.
    cx.globalCompositeOperation = "lighten";
    for (const img of images) {
      if (img) {
        cx.drawImage(img, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
      }
    }
    cx.globalCompositeOperation = "source-over";
    const result = c.toDataURL("image/webp", 0.85);
    playerFogUnionCache = { signature, base64: result };
    debugLog("[board-tabletop fog] player-fog union", {
      nonGmUsersWithFog: playerFogs.length,
      logicalCanvas: `${fullW}x${fullH}`,
      encodeSize: `${w}x${h}`,
      base64Bytes: result.length,
    });
    return result;
  } finally {
    playerFogUnionInFlight = false;
  }
}

/**
 * Resolve a base64 dataURL for the persistent explored fog mask, or null when unavailable.
 * Uses the **player-POV union** (non-GM FogExploration docs).
 *
 * NOTE: the Board now computes its own fog of war locally by accumulating the live vision
 * polygons it receives (see `FogOfWar.ts`), so it ignores `exploredBase64`. We keep emitting the
 * player union when it exists (cheap, cached by signature) for any other consumer, but the GM no
 * longer extracts its own fog texture for the Board — that readback was expensive and unused.
 */
async function extractFogExploredBase64({ force }) {
  try {
    const playerUnion = await getPlayerFogUnionBase64();
    if (playerUnion) {
      if (!force && playerUnion === state.lastFogExploredBase64) return null;
      return playerUnion;
    }
    return null;
  } catch (e) {
    console.error("[board-tabletop fog] extractFogExploredBase64 failed", e);
    return null;
  }
}

async function emitFogUpdateNow() {
  if (!game?.user?.isGM) {
    debugLog("[board-tabletop fog] emit skipped: not GM");
    return;
  }
  if (!canvas?.ready || !canvas.scene) {
    debugLog("[board-tabletop fog] emit skipped: canvas not ready", {
      ready: !!canvas?.ready,
      scene: !!canvas?.scene,
    });
    return;
  }
  if (fogEmitInFlight) {
    debugLog("[board-tabletop fog] emit skipped: already in flight");
    return;
  }
  fogEmitInFlight = true;
  try {
    const sceneId = canvas.scene.id;
    const visions = readActiveVisionPolygons();
    const d = canvas.dimensions;
    const canvasWidth = d?.width ?? 0;
    const canvasHeight = d?.height ?? 0;
    const explored = await extractFogExploredBase64({ force: false });
    if (explored) state.lastFogExploredBase64 = explored;
    const payload = {
      sceneId,
      visions,
      exploredBase64: explored,
      canvasWidth,
      canvasHeight,
    };
    state.lastFogUpdate = payload;
    fogEmitLastSent = Date.now();
    const userCount = game.users?.contents?.filter?.((u) => u.active && !u.isGM)?.length ?? "?";
    debugLog("[board-tabletop fog] emit", {
      sceneId,
      visions: visions.length,
      exploredBytes: explored?.length ?? 0,
      exploredSentNow: !!explored,
      canvasWidth,
      canvasHeight,
      activeNonGmUsers: userCount,
      hasSocket: !!game.socket,
    });
    if (game.socket) {
      game.socket.emit(SOCKET_EVENT, { type: "fogUpdate", ...payload });
    }
  } catch (e) {
    console.error("[board-tabletop fog] emit failed", e);
  } finally {
    fogEmitInFlight = false;
  }
}

function scheduleFogEmit() {
  if (!game?.user?.isGM) return;
  const now = Date.now();
  const sinceLast = now - fogEmitLastSent;
  if (sinceLast >= FOG_SOCKET_THROTTLE_MS) {
    if (fogEmitThrottleTimer) {
      clearTimeout(fogEmitThrottleTimer);
      fogEmitThrottleTimer = null;
    }
    debugLog("[board-tabletop fog] scheduleFogEmit -> emit now", { sinceLast });
    void emitFogUpdateNow();
    return;
  }
  if (fogEmitThrottleTimer) return;
  debugLog("[board-tabletop fog] scheduleFogEmit -> throttled", {
    sinceLast,
    waitMs: FOG_SOCKET_THROTTLE_MS - sinceLast,
  });
  fogEmitThrottleTimer = setTimeout(() => {
    fogEmitThrottleTimer = null;
    void emitFogUpdateNow();
  }, FOG_SOCKET_THROTTLE_MS - sinceLast);
}

/* ============================================================================
 * Board-local visibility is computed inside the Phaser game (src/entities/VisionComputer.ts),
 * NOT here. While the Phaser shell is up, Foundry's canvas ticker is stopped (see
 * mountPhaserShell), so the module can't rely on live vision/perception. The Phaser game reads
 * walls/lights/tokens directly and drives Foundry's ClockwiseSweep engine in its own loop. The
 * module therefore no longer computes or emits any fog mask.
 * ========================================================================== */

function refreshSceneBridge() {
  // Board clients: don't hand the game a new map while Foundry is still drawing the scene. The
  // canvasInit-time notify made Phaser's native-res decode run concurrently with PIXI's — for a
  // large map that is two >200MB decode transients at the same instant, which is what kept
  // OOM-killing the renderer even after the cache itself was bounded. Holding the notify until
  // canvasReady serializes the two decodes (canvasReady also unloads Foundry's copy first), so
  // the peak is max(the two) instead of their sum. The watchdog re-runs this until it passes;
  // the empty-world path (no scene at all) is deliberately not gated.
  if (isBoardDevice() && canvas?.scene && !canvas.ready) return;
  const info = readActiveSceneMap();
  if (!info) {
    debugLog("Scene bridge refresh: map info unavailable", {
      sceneId: canvas?.scene?.id ?? null,
      hasBackgroundSource: !!canvas?.primary?.backgroundSource,
      bgSourceSrc: canvas?.primary?.backgroundSource?.currentSrc || canvas?.primary?.backgroundSource?.src || null,
      textureUrl: canvas?.primary?.background?.texture?.baseTexture?.resource?.url ?? null,
      textureSourceSrc:
        canvas?.primary?.background?.texture?.baseTexture?.resource?.source?.currentSrc ||
        canvas?.primary?.background?.texture?.baseTexture?.resource?.source?.src ||
        null,
      levelBackgroundSrc:
        getLevelTextureSrcFromDocs(canvas?.scene, "background") ||
        getLevelTextureSrcFromSource(canvas?.scene, "background"),
      sourceBackgroundSrc: canvas?.scene?._source?.background?.src ?? null,
    });
    if (state.lastSceneInfo != null) {
      state.lastSceneInfo = null;
      notifyMapListeners(null);
    }
    return;
  }

  const changed =
    !state.lastSceneInfo ||
    state.lastSceneInfo.sceneId !== info.sceneId ||
    state.lastSceneInfo.url !== info.url;

  state.lastSceneInfo = info;
  if (changed) {
    debugLog("Scene bridge changed", info);
    state.lastGmCursor = null;
    notifyCursorListeners(null);
    notifyMapListeners(info);
  }
}

/**
 * Re-sync after scene changes: first read can run before the background texture is ready.
 */
function scheduleSceneBridgeRefresh() {
  if (sceneRefreshBatchTimer) return;

  refreshSceneBridge();
  sceneRefreshBatchTimer = setTimeout(() => {
    sceneRefreshBatchTimer = null;
    refreshSceneBridge();
  }, 200);
}

/**
 * Board clients run with Foundry canvas hidden/ticker stopped, and some scene-change hooks
 * can be inconsistent in that mode. A lightweight watchdog ensures we still pick up scene switches.
 */
function ensureSceneBridgeWatchdog() {
  if (state.bridgeWatchdogId !== null) return;
  state.bridgeWatchdogId = window.setInterval(() => {
    if (sceneTransitioning) return;
    scheduleSceneBridgeRefresh();
    scheduleTokensRefresh();
  }, 1500);
  debugLog("Scene bridge watchdog started");
}

function flushQueuedBridgeWork() {
  if (queuedSceneRefresh) {
    queuedSceneRefresh = false;
    scheduleSceneBridgeRefresh();
  }
  if (queuedTokenRefresh) {
    queuedTokenRefresh = false;
    scheduleTokensRefresh();
  }
}

function queueTransitionRelease(delayMs) {
  if (transitionReleaseTimer) clearTimeout(transitionReleaseTimer);
  transitionReleaseTimer = setTimeout(() => {
    transitionReleaseTimer = null;
    sceneTransitioning = false;
    flushQueuedBridgeWork();
  }, delayMs);
}

function debouncedActiveSceneUpdate() {
  const scene = canvas?.scene;
  if (!scene) return;
  clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    scheduleSceneBridgeRefresh();
  }, 40);
}

function installGmPointerTracking() {
  state.gmPointerCleanup?.();
  state.gmPointerCleanup = null;

  if (!game.user?.isGM) return;

  const view = canvas?.app?.view;
  if (!view || !(view instanceof HTMLCanvasElement)) return;

  let lastSend = 0;

  const onMove = (ev) => {
    const now = performance.now();
    if (now - lastSend < POINTER_INTERVAL_MS) return;
    lastSend = now;

    const sceneId = canvas.scene?.id;
    if (!sceneId || !canvas.stage?.worldTransform) return;

    const rect = view.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;

    const inv = canvas.stage.worldTransform.clone().invert();
    const pt = inv.apply(new PIXI.Point(sx, sy));

    game.socket.emit(SOCKET_EVENT, {
      type: "gmPointer",
      sceneId,
      x: pt.x,
      y: pt.y,
      userId: game.userId,
    });
  };

  view.addEventListener("pointermove", onMove, { passive: true });

  state.gmPointerCleanup = () => {
    view.removeEventListener("pointermove", onMove);
  };
}

/**
 * Placed "character" (PC) tokens on the current scene that at least one non-GM
 * user Owns — used for zero-config glyph→token auto-assign. Ownership (not
 * Link Actor Data) matches Bind Pieces eligibility.
 */
function getBindablePcTokenIds() {
  if (!canvas?.ready || !canvas.tokens?.placeables) return [];
  const players = (game.users?.contents ?? game.users ?? []).filter?.(
    (u) => u && !u.isGM,
  ) ?? [];
  const rows = [];
  for (const t of canvas.tokens.placeables) {
    const doc = t?.document;
    if (!doc || doc.hidden) continue;
    const { actorId, worldActor } = resolveTokenLinkedActor(doc);
    if (!worldActor || worldActor.type !== "character") continue;
    const ownedByPlayer = players.some((u) => userOwnsActor(u, worldActor));
    if (!ownedByPlayer) continue;
    const name = (doc.name || worldActor.name || "").trim();
    rows.push({ id: doc.id, name: name || doc.id });
  }
  rows.sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }),
  );
  return rows.map((r) => r.id);
}

function phaserMapToFoundryWorld(wx, wy, phaserW, phaserH) {
  const info = readActiveSceneMap();
  const bg = info?.background ?? (info && info.width > 0 && info.height > 0
    ? { x: 0, y: 0, width: info.width, height: info.height }
    : null);
  if (!bg || !phaserW || !phaserH) {
    return { x: wx, y: wy };
  }
  return {
    x: (wx / phaserW) * bg.width + bg.x,
    y: (wy / phaserH) * bg.height + bg.y,
  };
}

/** @param {string} tokenDocId */
function findCanvasTokenById(tokenDocId) {
  if (!canvas?.ready || !canvas.tokens?.placeables || !tokenDocId) return null;
  const col = canvas.tokens.placeables;
  if (typeof col.get === "function") {
    const direct = col.get(tokenDocId);
    if (direct) return direct;
  }
  for (const t of col) {
    if (t?.id === tokenDocId || t?.document?.id === tokenDocId) return t;
  }
  return null;
}

/** @returns {BoardMovementMode} */
function getBoardMovementMode() {
  try {
    const v = game.settings.get(MODULE_ID, "movementMode");
    if (v === "free" || v === "combat" || v === "disabled") return v;
  } catch {
    /* settings not ready */
  }
  return DEFAULT_MOVEMENT_MODE;
}

function getBoardMaxMoveGridSquares() {
  try {
    const n = Number(game.settings.get(MODULE_ID, "maxMoveGridSquares"));
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* settings not ready */
  }
  return DEFAULT_MAX_MOVE_GRID_SQUARES;
}

/** @param {*} token @param {*} doc */
function tokenCenterWorld(token, doc) {
  const gs = canvas.grid?.size ?? 100;
  const w = (doc.width ?? 1) * gs;
  const h = (doc.height ?? 1) * gs;
  return { x: doc.x + w / 2, y: doc.y + h / 2 };
}

/** @param {*} token @param {*} doc @param {number} targetCenterX @param {number} targetCenterY */
function movementPathBlocked(token, doc, targetCenterX, targetCenterY) {
  const walls = canvas.walls;
  if (!walls?.checkCollision) return false;
  const from = tokenCenterWorld(token, doc);
  const RayCtor =
    foundry?.canvas?.geometry?.Ray ?? globalThis.Ray ?? null;
  if (!RayCtor) return false;
  try {
    const ray = new RayCtor({ x: from.x, y: from.y }, { x: targetCenterX, y: targetCenterY });
    const hit = walls.checkCollision(ray, { type: "movement", mode: "any" });
    return Boolean(hit);
  } catch (e) {
    debugLog("wall check failed", e);
    return false;
  }
}

/** @param {*} token @param {*} doc @param {number} targetCenterX @param {number} targetCenterY @param {BoardMovementMode} mode */
function validateGlyphMove(token, doc, targetCenterX, targetCenterY, mode) {
  if (mode === "disabled") {
    return {
      ok: false,
      message:
        "Movement is disabled for the Board. The GM can change this under Configure Settings → Board Tabletop.",
    };
  }

  if (movementPathBlocked(token, doc, targetCenterX, targetCenterY)) {
    return {
      ok: false,
      message: "That path is blocked by a wall on the Foundry map.",
    };
  }

  const gs = canvas.grid?.size ?? 100;
  if (gs <= 0) return { ok: true };

  const from = tokenCenterWorld(token, doc);
  const dist = Math.hypot(targetCenterX - from.x, targetCenterY - from.y);
  const gridDist = dist / gs;

  if (mode === "combat") {
    const combat = game.combat;
    if (combat?.started) {
      const actor = token.actor;
      const sys = actor?.system;
      const movement =
        Number(sys?.attributes?.movement?.walk) ||
        Number(sys?.attributes?.movement?.burrow) ||
        Number(sys?.attributes?.movement?.fly) ||
        Number(sys?.attributes?.movement?.swim) ||
        Number(sys?.attributes?.movement?.climb) ||
        0;
      if (movement > 0 && gridDist > movement + 0.05) {
        return {
          ok: false,
          message: `That move exceeds this character's ${movement} ft movement in combat (${Math.round(gridDist)} ft requested).`,
        };
      }
      if (movement <= 0) {
        const cap = getBoardMaxMoveGridSquares();
        if (gridDist > cap + 0.05) {
          return {
            ok: false,
            message: `That move is too far during combat (max ${cap} grid squares from the token's current position).`,
          };
        }
      }
    } else {
      const cap = getBoardMaxMoveGridSquares();
      if (gridDist > cap + 0.05) {
        return {
          ok: false,
          message: `That move is too far (max ${cap} grid squares from the token's current position).`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Max distance (in pixels) the token may legally travel from its current center
 * under the given mode, or null when there is no distance cap (free movement).
 * Mirrors the distance rules in {@link validateGlyphMove}.
 * @param {*} token @param {BoardMovementMode} mode
 */
function maxLegalMoveDistancePx(token, mode) {
  if (mode !== "combat") return null;
  const gs = canvas.grid?.size ?? 100;
  let maxGrid = getBoardMaxMoveGridSquares();
  const combat = game.combat;
  if (combat?.started) {
    const sys = token.actor?.system;
    const movement =
      Number(sys?.attributes?.movement?.walk) ||
      Number(sys?.attributes?.movement?.burrow) ||
      Number(sys?.attributes?.movement?.fly) ||
      Number(sys?.attributes?.movement?.swim) ||
      Number(sys?.attributes?.movement?.climb) ||
      0;
    if (movement > 0) maxGrid = movement;
  }
  return maxGrid * gs;
}

/**
 * Closest wall-collision point along a segment, or null when the path is clear.
 * @param {{x:number,y:number}} from @param {{x:number,y:number}} to
 */
function closestWallHit(from, to) {
  const walls = canvas.walls;
  if (!walls?.checkCollision) return null;
  const RayCtor = foundry?.canvas?.geometry?.Ray ?? globalThis.Ray ?? null;
  if (!RayCtor) return null;
  try {
    const ray = new RayCtor({ x: from.x, y: from.y }, { x: to.x, y: to.y });
    const hit = walls.checkCollision(ray, { type: "movement", mode: "closest" });
    if (hit && typeof hit.x === "number" && typeof hit.y === "number") {
      return { x: hit.x, y: hit.y };
    }
    return null;
  } catch (e) {
    debugLog("closest wall check failed", e);
    return null;
  }
}

/**
 * Furthest legal center point along the straight line from the token's current
 * center toward the requested target, clamping for both movement-distance caps
 * and wall collisions. Returns the resolved center plus the original `from`.
 * @param {*} token @param {*} doc @param {number} targetCenterX @param {number} targetCenterY @param {BoardMovementMode} mode
 */
function nearestLegalCenter(token, doc, targetCenterX, targetCenterY, mode) {
  const from = tokenCenterWorld(token, doc);
  const gs = canvas.grid?.size ?? 100;
  let tx = targetCenterX;
  let ty = targetCenterY;

  // 1. Clamp the travel distance to the legal maximum (combat movement cap).
  const maxDistPx = maxLegalMoveDistancePx(token, mode);
  if (maxDistPx != null) {
    const dx = tx - from.x;
    const dy = ty - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDistPx && dist > 0) {
      const f = maxDistPx / dist;
      tx = from.x + dx * f;
      ty = from.y + dy * f;
    }
  }

  // 2. Stop short of any wall crossed along the (distance-clamped) path, backing
  //    off slightly so the token doesn't rest exactly on the wall.
  const wallPt = closestWallHit(from, { x: tx, y: ty });
  if (wallPt) {
    const dx = wallPt.x - from.x;
    const dy = wallPt.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d > 0) {
      const backoff = Math.min(d, gs * 0.25);
      const f = Math.max(0, (d - backoff) / d);
      tx = from.x + dx * f;
      ty = from.y + dy * f;
    } else {
      tx = from.x;
      ty = from.y;
    }
  }

  return { x: tx, y: ty, from };
}

/** @param {{ contactId: number, seq: number, ok: boolean, message?: string, toUserId: string }} payload */
function emitGlyphMoveResult(payload) {
  if (!game?.socket) return;
  game.socket.emit(SOCKET_EVENT, {
    type: "glyphMoveResult",
    contactId: payload.contactId,
    seq: payload.seq,
    ok: payload.ok,
    message: payload.message ?? "",
    toUserId: payload.toUserId,
  });
}

function notifyGlyphMoveResultListeners(result) {
  for (const cb of glyphMoveResultListeners) {
    try {
      cb(result);
    } catch (e) {
      console.error("[board-tabletop] glyphMoveResult listener failed", e);
    }
  }
}

/** @param {number} contactId */
function clearGlyphMoveQueue(contactId) {
  const q = glyphMoveQueue.get(contactId);
  if (q?.timer) clearTimeout(q.timer);
  glyphMoveQueue.delete(contactId);
}

/** Queue the latest drag sample; apply once the throttle window elapses (no error to Board). */
function scheduleCoalescedGlyphApply(data) {
  const contactId = data.contactId;
  let q = glyphMoveQueue.get(contactId);
  if (!q) {
    q = { latest: data, timer: null };
    glyphMoveQueue.set(contactId, q);
  } else {
    q.latest = data;
  }
  if (q.timer) return;

  const lastT = glyphLastSocketApply.get(contactId) ?? 0;
  const delay = Math.max(0, GLYPH_SOCKET_THROTTLE_MS - (Date.now() - lastT));
  q.timer = setTimeout(() => {
    q.timer = null;
    const entry = glyphMoveQueue.get(contactId);
    const latest = entry?.latest;
    if (!latest || latest.ended) return;
    void applyGlyphMoveInner(latest);
  }, delay);
}

async function applyGlyphToFoundryFromSocket(data) {
  if (!data || data.type !== "glyphToFoundry") return;
  if (!game.user?.isGM) return;
  if (!canvas?.ready || !canvas.scene) return;

  const sceneId = canvas.scene.id;
  if (lastGlyphBindingSceneId !== sceneId) {
    for (const cid of glyphMoveQueue.keys()) clearGlyphMoveQueue(cid);
    glyphContactToTokenId.clear();
    lastGlyphBindingSceneId = sceneId;
  }

  const contactId = data.contactId;
  const fromUserId = data.fromUserId;
  const seq = Number.isFinite(data.seq) ? data.seq : 0;

  // Lift-and-place: apply immediately (do not queue behind drag throttle).
  if (data.placeMove && !data.ended) {
    clearGlyphMoveQueue(contactId);
    await applyGlyphMoveInner(data);
    return;
  }

  if (data.ended) {
    clearGlyphMoveQueue(contactId);
    const tid = glyphContactToTokenId.get(contactId);
    glyphContactToTokenId.delete(contactId);
    glyphLastSocketApply.delete(contactId);
    if (tid) {
      const t = findCanvasTokenById(tid);
      const a = t?.actor;
      if (a) void a.unsetFlag?.(MODULE_ID, "boardGlyph");
    }
    return;
  }

  const now = Date.now();
  const lastT = glyphLastSocketApply.get(contactId) ?? 0;
  if (now - lastT < GLYPH_SOCKET_THROTTLE_MS) {
    scheduleCoalescedGlyphApply(data);
    return;
  }
  clearGlyphMoveQueue(contactId);
  await applyGlyphMoveInner(data);
}

/** GM: resolve token, validate, and update Foundry for one (possibly coalesced) drag sample. */
async function applyGlyphMoveInner(data) {
  const contactId = data.contactId;
  const fromUserId = data.fromUserId;
  const seq = Number.isFinite(data.seq) ? data.seq : 0;

  glyphLastSocketApply.set(contactId, Date.now());

  const pcTokenIds = getBindablePcTokenIds();

  const map = cachedPieceAssignments.map ?? {};
  const explicit = map[String(data.glyphId)];
  /** @type {string | null} */
  const triedExplicitAssignment = explicit ?? null;
  // Has the user explicitly bound any piece → token? If so, NEVER fall back to
  // an arbitrary token: an unbound (or not-yet-synced) glyph must not hijack a
  // player token the user never associated (that caused "moving piece #1 also
  // moves another token"). Only auto-assign by ordinal in pure zero-config use.
  const hasExplicitBindings = Object.keys(map).length > 0;

  let tokenDocId = null;
  if (explicit && findCanvasTokenById(explicit)) {
    // Bind Pieces assignment always wins over a stale per-glyph cache entry.
    tokenDocId = explicit;
  } else if (!hasExplicitBindings) {
    tokenDocId = glyphContactToTokenId.get(contactId) ?? null;
    if (!tokenDocId && pcTokenIds.length > 0) {
      const ord = Number(data.placementOrdinal) || 0;
      tokenDocId = pcTokenIds[ord % pcTokenIds.length];
    }
  }

  if (!tokenDocId) {
    const msg =
      "No Foundry token is linked to this Board piece. Open Pieces on the Board and assign a token, or place character tokens on the scene.";
    debugLog("glyphToFoundry: no token for glyph", {
      glyphId: data.glyphId,
      explicit: triedExplicitAssignment,
    });
    if (seq > 0 && fromUserId) {
      emitGlyphMoveResult({
        contactId,
        seq,
        ok: false,
        message: msg,
        toUserId: fromUserId,
      });
    }
    return;
  }
  glyphContactToTokenId.set(contactId, tokenDocId);

  const { x: fx, y: fy } = phaserMapToFoundryWorld(
    data.phaserMapX,
    data.phaserMapY,
    data.mapW,
    data.mapH,
  );

  const token = findCanvasTokenById(tokenDocId);
  if (!token?.document) {
    debugLog("glyphToFoundry: token left the scene or id invalid", tokenDocId);
    if (seq > 0 && fromUserId) {
      emitGlyphMoveResult({
        contactId,
        seq,
        ok: false,
        message: "That token is no longer on the scene.",
        toUserId: fromUserId,
      });
    }
    return;
  }

  const doc = token.document;
  const gs = canvas.grid?.size ?? 100;
  const w = (doc.width ?? 1) * gs;
  const h = (doc.height ?? 1) * gs;
  const x = fx - w / 2;
  const y = fy - h / 2;
  const rotation = Number.isFinite(data.rotation) ? data.rotation : doc.rotation;
  const targetCenterX = fx;
  const targetCenterY = fy;

  const mode = getBoardMovementMode();
  const validation = validateGlyphMove(token, doc, targetCenterX, targetCenterY, mode);
  if (!validation.ok) {
    // Rejected move: slide the token as far along the path as is legal (stop at
    // the wall / movement cap) instead of refusing outright, so it settles at
    // the nearest legal point to the piece. The slide is monotonic-forward (from
    // the token's current center toward the target), so repeated rejected samples
    // converge on the obstacle rather than bouncing. We still report ok:false
    // with the reason so the Board shows the error spine, the compass pointing at
    // the token's resolved spot, and the toast.
    if (mode !== "disabled") {
      const legal = nearestLegalCenter(
        token,
        doc,
        targetCenterX,
        targetCenterY,
        mode,
      );
      const movedPx = Math.hypot(legal.x - legal.from.x, legal.y - legal.from.y);
      if (movedPx > 1) {
        const lx = legal.x - w / 2;
        const ly = legal.y - h / 2;
        try {
          // animate:false — the token icon must POP to the new spot, not tween.
          await doc.update({ x: lx, y: ly, rotation }, { animate: false });
          scheduleTokensRefresh();
        } catch (err) {
          console.error("[board-tabletop] partial token slide failed", err);
        }
      }
    }
    if (seq > 0 && fromUserId) {
      emitGlyphMoveResult({
        contactId,
        seq,
        ok: false,
        message: validation.message ?? "That move is not allowed.",
        toUserId: fromUserId,
      });
    }
    return;
  }

  const actor = token.actor;
  if (actor) {
    void actor.setFlag?.(MODULE_ID, "boardGlyph", {
      contactId,
      tokenId: tokenDocId,
      placementOrdinal: data.placementOrdinal,
      sourceUserId: fromUserId,
      glyphId: data.glyphId,
      updated: Date.now(),
    });
  }

  try {
    // animate:false — the token icon must POP to the new spot, not tween.
    await doc.update({ x, y, rotation }, { animate: false });
    scheduleTokensRefresh();
    if (seq > 0 && fromUserId) {
      emitGlyphMoveResult({
        contactId,
        seq,
        ok: true,
        toUserId: fromUserId,
      });
    }
  } catch (err) {
    console.error("[board-tabletop] token update failed (glyphToFoundry)", err);
    if (seq > 0 && fromUserId) {
      emitGlyphMoveResult({
        contactId,
        seq,
        ok: false,
        message:
          err instanceof Error && err.message
            ? `Foundry could not move the token: ${err.message}`
            : "Foundry could not move the token. Check permissions and scene state.",
        toUserId: fromUserId,
      });
    }
  }
}

function onSocketData(data) {
  if (!data) return;

  if (data.type === "gmPointer") {
    const sender = game.users?.get?.(data.userId);
    if (!sender?.isGM) return;
    state.lastGmCursor = {
      sceneId: data.sceneId,
      x: data.x,
      y: data.y,
      userId: data.userId,
    };
    notifyCursorListeners(state.lastGmCursor);
    return;
  }

  if (data.type === "pieceAssignmentsSet") {
    if (!game.user?.isGM) return;
    void (async () => {
      const normalized = normalizePieceAssignments(data.value);
      await game.settings.set(MODULE_ID, "pieceAssignments", normalized);
      cachedPieceAssignments = normalized;
      // Drop sticky glyph→token resolutions so a new/changed binding takes effect
      // and a stale fallback can't keep moving a previously auto-picked token.
      glyphContactToTokenId.clear();
      notifyPieceAssignmentListeners();
      game.socket.emit(SOCKET_EVENT, {
        type: "pieceAssignmentsPushed",
        value: normalized,
      });
    })();
    return;
  }

  if (data.type === "pieceAssignmentsPushed") {
    cachedPieceAssignments = normalizePieceAssignments(data.value);
    glyphContactToTokenId.clear();
    notifyPieceAssignmentListeners();
    return;
  }

  if (data.type === "glyphToFoundry") {
    void applyGlyphToFoundryFromSocket({ ...data, type: "glyphToFoundry" });
    return;
  }

  if (data.type === "glyphMoveResult") {
    if (data.toUserId && data.toUserId !== game.userId) return;
    notifyGlyphMoveResultListeners({
      contactId: data.contactId,
      seq: data.seq,
      ok: !!data.ok,
      message: typeof data.message === "string" ? data.message : undefined,
    });
    return;
  }

  if (data.type === "tokensUpdate") {
    if (game.user?.isGM) return;
    if (!data.value || typeof data.value !== "object") return;
    applyTokenSnapshot(data.value);
    return;
  }

  if (data.type === "fogUpdate") {
    // Fog is computed locally on the Board inside the Phaser game (VisionComputer); the GM's
    // legacy socket fog emit is no longer consumed — ignore it on every client.
    return;
  }
}

function installGlobalBridge() {
  globalThis.__boardPhaserCollectBootSnapshot = collectBootSnapshot;
  window.__BOARD_PHASER_FOUNDRY = {
    getActiveSceneMap() {
      return state.lastSceneInfo;
    },
    onActiveSceneMap(cb) {
      state.mapListeners.add(cb);
      cb(state.lastSceneInfo);
      return () => state.mapListeners.delete(cb);
    },
    /**
     * Fires the moment a scene switch begins (canvasInit), well before the map info resolves —
     * Foundry's transition, the bridge's dimension retries and the game-side debounce add up to
     * a visible gap in which the old scene would otherwise stay on screen. Edge event: no replay
     * of a "current" value on subscribe.
     */
    onSceneTransitionStart(cb) {
      state.sceneTransitionListeners.add(cb);
      return () => state.sceneTransitionListeners.delete(cb);
    },
    /**
     * The decoded pixels of the current scene's background, straight from PIXI's texture cache.
     * The game and Foundry share one page, so the game can tile from this source directly and
     * skip its own fetch + native-resolution decode — the decode was the dominant transient of a
     * scene switch, and running it twice (PIXI + Phaser) concurrently is what OOM-killed the
     * renderer on large maps. Null when the texture isn't loaded/valid (the game falls back to
     * its own URL load). The object stays owned by PIXI: the game must NOT close/destroy it, and
     * must call consumeSceneArt() when done tiling so the module can unload it.
     */
    getSceneBackgroundImageSource() {
      try {
        const base = canvas?.primary?.background?.texture?.baseTexture ?? null;
        const source = base?.resource?.source ?? null;
        if (!base?.valid || !source) return null;
        const width =
          source.naturalWidth ?? source.width ?? base.realWidth ?? 0;
        const height =
          source.naturalHeight ?? source.height ?? base.realHeight ?? 0;
        if (!width || !height) return null;
        return { sceneId: canvas?.scene?.id ?? null, source, width, height };
      } catch (_) {
        return null;
      }
    },
    /** Game is done tiling the current scene — Foundry's copy of the big art can be unloaded. */
    consumeSceneArt(sceneId) {
      try {
        consumeSceneArtNow(sceneId ?? null);
      } catch (e) {
        console.warn("[board-tabletop] consumeSceneArt failed", e);
      }
    },
    getGmCursor() {
      return state.lastGmCursor;
    },
    onGmCursor(cb) {
      state.cursorListeners.add(cb);
      cb(state.lastGmCursor);
      return () => state.cursorListeners.delete(cb);
    },
    getTokens() {
      return enrichTokenSnapshotForViewer(state.lastTokenSnapshot);
    },
    onTokensChange(cb) {
      state.tokenListeners.add(cb);
      cb(enrichTokenSnapshotForViewer(state.lastTokenSnapshot));
      return () => state.tokenListeners.delete(cb);
    },
    getFogUpdate() {
      return state.lastFogUpdate;
    },
    onFogUpdate(cb) {
      state.fogListeners.add(cb);
      cb(state.lastFogUpdate);
      return () => state.fogListeners.delete(cb);
    },
    getPieceAssignments() {
      return cachedPieceAssignments;
    },
    onPieceAssignmentsChange(cb) {
      state.pieceAssignmentListeners.add(cb);
      try {
        cb();
      } catch (e) {
        console.error("[board-tabletop] onPieceAssignmentsChange initial cb failed", e);
      }
      return () => state.pieceAssignmentListeners.delete(cb);
    },
    setPieceAssignments(next) {
      try {
        const normalized = normalizePieceAssignments(next);
        cachedPieceAssignments = normalized;
        glyphContactToTokenId.clear();
        notifyPieceAssignmentListeners();
        if (game.user?.isGM) {
          void (async () => {
            await game.settings.set(MODULE_ID, "pieceAssignments", normalized);
            game.socket.emit(SOCKET_EVENT, {
              type: "pieceAssignmentsPushed",
              value: normalized,
            });
          })();
        } else if (game.socket) {
          game.socket.emit(SOCKET_EVENT, {
            type: "pieceAssignmentsSet",
            fromUserId: game.userId,
            value: normalized,
          });
        }
      } catch (e) {
        debugLog("setPieceAssignments", e);
      }
    },
    reportGlyphState(payload) {
      try {
        // Freeze piece moves while the game is paused — drop reports so tokens don't move.
        if (state.lastPaused) return;
        if (!game?.socket) return;
        game.socket.emit(SOCKET_EVENT, {
          type: "glyphToFoundry",
          fromUserId: game.userId,
          contactId: payload.contactId,
          glyphId: payload.glyphId,
          phaserMapX: payload.phaserMapX,
          phaserMapY: payload.phaserMapY,
          mapW: payload.mapW,
          mapH: payload.mapH,
          rotation: payload.rotation,
          placementOrdinal: payload.placementOrdinal,
          ended: !!payload.ended,
          seq: Number.isFinite(payload.seq) ? payload.seq : 0,
        });
      } catch (e) {
        debugLog("reportGlyphState", e);
      }
    },
    onGlyphMoveResult(cb) {
      glyphMoveResultListeners.add(cb);
      return () => glyphMoveResultListeners.delete(cb);
    },
  };
}

/**
 * True only inside Playtable's Foundry WebView, where the native app injects the
 * `BoardSDK` @JavascriptInterface bridge (mirrors the Board Web SDK's
 * `Board.isOnDevice` / `isBoardDevice()`). Regular guest browsers never have it,
 * so they keep the normal Foundry UI instead of the Board Tabletop surface.
 */
function isBoardDevice() {
  return typeof window !== "undefined" && typeof window.BoardSDK !== "undefined";
}

/** True once the Board player is on the in-world client — not /join or setup. */
function isInFoundryGameWorld() {
  try {
    const path = globalThis.location?.pathname ?? "";
    if (path.includes("/join") || path.includes("/setup") || path.includes("/auth")) {
      return false;
    }
    if (path.includes("/game")) return true;
    return !!(canvas?.ready && canvas?.scene?.id);
  } catch (_) {
    return false;
  }
}

/**
 * Mount the Phaser Board surface only on an actual Board device (non-GM client
 * running inside Playtable) after the player has entered the world. Guests
 * viewing the world in a web browser — and the GM — keep Foundry's normal UI.
 * Mounting on /join would inject CSS that hides the login form.
 */
function shouldMountPhaser() {
  if (!isBoardDevice()) return false;
  if (game?.user?.isGM) return false;
  return isInFoundryGameWorld();
}

function setBootStage(stage) {
  if (globalThis.__boardPhaserBootStage === stage) return;
  globalThis.__boardPhaserBootStage = stage;
  reportBootDiagnostic({ stage });
}

function collectBootSnapshot() {
  const last = state.lastSceneInfo;
  return {
    stage: globalThis.__boardPhaserBootStage ?? null,
    sessionReady: globalThis.__boardPhaserSessionReady === true,
    phaserMounted: state.phaserMounted,
    boardSdk: typeof globalThis.BoardSDK !== "undefined",
    shouldMount: shouldMountPhaser(),
    isGm: !!game?.user?.isGM,
    gameReady: !!game?.ready,
    canvasSceneId: canvas?.scene?.id ?? null,
    canvasReady: !!canvas?.ready,
    hasSceneMapUrl: !!(last && last.url),
    sceneId: last?.sceneId ?? null,
    gameCanvases: document.getElementById("game")?.querySelectorAll("canvas")?.length ?? 0,
    milestone: globalThis.__boardPhaserLoadingMilestone ?? null,
    bundleError: globalThis.__boardPhaserBundleError ?? null,
    bundleLoaded: globalThis.__boardPhaserBundleLoaded === true,
    bundleExecuted: globalThis.__boardPhaserBundleExecuted === true,
    phaserGame: !!globalThis.__boardPhaserGame,
    foundryCanvasNeutralized: globalThis.__boardPhaserFoundryCanvasNeutralized === true,
    cssLoaded: globalThis.__boardPhaserCssLoaded === true,
    cssError: globalThis.__boardPhaserCssError ?? null,
    moduleBuild: MODULE_BUILD_VERSION,
    moduleVersion: (() => {
      try {
        return game?.modules?.get?.(MODULE_ID)?.version ?? null;
      } catch (_) {
        return null;
      }
    })(),
  };
}

function reportBootDiagnostic(extra) {
  const payload = { ...collectBootSnapshot(), ...extra };
  const json = JSON.stringify(payload);
  console.log("[board-tabletop boot] " + json);
  try {
    globalThis.PlaytableFoundryBridge?.onFoundryBootDiagnostic?.(json);
  } catch (_) {
    /* bridge optional */
  }
}

/**
 * The first dynamic import() of the Phaser bundle frequently stalls on the Board
 * WebView while Foundry is still drawing its (often oversize) scene canvas —
 * "Preparing the Overlay" saturates the main thread / network and the import
 * promise never resolves. A single retry is not enough because a follow-up import
 * issued while Foundry is still drawing stalls too. So we re-issue the import on
 * every tick (abandoning the stuck promise each time) until one lands, which
 * happens as soon as Foundry's draw settles. Runs on a short interval so recovery
 * is measured in seconds, not the old ~50s.
 */
const BOOT_WATCHDOG_INTERVAL_MS = 4000;
const BOOT_WATCHDOG_GIVE_UP_MS = 90_000;

function installBootWatchdog() {
  if (globalThis.__boardPhaserBootWatchdogInstalled) return;
  globalThis.__boardPhaserBootWatchdogInstalled = true;
  const startedAt = Date.now();
  const timer = globalThis.setInterval(() => {
    if (globalThis.__boardPhaserSessionReady === true) {
      globalThis.clearInterval(timer);
      return;
    }
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    reportBootDiagnostic({ watchdogSec: elapsedSec });
    if (!shouldMountPhaser()) return;

    if (isPhaserActuallyRunning()) {
      console.warn(
        "[board-tabletop boot] watchdog: Phaser running after " + elapsedSec + "s — signaling session ready",
      );
      notifyPlaytableSessionReady();
      globalThis.clearInterval(timer);
      return;
    }

    // Not running yet. Re-issue the import unless one is genuinely in flight and
    // recent (loadPhaserGameBundle just started). We abandon a stalled promise by
    // resetting it inside retryPhaserGameBundle.
    console.warn(
      "[board-tabletop boot] watchdog " +
        elapsedSec +
        "s: Phaser not running (canvases=" +
        (document.getElementById("game")?.querySelectorAll("canvas")?.length ?? 0) +
        ", bundleLoaded=" +
        !!globalThis.__boardPhaserBundleLoaded +
        ") — re-issuing import",
    );
    void retryPhaserGameBundle("watchdog_" + elapsedSec + "s");
    retryPhaserGameStylesheet("watchdog_" + elapsedSec + "s");

    if (Date.now() - startedAt >= BOOT_WATCHDOG_GIVE_UP_MS) {
      console.error("[board-tabletop boot] giving up after 90s — restoring Foundry UI");
      restoreFoundryUiAfterPhaserFailure();
      globalThis.clearInterval(timer);
    }
  }, BOOT_WATCHDOG_INTERVAL_MS);
}

function restoreFoundryUiAfterPhaserFailure() {
  document.getElementById("board-phaser-hide-foundry-ui")?.remove();
  try {
    canvas?.app?.ticker?.start();
  } catch (_) {
    /* ignore */
  }
}

const SESSION_LOADING_SUBTITLE_CONNECTING = "Connecting to server...";
const SESSION_LOADING_INITIAL_MILESTONE = "Loading Scene";
const SESSION_LOADING_MILESTONE_EVENT = "board-phaser-loading-milestone";

/** Strip directory, query string and file extension from a URL → readable file name. */
function boardSceneImageNameFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const clean = url.split("?")[0].split("#")[0];
    const parts = clean.split("/");
    let base = parts[parts.length - 1] || "";
    try {
      base = decodeURIComponent(base);
    } catch (_) {
      /* keep raw base */
    }
    return base.replace(/\.[a-z0-9]+$/i, "").trim();
  } catch (_) {
    return "";
  }
}

/** Name of the active scene's background image, if any (for the loading subtitle). */
function getActiveSceneImageName() {
  try {
    const src =
      game?.scenes?.active?.background?.src ||
      (typeof canvas !== "undefined" ? canvas?.scene?.background?.src : "") ||
      game?.scenes?.current?.background?.src ||
      "";
    return boardSceneImageNameFromUrl(src);
  } catch (_) {
    return "";
  }
}

/** "Loading <scene image name>" while a scene loads (falls back when unknown). */
function sceneLoadingLabel() {
  const name = getActiveSceneImageName();
  return name ? `Loading ${name}` : SESSION_LOADING_INITIAL_MILESTONE;
}

function parseFoundryLoadingMilestone(message) {
  if (!message || typeof message !== "string") return null;
  const text = message.trim();
  if (!text) return null;
  if (/\bViewing Scene\b/i.test(text)) return sceneLoadingLabel();
  if (/\bLoading Assets\b/i.test(text) || /\bLoading \d+ assets?\b/i.test(text)) {
    return sceneLoadingLabel();
  }
  const canvasGroup = text.match(/\bDrawing the (\w+)CanvasGroup canvas group\b/i);
  if (canvasGroup?.[1]) return sceneLoadingLabel();
  return null;
}

function getSessionLoadingMilestone() {
  const stored = globalThis.__boardPhaserLoadingMilestone;
  return typeof stored === "string" && stored.length > 0
    ? stored
    : sceneLoadingLabel();
}

function setSessionLoadingMilestone(subtitle) {
  const text = typeof subtitle === "string" ? subtitle.trim() : "";
  if (!text) return;
  globalThis.__boardPhaserLoadingMilestone = text;
  updateSessionLoadingDomSubtitle(text);
  try {
    globalThis.dispatchEvent(
      new CustomEvent(SESSION_LOADING_MILESTONE_EVENT, { detail: { text } }),
    );
  } catch (e) {
    debugLog("loading milestone event failed", e);
  }
  try {
    const bridge = globalThis.PlaytableFoundryBridge;
    if (bridge && typeof bridge.onFoundryLoadingMilestone === "function") {
      bridge.onFoundryLoadingMilestone(text);
    }
  } catch (e) {
    debugLog("loading milestone bridge failed", e);
  }
}

function applySessionLoadingMilestoneFromLog(message) {
  const milestone = parseFoundryLoadingMilestone(message);
  if (!milestone) return false;
  setSessionLoadingMilestone(milestone);
  return true;
}

function installFoundryLoadingMilestoneTracker() {
  if (globalThis.__boardPhaserLoadingMilestoneTracker) return;
  globalThis.__boardPhaserLoadingMilestoneTracker = true;

  function inspectConsoleArgs(args) {
    for (const arg of args) {
      if (typeof arg === "string" && applySessionLoadingMilestoneFromLog(arg)) return;
    }
    const joined = args
      .map((arg) => (typeof arg === "string" ? arg : ""))
      .join(" ");
    applySessionLoadingMilestoneFromLog(joined);
  }

  for (const level of ["log", "info", "debug"]) {
    const original = console[level]?.bind(console);
    if (typeof original !== "function") continue;
    console[level] = function (...args) {
      inspectConsoleArgs(args);
      return original(...args);
    };
  }

  Hooks.on("viewScene", () => setSessionLoadingMilestone(sceneLoadingLabel()));
}

const SESSION_LOADING_DOM_ID = "board-phaser-session-loading";
const SESSION_READY_EVENT = "board-phaser-session-ready";
const SESSION_PLAYER_LOGGED_IN_EVENT = "board-phaser-player-logged-in";
const SESSION_LOADING_SUBTITLE_CLASS = "board-phaser-session-subtitle";
const SESSION_LOADING_TITLE_CLASS = "board-phaser-session-title";
const SESSION_LOADING_CANCEL_CLASS = "board-phaser-session-cancel";
// DEBUG off (production): fully opaque black so the raw Foundry WebView is never
// visible behind the loading card. DEBUG on: translucent so we can see boot state.
const SESSION_LOADING_BACKDROP = DEBUG ? "rgba(0,0,0,0.7)" : "#000";
const SESSION_LOADING_FONT_BASE = `/modules/${MODULE_ID}/game/fonts`;
const SESSION_LOADING_SPINNER_STYLE_ID = "board-phaser-session-loading-spin";
/** Must match Playtable FoundryNavigation.BOARD_VTT_EXIT_WORLD_URI */
const BOARD_VTT_EXIT_WORLD_URI = "boardvtt://exit-world";
/** Must match Playtable FoundryNavigation.BOARD_VTT_EXIT_CONNECT_URI */
const BOARD_VTT_EXIT_CONNECT_URI = "boardvtt://exit-connect";

function ensureSessionLoadingSpinnerStyle() {
  if (document.getElementById(SESSION_LOADING_SPINNER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SESSION_LOADING_SPINNER_STYLE_ID;
  style.textContent = `
    @font-face {
      font-family: "Kabel ITC BQ";
      src: url("${SESSION_LOADING_FONT_BASE}/kabel-itc-bq-regular.otf") format("opentype");
      font-weight: 500;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "Haas Grot Text Trial";
      src: url("${SESSION_LOADING_FONT_BASE}/haasgrot-text-75-bold.ttf") format("truetype");
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }
    @keyframes boardPhaserSessionSpin {
      to { transform: rotate(360deg); }
    }
    #${SESSION_LOADING_DOM_ID} .${SESSION_LOADING_TITLE_CLASS} {
      margin: 0;
      font-family: "Kabel ITC BQ", system-ui, sans-serif;
      font-size: 40px;
      font-weight: 500;
      font-style: normal;
      line-height: 1.1;
      color: #000;
    }
    #${SESSION_LOADING_DOM_ID} .${SESSION_LOADING_SUBTITLE_CLASS} {
      font-family: "Haas Grot Text Trial", system-ui, sans-serif;
      font-weight: 700;
      font-style: normal;
      font-size: 20px;
      line-height: 1.5;
      color: rgba(0, 0, 0, 0.6);
    }
    #${SESSION_LOADING_DOM_ID} .${SESSION_LOADING_CANCEL_CLASS} {
      font-family: "Kabel ITC BQ", system-ui, sans-serif;
      font-weight: 500;
      font-style: normal;
      font-size: 28px;
      line-height: 1.2;
      width: 148px;
      height: 84px;
      border: none;
      border-radius: 24px;
      background: #fffef1;
      color: #000;
      padding: 0;
      cursor: pointer;
    }
    #${SESSION_LOADING_DOM_ID} .board-phaser-session-spinner {
      width: 44px;
      height: 44px;
      border: 4px solid #d8d0c0;
      border-top-color: #2a8f5a;
      border-radius: 50%;
      animation: boardPhaserSessionSpin 0.9s linear infinite;
    }
  `;
  document.head.appendChild(style);
}

function updateSessionLoadingDomSubtitle(text) {
  const el = document.getElementById(SESSION_LOADING_DOM_ID);
  const sub = el?.querySelector(`.${SESSION_LOADING_SUBTITLE_CLASS}`);
  if (sub) sub.textContent = text;
}

function isFoundryJoinLoginPath() {
  try {
    const path = globalThis.location?.pathname ?? "";
    return path.includes("/join");
  } catch (_) {
    return false;
  }
}

/** Show the loading card on Board hardware whenever login should stay visible underneath. */
function ensureBoardSessionLoadingOverlay() {
  if (!isBoardDevice()) return;
  if (globalThis.__boardPhaserSessionReady === true) return;
  if (document.querySelector("[data-board-piece-binding]")) return;
  if (isFoundryJoinLoginPath() && globalThis.__playtableJoinUiReady === true) return;
  showSessionLoadingDomOverlay();
}

function signalFoundryPlayerLoggedIn() {
  if (typeof window === "undefined") return;
  if (window.__boardPhaserPlayerLoggedIn === true) return;
  window.__boardPhaserPlayerLoggedIn = true;
  ensureBoardSessionLoadingOverlay();
  updateSessionLoadingDomSubtitle(getSessionLoadingMilestone());
  window.dispatchEvent(new Event(SESSION_PLAYER_LOGGED_IN_EVENT));
}

function hideSessionLoadingDomOverlay() {
  document.getElementById(SESSION_LOADING_DOM_ID)?.remove();
}

function cancelSessionLoadingAndReturnHome() {
  hideSessionLoadingDomOverlay();
  try {
    window.location.href = BOARD_VTT_EXIT_CONNECT_URI;
  } catch (e) {
    console.warn("[board-tabletop] cancel session loading failed", e);
  }
}

function showSessionLoadingDomOverlay() {
  if (window.__boardPhaserSessionReady === true) return;
  // Once the Phaser bundle mounts, React renders its own "Foundry Session Loading"
  // card. Don't stack this module-drawn card behind it (that was the phantom
  // "second popup") — remove any existing node and stop re-creating it.
  if (window.__boardPhaserReactLoadingOverlayActive === true) {
    document.getElementById(SESSION_LOADING_DOM_ID)?.remove();
    return;
  }
  if (document.getElementById(SESSION_LOADING_DOM_ID)) {
    if (window.__boardPhaserPlayerLoggedIn === true) {
      updateSessionLoadingDomSubtitle(getSessionLoadingMilestone());
    }
    return;
  }
  ensureSessionLoadingSpinnerStyle();
  const subtitle =
    window.__boardPhaserPlayerLoggedIn === true
      ? getSessionLoadingMilestone()
      : SESSION_LOADING_SUBTITLE_CONNECTING;
  const el = document.createElement("div");
  el.id = SESSION_LOADING_DOM_ID;
  el.setAttribute("data-board-phaser", "");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText = `
    position:fixed;inset:0;z-index:2000000005;
    display:flex;align-items:center;justify-content:center;
    background:${SESSION_LOADING_BACKDROP};
    font-family:system-ui,sans-serif;
  `;
  el.innerHTML = `
    <div style="
      width:min(42vw,480px);text-align:center;overflow:hidden;
      background:#e8e6d9;border-radius:36px;
      box-shadow:0 12px 32px rgba(0,0,0,0.18);
    ">
      <div style="min-height:126px;padding:32px;display:flex;align-items:center;justify-content:center;">
        <p class="${SESSION_LOADING_TITLE_CLASS}">
          Foundry Session Loading
        </p>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:28px;padding:0 40px 48px;">
        <p class="${SESSION_LOADING_SUBTITLE_CLASS}" style="margin:0;width:100%;">
          ${subtitle}
        </p>
        <div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;">
          <div class="board-phaser-session-spinner" aria-hidden="true"></div>
        </div>
        <button type="button" class="${SESSION_LOADING_CANCEL_CLASS}">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector(`.${SESSION_LOADING_CANCEL_CLASS}`)?.addEventListener(
    "click",
    cancelSessionLoadingAndReturnHome,
  );
}

function notifyPlaytableSessionReady() {
  if (typeof window === "undefined") return;
  // Always peel the module DOM loading card — ensurePhaserGameRunning calls this
  // as soon as a Phaser canvas exists, before GameScene.create() runs. Leaving the
  // card up (z-index 100058) blocks the map/HUD even though Phaser is healthy.
  hideSessionLoadingDomOverlay();
  const wasReady = window.__boardPhaserSessionReady === true;
  window.__boardPhaserSessionReady = true;
  if (!wasReady) {
    try {
      window.dispatchEvent(new Event(SESSION_READY_EVENT));
    } catch (e) {
      console.warn("[board-tabletop] session-ready event failed", e);
    }
  }
  try {
    const bridge = window.PlaytableFoundryBridge;
    if (bridge && typeof bridge.onSessionReady === "function") {
      bridge.onSessionReady();
    }
  } catch (e) {
    console.warn("[board-tabletop] PlaytableFoundryBridge.onSessionReady failed", e);
  }
}

if (typeof window !== "undefined" && !window.__boardPhaserSessionReadyHook) {
  window.__boardPhaserSessionReadyHook = true;
  // Bundle-side signalFoundrySessionReady() dispatches this event; only hide DOM
  // here — notifyPlaytableSessionReady() must not be re-entered from the listener.
  window.addEventListener(SESSION_READY_EVENT, () => {
    hideSessionLoadingDomOverlay();
  });
}

/**
 * Foundry opens User Configuration on load when a non-GM user has no assigned
 * character (Game#setupGame). Board clients are always non-GM — assign the first
 * owned actor so the popup does not block the table on every launch.
 * @returns {Promise<boolean>} true when the user has (or was given) a character
 */
async function ensureBoardUserHasCharacter() {
  const user = game.user;
  if (!user?.id || user.isGM || user.character) return true;

  let autoAssign = true;
  try {
    autoAssign = Boolean(
      game.settings.get(MODULE_ID, "autoAssignPlayerCharacter"),
    );
  } catch {
    autoAssign = true;
  }
  if (!autoAssign) return false;

  const ownerLevel =
    CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? CONST.DOCUMENT_PERMISSION_LEVELS?.OWNER ?? 3;

  const owned = game.actors.filter(
    (a) => a.testUserPermission(user, ownerLevel),
  );
  const pick =
    owned.find((a) => a.type === "character") ?? owned[0] ?? null;
  if (!pick) {
    debugLog(
      "Board user has no owned actor — assign a character in Foundry User Management or grant actor ownership",
    );
    return false;
  }

  try {
    await user.update({ character: pick.id });
    debugLog("Auto-assigned Foundry character for board user", {
      user: user.name,
      actor: pick.name,
    });
    return true;
  } catch (e) {
    console.warn("[board-tabletop] Failed to auto-assign user character", e);
    return false;
  }
}

const BOARD_POPUP_SUPPRESS_STYLE_ID = "board-phaser-suppress-popups";
const BOARD_BLOCKING_POPUP_ID_RE =
  /(?:changelog|change-log|release-notes?|whats-new|patch-notes?|update-notes?)/i;
const BOARD_BLOCKING_POPUP_TITLE_RE =
  /(?:change\s*log|release\s*notes?|what'?s\s*new|patch\s*notes?|update\s*notes?)/i;
const BOARD_BLOCKING_POPUP_CLASS_RE =
  /(?:changelog|releasenotes?|whatsnew)/i;

function getApplicationIdentity(app) {
  const id = String(app?.id ?? app?.options?.id ?? "");
  const title = String(
    typeof app?.title === "string"
      ? app.title
      : typeof app?.options?.title === "string"
        ? app.options.title
        : "",
  );
  const className = String(app?.constructor?.name ?? "");
  return { id, title, className };
}

/**
 * Foundry systems/modules often auto-open changelog dialogs after updates.
 * Board clients hide all Foundry chrome — these popups block the table for no benefit.
 */
function isBoardBlockingPopup(app, html) {
  if (!app) return false;

  const UserConfig = foundry.applications?.sheets?.UserConfig;
  if (UserConfig && app instanceof UserConfig) return true;

  const { id, title, className } = getApplicationIdentity(app);
  if (BOARD_BLOCKING_POPUP_ID_RE.test(id)) return true;
  if (BOARD_BLOCKING_POPUP_TITLE_RE.test(title)) return true;
  if (BOARD_BLOCKING_POPUP_CLASS_RE.test(className)) return true;

  const root = html?.[0] ?? html?.element?.[0] ?? html;
  if (root?.classList?.contains("changelog")) return true;
  if (root?.querySelector?.(".changelog, [data-changelog], #changelog")) return true;

  return false;
}

function closeBoardBlockingPopup(app, html) {
  if (!shouldMountPhaser() || !isBoardBlockingPopup(app, html)) return;
  try {
    void app.close({ force: true });
  } catch (e) {
    debugLog("close board-blocking popup failed", e);
  }
}

/** Close User Configuration, changelog dialogs, and similar Foundry popups on Board. */
function dismissBoardBlockingPopups() {
  if (!shouldMountPhaser()) return;

  const instances = foundry.applications?.instances;
  if (instances) {
    for (const app of instances.values()) {
      closeBoardBlockingPopup(app);
    }
  }

  const windows = ui?.windows;
  if (windows) {
    for (const app of Object.values(windows)) {
      closeBoardBlockingPopup(app);
    }
  }
}

function ensureBoardPopupSuppressStyle() {
  if (!shouldMountPhaser() || document.getElementById(BOARD_POPUP_SUPPRESS_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BOARD_POPUP_SUPPRESS_STYLE_ID;
  style.textContent = `
    #lib-changelogs,
    #changelog,
    .application.changelog,
    .app.changelog,
    .window-app.changelog {
      display: none !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

/** Sweep briefly after load — some systems render changelogs after \`ready\`. */
function scheduleBoardPopupDismissSweep() {
  if (!shouldMountPhaser()) return;
  let ticks = 0;
  const timer = setInterval(() => {
    dismissBoardBlockingPopups();
    if (++ticks >= 20) clearInterval(timer);
  }, 500);
}

/**
 * Board input is driven entirely by the SDK + Phaser game; Foundry's own PIXI canvas never needs to
 * respond to pointer events while the board shell is up. Left enabled, its PIXI EventSystem hit-tests
 * the whole scene graph (every token + wall) on each DOM pointer-move the physical board fires during
 * a drag — and that path also pulled in per-move DataModel validation and a `toDataURL`. CPU
 * profiling on the board showed this kept the main thread saturated (~7% idle) during a drag; setting
 * the stage to non-interactive took it to ~52% idle, the difference between ~52fps and a solid 60.
 * Re-applied on every canvasReady because Foundry rebuilds `canvas.stage` (resetting eventMode to
 * "static") on scene change.
 */
function disableFoundryCanvasInteraction() {
  try {
    const stage = canvas?.stage;
    if (!stage) return;
    stage.eventMode = "none";
    stage.interactiveChildren = false;
    debugLog("Foundry canvas interaction disabled (board input drives the game)");
  } catch (e) {
    debugLog("disableFoundryCanvasInteraction failed", { err: String(e) });
  }
}

/**
 * Texture sources of the scene currently on screen. Recomputed on every canvasReady; whatever was
 * in here and is *not* in the new scene's set is what gets unloaded.
 *
 * This deliberately does not try to read the "outgoing" scene at canvasInit — that hook already
 * reports the incoming scene in `canvas.scene`, so comparing there yields a set against itself and
 * releases nothing.
 */
let boardDisplayedSceneTextures = new Set();

/**
 * How long an unused Foundry texture may sit in the cache on the board.
 *
 * Deliberately ~immediate rather than a grace period. expireCache is called with an explicit
 * `exclude` set covering the scene currently on screen, so age is redundant protection — anything
 * the TTL would have spared is either already excluded or genuinely unused. A 60s value was tried
 * first and measured on the board: it fired on only 1 of 6 scene switches (freeing 261MB that
 * once), because switches come every 3-5s and nothing is ever old enough to qualify. The cache
 * still climbed to 892MB and the renderer was OOM-killed. Time-gating the sweep when the pressure
 * is switch-driven simply does not work here.
 */
const BOARD_TEXTURE_CACHE_TTL_MS = 1_000;

/**
 * Enumerate the heavyweight texture sources a scene pulls in — background/foreground art, tiles
 * and token art. Deliberately a subset of Foundry's own loadSceneTextures list: control icons and
 * status effects are small, shared across every scene, and re-fetching them would cost more than
 * it saves.
 */
function collectSceneTextureSources(scene) {
  const out = new Set();
  if (!scene) return out;
  try {
    for (const kind of ["background", "foreground"]) {
      const a = getLevelTextureSrcFromDocs(scene, kind);
      const b = getLevelTextureSrcFromSource(scene, kind);
      if (a) out.add(a);
      if (b) out.add(b);
    }
    const srcBg = scene?._source?.background?.src;
    const srcImg = scene?._source?.img;
    if (srcBg) out.add(srcBg);
    if (srcImg) out.add(srcImg);
    for (const t of scene.tiles ?? []) {
      if (t?.texture?.src) out.add(t.texture.src);
    }
    for (const t of scene.tokens ?? []) {
      if (t?.texture?.src) out.add(t.texture.src);
    }
  } catch (e) {
    debugLog("collectSceneTextureSources failed", { err: String(e) });
  }
  return out;
}

/**
 * Release the previous scene's artwork once the new scene has drawn.
 *
 * Foundry's TextureLoader sizes its cache off `canvas.performance.mode`: ~1.7 GB at its *lowest*
 * setting, ~6.8 GB at the HIGH default (TextureLoader.#MEMORY_LIMITS), against a board with 3.3 GB
 * of total system RAM. So the memory ceiling is never reached and nothing is ever evicted. The TTL
 * sweep only considers assets untouched for 15 minutes, which a scene-switching session never
 * reaches, and neutralizeFoundryCanvas() stops the ticker, which also disables PIXI's own
 * ticker-driven texture GC. Every scene change therefore added ~50-150 MB that was never given
 * back until lowmemorykiller took the WebView renderer down with it.
 *
 * An earlier attempt stubbed TextureLoader so nothing was ever loaded. That did stop the growth,
 * but Foundry's Canvas#draw threw partway through on the resulting null textures, so
 * `canvas.pendingRenderFlags` and `canvas.visibility.vision` were never created — tokens still
 * synced (they are document-driven) but fog and vision were dead and every later render-flag set
 * threw. Hence this approach instead: let Foundry draw normally and reclaim afterwards, using only
 * the public PIXI.Assets.unload so the draw path is never touched.
 */
/** The scene's heavyweight non-token art: background, foreground, tiles. */
function collectSceneBigArtSources(scene) {
  const out = new Set();
  if (!scene) return out;
  try {
    for (const kind of ["background", "foreground"]) {
      const a = getLevelTextureSrcFromDocs(scene, kind);
      const b = getLevelTextureSrcFromSource(scene, kind);
      if (a) out.add(a);
      if (b) out.add(b);
    }
    const srcBg = scene?._source?.background?.src;
    const srcImg = scene?._source?.img;
    if (srcBg) out.add(srcBg);
    if (srcImg) out.add(srcImg);
    for (const t of scene.tiles ?? []) {
      if (t?.texture?.src) out.add(t.texture.src);
    }
  } catch (e) {
    debugLog("collectSceneBigArtSources failed", { err: String(e) });
  }
  return out;
}

async function releasePreviousSceneTextures(phase) {
  const mb = (b) => (typeof b === "number" ? (b / 1048576).toFixed(1) : "?");
  const TextureLoader = globalThis.foundry?.canvas?.TextureLoader;
  if (!TextureLoader?.loader) return;

  const usage = () => {
    try {
      return TextureLoader.approximateTotalMemoryUsage;
    } catch (_) {
      return undefined;
    }
  };
  const before = usage();

  // Keep whatever the scene now on screen needs; everything else is fair game. expireCache walks
  // Foundry's own cache bookkeeping, so it covers assets this module never enumerates (door
  // textures, control icons, status effects) rather than only the ones we can name.
  const keep = collectSceneTextureSources(canvas?.scene);
  boardDisplayedSceneTextures = keep;

  try {
    await TextureLoader.loader.expireCache({ exclude: keep });
  } catch (e) {
    console.warn("[board-tabletop mem] expireCache failed", e);
  }

  const after = usage();
  // Unconditional (not debugLog, which is compiled out by DEBUG=false) — this is the only
  // instrument we have for whether the board's texture memory is actually being reclaimed.
  console.info(
    `[board-tabletop mem] scene texture release (${phase}): kept ${keep.size} sources` +
      ` | Foundry cache ${mb(before)}MB -> ${mb(after)}MB` +
      ` (freed ${mb((before ?? 0) - (after ?? 0))}MB, ttl=${TextureLoader.CACHE_TTL}ms)`,
  );
}

/**
 * Once the scene has drawn, the hidden Foundry canvas no longer needs its own copy of the big
 * art — the board renders the map from Phaser's tiles, Foundry's ticker is stopped and its
 * canvas display:none, so the just-drawn background/foreground/tile textures are never rendered
 * again. They are also the dominant residency: a native-res background alone is 100-400MB
 * decoded. Token art stays — Foundry's document-update paths still touch it, and it's small.
 *
 * NOT run at canvasReady directly: the game tiles its map straight from PIXI's decoded source
 * (see getSceneBackgroundImageSource on the bridge), so unloading here would close the bitmap
 * mid-tiling. The game calls consumeSceneArt() when its tiles are built; a fallback timer covers
 * paths where no consume ever arrives (load failure, scene with no board client active).
 */
let sceneArtFallbackTimer = null;

async function releaseCurrentSceneBigArt(reason) {
  const mb = (b) => (typeof b === "number" ? (b / 1048576).toFixed(1) : "?");
  const TextureLoader = globalThis.foundry?.canvas?.TextureLoader;
  const usage = () => {
    try {
      return TextureLoader?.approximateTotalMemoryUsage;
    } catch (_) {
      return undefined;
    }
  };
  const before = usage();
  let dropped = 0;
  for (const src of collectSceneBigArtSources(canvas?.scene)) {
    try {
      await PIXI.Assets.unload(src);
      dropped++;
    } catch (_) {
      // Miss is fine — not every recorded source necessarily entered PIXI's cache.
    }
  }
  if (dropped) {
    console.info(
      `[board-tabletop mem] big-art release (${reason}): dropped ${dropped}` +
        ` | Foundry cache ${mb(before)}MB -> ${mb(usage())}MB`,
    );
  }
}

function armSceneArtFallbackRelease(sceneId) {
  if (sceneArtFallbackTimer) clearTimeout(sceneArtFallbackTimer);
  sceneArtFallbackTimer = setTimeout(() => {
    sceneArtFallbackTimer = null;
    // Only fire for the scene it was armed for — after a further switch the canvasInit sweep
    // already handled the old art, and this must not unload the NEW scene's mid-load bitmap.
    if (canvas?.scene?.id !== sceneId) return;
    void releaseCurrentSceneBigArt("fallback-timer");
  }, 20_000);
}

function consumeSceneArtNow(sceneId) {
  // A stale consume (game finished tiling scene A after the GM already switched to scene B) must
  // not unload B's art mid-load; A's art is handled by the canvasInit sweep of the next switch.
  if (sceneId && canvas?.scene?.id !== sceneId) return;
  if (sceneArtFallbackTimer) {
    clearTimeout(sceneArtFallbackTimer);
    sceneArtFallbackTimer = null;
  }
  void releaseCurrentSceneBigArt("consumed-by-game");
}

/**
 * Foundry expires cached textures only after they have gone untouched for CACHE_TTL, which ships
 * as 15 minutes — far longer than a scene-switching session ever idles, so the sweep never fires.
 * Its other eviction path is a memory ceiling derived from canvas.performance.mode, and even the
 * LOW setting is ~1.7 GB against this board's 3.3 GB of total RAM, so that never triggers either.
 * Measured on the board, the cache climbed 0 -> 1528 MB over ~12 scene switches and the WebView
 * renderer was OOM-killed ("kill (OOM or update)") before Foundry considered evicting anything.
 *
 * CACHE_TTL is a writable public static, so shortening it is enough to make the existing sweep do
 * its job on each scene change. 60s is comfortably longer than a transition, so the scene being
 * drawn is never a candidate, while anything left from earlier scenes is.
 */
/**
 * Cap how many textures Foundry fetches+decodes at once. Canvas#draw loads every scene source in
 * one unbounded Promise.allSettled burst — a tile-heavy scene (Map7p2: 19 sources incl. a
 * 6300x8190 background) meant several hundred MB of concurrent decode transients. The WebView
 * renderer is a 32-bit process ("ABI: arm" in its crash dumps), so after a few big-map cycles its
 * fragmented address space fails one of those allocations and Chromium OOM-aborts (SIGTRAP) even
 * with system RAM free. loadSceneTextures already supports maxConcurrent; Foundry just never
 * sets it. 2 keeps small assets pipelined while ensuring at most two decodes coexist.
 */
function limitFoundryTextureLoadConcurrency(TextureLoader) {
  if (globalThis.__boardPhaserTextureConcurrencyLimited) return;
  if (typeof TextureLoader?.loadSceneTextures !== "function") return;
  try {
    const orig = TextureLoader.loadSceneTextures.bind(TextureLoader);
    TextureLoader.loadSceneTextures = (scene, options = {}) =>
      orig(scene, { maxConcurrent: 2, ...options });
    globalThis.__boardPhaserTextureConcurrencyLimited = true;
    console.info("[board-tabletop] Foundry texture load concurrency capped at 2");
  } catch (e) {
    console.warn("[board-tabletop] limitFoundryTextureLoadConcurrency failed", e);
  }
}

function tightenFoundryTextureCacheTtl() {
  try {
    const TextureLoader = globalThis.foundry?.canvas?.TextureLoader;
    if (!TextureLoader) return;
    pinSharedFoundryTextures(TextureLoader);
    limitFoundryTextureLoadConcurrency(TextureLoader);
    if (TextureLoader.CACHE_TTL <= BOARD_TEXTURE_CACHE_TTL_MS) return;
    TextureLoader.CACHE_TTL = BOARD_TEXTURE_CACHE_TTL_MS;
    console.info(
      `[board-tabletop] Foundry texture CACHE_TTL tightened to ${BOARD_TEXTURE_CACHE_TTL_MS}ms`,
    );
  } catch (e) {
    console.warn("[board-tabletop] tightenFoundryTextureCacheTtl failed", e);
  }
}

/**
 * Pin the small assets Foundry shares across every scene — control icons, status effect icons and
 * the token ring spritesheet. They are individually tiny but numerous, and with the near-immediate
 * TTL above they would otherwise be evicted and re-fetched on every single scene change. pinSource
 * is Foundry's own mechanism for this and expireCache skips pinned entries, so the sweep is left
 * to reclaim only the large per-scene artwork that actually drives the memory growth.
 */
function pinSharedFoundryTextures(TextureLoader) {
  if (globalThis.__boardPhaserSharedTexturesPinned) return;
  if (typeof TextureLoader?.pinSource !== "function") return;
  let pinned = 0;
  const pin = (src) => {
    if (typeof src !== "string" || !src) return;
    try {
      TextureLoader.pinSource(src);
      pinned++;
    } catch (_) {
      /* best-effort */
    }
  };
  try {
    for (const src of Object.values(CONFIG?.controlIcons ?? {})) pin(src);
    for (const e of Object.values(CONFIG?.statusEffects ?? {})) pin(e?.img);
    pin(CONFIG?.Token?.ring?.spritesheet);
    globalThis.__boardPhaserSharedTexturesPinned = true;
    console.info(`[board-tabletop] pinned ${pinned} shared Foundry textures`);
  } catch (e) {
    console.warn("[board-tabletop] pinSharedFoundryTextures failed", e);
  }
}

/**
 * Unconditional memory sample. `TextureLoader.approximateTotalMemoryUsage` only accounts for
 * Foundry's own texture cache; `performance.memory` (Chromium-only) covers the JS heap, which is
 * where a Phaser-side leak would show instead. Logging both lets one scene-switch trace attribute
 * the growth to a side rather than leaving it to inference.
 */
function logBoardMemorySample(label) {
  try {
    const mb = (b) => (typeof b === "number" ? (b / 1048576).toFixed(1) : "?");
    const tex = globalThis.foundry?.canvas?.TextureLoader?.approximateTotalMemoryUsage;
    const perf = performance?.memory;
    console.info(
      `[board-tabletop mem] ${label} | foundryTextures=${mb(tex)}MB` +
        ` jsHeap=${mb(perf?.usedJSHeapSize)}/${mb(perf?.totalJSHeapSize)}MB` +
        ` limit=${mb(perf?.jsHeapSizeLimit)}MB` +
        ` scene=${canvas?.scene?.id ?? "none"}`,
    );
  } catch (e) {
    console.warn("[board-tabletop mem] sample failed", e);
  }
}

/**
 * Foundry sizes several caches and effects off `canvas.performance.mode`, which it auto-detects
 * from the GPU and happily reports as HIGH on this board's Mali. LOW additionally turns off linear
 * filtering by default and reduces blur work. Applied on every canvasInit because Foundry
 * recomputes the mode when it reconfigures the canvas.
 */
function forceLowCanvasPerformanceMode() {
  try {
    const low = CONST?.CANVAS_PERFORMANCE_MODES?.LOW;
    if (low === undefined || !canvas?.performance) return;
    if (canvas.performance.mode === low) return;
    canvas.performance.mode = low;
    debugLog("Foundry canvas performance mode forced to LOW");
  } catch (e) {
    debugLog("forceLowCanvasPerformanceMode failed", { err: String(e) });
  }
}

/**
 * Tear down Foundry's PIXI/WebGL canvas so Phaser can claim the GPU with WEBGL.
 * Do NOT call renderer.destroy() or mutate canvas.width/height — both throw
 * DOMException on Android WebView and abort mountPhaserShell before this flag is set.
 *
 * `loseContext()` is deferred until Foundry's initial canvas draw settles — calling
 * it while Foundry is still drawing overlay layers (e.g. "Preparing the Overlay")
 * can crash the Android WebView GPU process.
 */
function releaseFoundryWebGlContexts() {
  for (const el of document.querySelectorAll(
    "#board canvas, canvas#board, #board-hud canvas",
  )) {
    if (!(el instanceof HTMLCanvasElement)) continue;
    try {
      const gl = el.getContext("webgl2") || el.getContext("webgl");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch (_) {
      /* ignore */
    }
  }
}

function scheduleReleaseFoundryWebGlContexts() {
  if (globalThis.__boardPhaserWebGlReleaseScheduled) return;
  globalThis.__boardPhaserWebGlReleaseScheduled = true;

  const run = () => {
    if (globalThis.__boardPhaserWebGlReleased) return;
    globalThis.__boardPhaserWebGlReleased = true;
    releaseFoundryWebGlContexts();
  };

  const milestone = String(globalThis.__boardPhaserLoadingMilestone ?? "");
  const overlayStillDrawing = /preparing the overlay/i.test(milestone);

  const schedule = (delayMs = 0) => {
    globalThis.setTimeout(run, delayMs);
  };

  if (game?.ready && !overlayStillDrawing) {
    schedule(0);
    return;
  }

  try {
    Hooks.once("ready", () => schedule(overlayStillDrawing ? 500 : 0));
  } catch (_) {
  }
  schedule(overlayStillDrawing ? 1500 : 250);
  schedule(8000);
}

function neutralizeFoundryCanvas() {
  if (globalThis.__boardPhaserFoundryCanvasNeutralized) return;

  try {
    if (canvas?.app?.ticker) {
      canvas.app.ticker.stop();
      canvas.app.ticker.autoStart = false;
    }
  } catch (e) {
    console.warn("[board-tabletop] Foundry ticker stop failed", e);
  }

  try {
    disableFoundryCanvasInteraction();
  } catch (_) {
    /* ignore */
  }

  for (const el of document.querySelectorAll(
    "#board canvas, canvas#board, #board-hud canvas",
  )) {
    if (!(el instanceof HTMLCanvasElement)) continue;
    try {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
    } catch (_) {
      /* ignore */
    }
  }

  for (const el of document.querySelectorAll("#board, #board-hud")) {
    try {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
    } catch (_) {
      /* ignore */
    }
  }

  scheduleReleaseFoundryWebGlContexts();

  globalThis.__boardPhaserFoundryCanvasNeutralized = true;
  console.info("[board-tabletop] Foundry canvas neutralized for Phaser WEBGL");
}

function ensureHideFoundryUiStyle() {
  const css = `
    /* Nuke ALL Foundry chrome. Only our own mounts (#game, #ui) and our
       session-loading overlay may show. This catches every Foundry version's
       UI containers (#interface, #hud, #controls, notifications, tooltips,
       dialogs, ApplicationV2 windows, chat, pause banner, logo, etc.) without
       needing to enumerate each id. */
    body > *:not(#game):not(#ui):not(#board-phaser-session-loading):not([data-board-phaser]):not([data-board-piece-binding]):not(script):not(style):not(link) {
      display: none !important;
    }
    /* Belt-and-suspenders explicit hides in case markup is nested. */
    #interface, #ui-left, #ui-top, #ui-bottom, #ui-right, #ui-middle,
    #players, #hotbar, #navigation, #scene-navigation, #sidebar, #menu,
    #controls, #scene-controls, #hud, #measurement, #hearbeat, #logo,
    #notifications, #chat, #chat-notifications, #tooltip, #context-menu,
    #camera-views, #pause, #fps, #players-active, .notification, .app.window-app,
    .application, dialog:not([data-board-phaser]) { display: none !important; }
    #board, #board-hud, canvas#board {
      display: none !important;
      visibility: hidden !important;
      width: 0 !important;
      height: 0 !important;
      pointer-events: none !important;
    }
    /* Foundry scene-loading ApplicationV2 popup ("Preparing the Overlay", etc.) */
    #loading, #scene-loading, #loading-progress, .loading-screen,
    .application.loading, dialog.scene-loading { display: none !important; }
  `;
  let hide = document.getElementById("board-phaser-hide-foundry-ui");
  if (!hide) {
    hide = document.createElement("style");
    hide.id = "board-phaser-hide-foundry-ui";
    document.head.appendChild(hide);
  }
  hide.textContent = css;
}

/**
 * Mount Phaser even if `canvasReady` never fires. Foundry's `Canvas#draw()` can throw
 * before `canvasReady` when the scene background exceeds the device's WebGL max texture
 * size (e.g. a 6000x4200 map on a 4096-max GPU) — leaving the loading popup stranded at
 * "Preparing the Overlay". The Board hides Foundry's canvas, stops its ticker, and reads
 * scene data from documents (loading the map itself at a downscaled cap), so it does not
 * depend on Foundry's own canvas succeeding. This fallback recovers from that failure.
 */
function scheduleMountFallback() {
  if (!shouldMountPhaser()) return;
  if (globalThis.__boardPhaserMountFallbackScheduled) return;
  globalThis.__boardPhaserMountFallbackScheduled = true;
  let attempts = 0;
  const timer = globalThis.setInterval(() => {
    if (state.phaserMounted) {
      globalThis.clearInterval(timer);
      return;
    }
    attempts++;
    // Give a legitimately slow (but successful) draw a few seconds before forcing it.
    if (!canvas?.ready && attempts < 4) return;
    if (!isInFoundryGameWorld()) return;
    globalThis.clearInterval(timer);
    try {
      console.warn(
        "[board-tabletop] mounting Phaser via ready fallback (canvasReady=" +
          !!canvas?.ready + ", attempts=" + attempts + ")",
      );
      setBootStage("phaser_mount_fallback");
      tryMountPhaserShellOnWorldEntry();
    } catch (err) {
      console.error("[board-tabletop] fallback mountPhaserShell failed", err);
    }
  }, 1000);
}

function mountPhaserShell() {
  if (state.phaserMounted) return;
  state.phaserMounted = true;
  setBootStage("phaser_shell_mounting");
  installBootWatchdog();

  // Neutralize Foundry's GPU surface first — must run even if later DOM steps throw.
  neutralizeFoundryCanvas();

  try {
    if (isInFoundryGameWorld()) {
      signalFoundryPlayerLoggedIn();
    }
    showSessionLoadingDomOverlay();
    ensureHideFoundryUiStyle();

    const GAME_SURFACE_Z = 2000000000;
    const UI_SURFACE_Z = 2000000001;

    let mount = document.getElementById("game");
    if (!mount) {
      mount = document.createElement("div");
      mount.id = "game";
      mount.style.cssText =
        `position:fixed;inset:0;width:100vw;height:100vh;z-index:${GAME_SURFACE_Z};touch-action:none;`;
      document.body.appendChild(mount);
    } else {
      mount.style.cssText =
        `position:fixed;inset:0;width:100vw;height:100vh;z-index:${GAME_SURFACE_Z};touch-action:none;`;
    }

    let uiMount = document.getElementById("ui");
    if (!uiMount) {
      uiMount = document.createElement("div");
      uiMount.id = "ui";
      uiMount.style.cssText =
        `position:fixed;inset:0;z-index:${UI_SURFACE_Z};pointer-events:none;`;
      document.body.appendChild(uiMount);
    } else {
      uiMount.style.cssText =
        `position:fixed;inset:0;z-index:${UI_SURFACE_Z};pointer-events:none;`;
    }

    ensurePhaserGameStylesheet("mount_shell");
    void loadPhaserGameBundle("mount_shell");
  } catch (err) {
    console.error(
      "[board-tabletop] mountPhaserShell DOM setup failed",
      err?.message ?? err,
      err,
    );
    ensureHideFoundryUiStyle();
    void loadPhaserGameBundle("mount_shell_recovery");
  }

  globalThis.setTimeout(() => {
    if (!globalThis.__boardPhaserBundleLoaded && state.phaserMounted) {
      console.error("[board-tabletop] Phaser bundle import timeout:", phaserBundleImportUrl());
      setBootStage("phaser_bundle_timeout");
      void retryPhaserGameBundle("import_timeout");
    }
  }, 8_000);
}

Hooks.once("init", () => {
  // Unconditional (not behind DEBUG) so we can always confirm the deployed build.
  console.log(
    `[board-tabletop] module build ${MODULE_BUILD_VERSION} initializing (Foundry ${game?.version ?? "?"})`,
  );
  installFoundryLoadingMilestoneTracker();
  game.settings.register(MODULE_ID, "pieceAssignments", {
    name: "Board piece ↔ token assignments",
    scope: "world",
    config: false,
    type: Object,
    default: { slots: DEFAULT_PIECE_SLOTS, map: {} },
  });
  game.settings.register(MODULE_ID, "autoAssignPlayerCharacter", {
    name: "Auto-assign character for Board players",
    hint:
      "When a player joins without a selected character, assign the first actor they own so Foundry does not open User Configuration on every launch. Disable if players should pick their character manually in Foundry.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, "movementMode", {
    name: "Board physical piece movement",
    hint:
      "How the GM validates Board piece drags on Foundry tokens. Disabled blocks all moves; Combat enforces walls plus movement limits during combat (actor walk speed when available); Free enforces walls only.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      disabled: "No movement",
      combat: "Combat movement (walls + limits)",
      free: "Free movement (walls only)",
    },
    default: DEFAULT_MOVEMENT_MODE,
  });
  game.settings.register(MODULE_ID, "maxMoveGridSquares", {
    name: "Board max move distance (grid squares)",
    hint:
      "Used in Combat mode when not in an active combat, or when the actor has no walk speed. Distance is measured from the token's current position in grid units.",
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULT_MAX_MOVE_GRID_SQUARES,
    range: { min: 1, max: 99, step: 1 },
  });
  installGlobalBridge();
});

Hooks.once("setupGame", async () => {
  if (!shouldMountPhaser()) return;
  await ensureBoardUserHasCharacter();
});

function tryMountPhaserShellOnWorldEntry() {
  if (!shouldMountPhaser() || state.phaserMounted) return;
  try {
    neutralizeFoundryCanvas();
    mountPhaserShell();
    disableFoundryCanvasInteraction();
    scheduleSceneBridgeRefresh();
    ensureSceneBridgeWatchdog();
    scheduleTokensRefresh();
  } catch (err) {
    console.error("[board-tabletop] mount on world entry failed", err);
  }
}

/**
 * Board hardware WebView: when the player leaves a Foundry world (Log Out, Return to
 * Setup, etc.), notify Playtable via boardvtt://exit-world so the app returns to its menu.
 * Also mounts the Phaser shell when the player navigates onto /game after /join.
 */
function installBoardWorldExitNotifier() {
  if (!isBoardDevice() || globalThis.__boardPhaserExitNotifierInstalled) return;
  globalThis.__boardPhaserExitNotifierInstalled = true;
  globalThis.__boardPhaserWasInWorld = false;
  globalThis.__boardPhaserExitSignaled = false;

  const isInWorldPath = () => {
    const path = globalThis.location?.pathname ?? "";
    return path.includes("/game");
  };

  const notifyBoardWorldExit = () => {
    if (globalThis.__boardPhaserExitSignaled) return;
    globalThis.__boardPhaserExitSignaled = true;
    debugLog("Player left Foundry world — signaling Board app exit");
    try {
      globalThis.location.href = "boardvtt://exit-world";
    } catch (e) {
      debugLog("boardvtt exit-world navigation failed", e);
    }
  };

  const syncWorldPathState = () => {
    if (isInWorldPath()) {
      globalThis.__boardPhaserWasInWorld = true;
      ensureBoardSessionLoadingOverlay();
      tryMountPhaserShellOnWorldEntry();
      return;
    }
    if (globalThis.__boardPhaserWasInWorld) {
      globalThis.__boardPhaserWasInWorld = false;
      notifyBoardWorldExit();
    }
  };

  const wrapHistory = () => {
    const { history } = globalThis;
    if (!history || history.__boardPhaserPatched) return;
    history.__boardPhaserPatched = true;
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (...args) => {
      origPush(...args);
      syncWorldPathState();
    };
    history.replaceState = (...args) => {
      origReplace(...args);
      syncWorldPathState();
    };
    globalThis.addEventListener("popstate", syncWorldPathState);
  };

  wrapHistory();
  globalThis.setInterval(syncWorldPathState, 2000);

  Hooks.once("ready", () => {
    if (isInWorldPath()) globalThis.__boardPhaserWasInWorld = true;
    if (typeof game?.logOut === "function") {
      const origLogOut = game.logOut.bind(game);
      game.logOut = async (...args) => {
        notifyBoardWorldExit();
        return origLogOut(...args);
      };
    }
    if (typeof game?.shutDown === "function") {
      const origShutDown = game.shutDown.bind(game);
      game.shutDown = async (...args) => {
        notifyBoardWorldExit();
        return origShutDown(...args);
      };
    }
  });
}

Hooks.once("ready", () => {
  game.socket.on(SOCKET_EVENT, onSocketData);
  // Seed pause state so a Board connecting into an already-paused world shows it.
  state.lastPaused = !!game.paused;
  applyPausedState();
  try {
    cachedPieceAssignments = normalizePieceAssignments(
      game.settings.get(MODULE_ID, "pieceAssignments") ?? {},
    );
  } catch (e) {
    debugLog("pieceAssignments init read failed", e);
  }
  if (isBoardDevice()) {
    installBoardWorldExitNotifier();
    ensureBoardSessionLoadingOverlay();
  }
  if (shouldMountPhaser()) {
    // Phaser shell + module DOM overlay (mountPhaserShell) cover initial boot.
    // Do not re-show here — Foundry's ready hook fires after the world is up and
    // would flash the loading dialog on top of playable gameplay.
    ensureBoardPopupSuppressStyle();
    dismissBoardBlockingPopups();
    scheduleBoardPopupDismissSweep();
    if (canvas?.ready) {
      try {
        tryMountPhaserShellOnWorldEntry();
      } catch (err) {
        console.error("[board-tabletop] mountPhaserShell on ready failed", err);
      }
    } else {
      // canvasReady may never fire if Foundry's canvas draw fails on an oversize
      // scene background — mount Phaser anyway so the Board is never stranded.
      scheduleMountFallback();
    }
  }
});

/** Close User Configuration / changelog dialogs as soon as they render on Board. */
Hooks.on("renderApplicationV2", (app, element) => {
  closeBoardBlockingPopup(app, element);
});

Hooks.on("renderApplicationV1", (app, html) => {
  closeBoardBlockingPopup(app, html);
});

/** Fallback if User Configuration still renders before character assignment applies. */
Hooks.on("renderUserConfig", (app, html) => {
  closeBoardBlockingPopup(app, html);
});

Hooks.on("canvasReady", () => {
  debugLog("Hook: canvasReady", { sceneId: canvas?.scene?.id ?? null });
  setBootStage("canvas_ready");
  if (shouldMountPhaser()) {
    // Unload Foundry's copy of the scene art FIRST, then let the (gated) bridge refresh hand the
    // map to Phaser — this is the serialization that keeps the two native-res decodes from ever
    // coexisting. The refresh below is scheduled with a delay, so kicking the unload off here is
    // enough ordering; a second refresh is chained after the unload settles as a belt-and-braces.
    void releasePreviousSceneTextures("canvasReady").then(() => {
      logBoardMemorySample("canvasReady (settled)");
      scheduleSceneBridgeRefresh();
    });
    // Big art is released when the game reports its tiles are built (consumeSceneArt), or by
    // this fallback if that never happens.
    armSceneArtFallbackRelease(canvas?.scene?.id ?? null);
  }
  try {
    sceneTransitioning = true;
    scheduleSceneBridgeRefresh();
    scheduleTokensRefresh();
    ensureSceneBridgeWatchdog();
    installGmPointerTracking();
    queueTransitionRelease(300);
    if (game.user?.isGM) {
      state.lastFogExploredBase64 = null;
      debugLog("[board-tabletop fog] canvasReady -> initial GM fog emit");
      void emitFogUpdateNow();
    }
  } catch (err) {
    console.error("[board-tabletop] canvasReady setup failed", err);
  }

  if (shouldMountPhaser()) {
    try {
      tryMountPhaserShellOnWorldEntry();
    } catch (err) {
      console.error("[board-tabletop] mountPhaserShell failed", err);
      void loadPhaserGameBundle("canvas_ready_recovery");
    }
  }
});

/* GM vision recompute drives the GM's (legacy) socket emit; the Board computes fog itself. */
Hooks.on("sightRefresh", () => {
  if (game.user?.isGM) scheduleFogEmit();
});

/* Scene initialization (fires when the canvas is prepared for a scene). */
Hooks.on("canvasInit", () => {
  debugLog("Hook: canvasInit", { sceneId: canvas?.scene?.id ?? null });
  if (shouldMountPhaser()) {
    logBoardMemorySample("canvasInit");
    // Earliest reliable signal that a scene switch is underway (canvas.scene here is already the
    // incoming scene) — tell the game now so it can cover the stage instead of leaving the old
    // scene on screen through Foundry's transition + bridge retries + debounce.
    notifySceneTransitionStart(canvas?.scene?.id ?? null);
    // Evict the OUTGOING scene's art NOW, before Foundry downloads the incoming scene's. The
    // canvasReady sweep ran after the new art had loaded, so at the moment of every switch the
    // old scene's 400-600MB coexisted with two native-res decodes of the new background (PIXI +
    // Phaser). That transient peak — not steady-state growth — is what OOM-killed the renderer
    // while loading a large map. Everything of the old scene is >1s idle here, so the TTL sweep
    // takes all of it; the incoming scene's sources are excluded and unaffected.
    void releasePreviousSceneTextures("canvasInit");
    // Re-applied here because Foundry reconstructs the loader state across scene changes.
    tightenFoundryTextureCacheTtl();
    forceLowCanvasPerformanceMode();
  }
  sceneTransitioning = true;
  scheduleSceneBridgeRefresh();
  scheduleTokensRefresh();
  // Clear stale fog from previous scene; next sightRefresh will repopulate.
  state.lastFogUpdate = null;
  state.lastFogExploredBase64 = null;
  notifyFogListeners(null);
  // Hard fallback release; do not require canvas.ready, otherwise lock can stick.
  queueTransitionRelease(1800);
});

/* Local client is about to view a different scene (navigation). */
Hooks.on("viewScene", () => {
  debugLog("Hook: viewScene", { sceneId: canvas?.scene?.id ?? null });
  sceneTransitioning = true;
  scheduleSceneBridgeRefresh();
  scheduleTokensRefresh();
  // Hard fallback release; do not require canvas.ready, otherwise lock can stick.
  queueTransitionRelease(1800);
});

/* Active Scene document changed while it is the viewed scene (e.g. background path). */
Hooks.on("updateScene", (scene) => {
  if (scene?.id && canvas?.scene?.id === scene.id) {
    debugLog("Hook: updateScene (active)", { sceneId: scene.id });
    debouncedActiveSceneUpdate();
  }
});

/* Server-wide pause toggled (fires on every client, GM or not). On the Board, show our
   own "Game Paused" banner and freeze piece moves (reportGlyphState checks state.lastPaused). */
Hooks.on("pauseGame", (paused) => {
  state.lastPaused = !!paused;
  debugLog("Hook: pauseGame", { paused: state.lastPaused });
  applyPausedState();
});

["updateToken", "createToken", "deleteToken", "refreshToken", "updateActor"].forEach((name) => {
  Hooks.on(name, (doc, change) => {
    // Guard the whole payload build behind DEBUG — `refreshToken` fires every
    // frame during token animation, and JSON.stringify(change) + shipping a
    // console line to Android logcat per fire stalls the board's boot for seconds.
    if (DEBUG) {
      debugLog("tokens", name, {
        isGM: !!game.user?.isGM,
        docId: doc?.id ?? doc?._id ?? null,
        "doc.x": doc?.x ?? null,
        "doc.y": doc?.y ?? null,
        "doc._source.x": doc?._source?.x ?? null,
        "doc._source.y": doc?._source?.y ?? null,
        "change.x": change?.x ?? null,
        "change.y": change?.y ?? null,
        changeJson: change ? JSON.stringify(change) : null,
      });
    }
    scheduleTokensRefresh();
  });
});
