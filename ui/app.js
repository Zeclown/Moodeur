"use strict";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);
const ALL_EXTENSIONS = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS];
const SAVE_DELAY = 500;
const HISTORY_LIMIT = 100;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const NOTE_PAPER_COLORS = [
  { value: "#fff4b8", label: "Butter" },
  { value: "#f2c3c9", label: "Rose" },
  { value: "#cde4c1", label: "Mint" },
  { value: "#c8d9ee", label: "Sky" },
  { value: "#dccbed", label: "Lavender" },
  { value: "#f2cfaa", label: "Peach" },
];
const DEFAULT_NOTE_PAPER = NOTE_PAPER_COLORS[0].value;
const DEFAULT_BACKGROUND = { color: "#d6d2bc", pattern: "stipple" };
const BACKGROUND_COLORS = [
  { value: "#d6d2bc", label: "Warm Gray" },
  { value: "#e6ddbd", label: "Parchment" },
  { value: "#d5b9b5", label: "Dusty Rose" },
  { value: "#bcc9ae", label: "Sage" },
  { value: "#b8c9d6", label: "Powder Blue" },
  { value: "#c6bad3", label: "Lavender" },
  { value: "#353545", label: "Charcoal" },
];
const BACKGROUND_PATTERNS = [
  { value: "stipple", label: "Stipple", description: "Classic Moodeur dots" },
  { value: "graph-grid", label: "Graph Grid", description: "Squared drafting paper" },
  { value: "ruled-paper", label: "Ruled Paper", description: "Horizontal notebook lines" },
  { value: "checkerboard", label: "Checkerboard", description: "Soft alternating tiles" },
  { value: "plain", label: "Plain", description: "Color with no pattern" },
];
const MARKER_COLORS = [
  { value: "#b51f2e", label: "Marker Red" },
  { value: "#1739ae", label: "Cobalt" },
  { value: "#287052", label: "Forest" },
  { value: "#b58b18", label: "Mustard" },
  { value: "#6b3e75", label: "Plum" },
  { value: "#25232d", label: "Ink Black" },
];
const MARKER_WIDTH = 6;
const ERASER_WIDTH = 18;
const DRAWING_SAMPLE_PIXELS = 3;
const DRAWING_TILE_SIZE = 512;
const DRAWING_TILE_SCALE = 2;
const MAX_DRAWING_OPERATIONS = 10_000;
const MAX_POINTS_PER_DRAWING = 50_000;
const MAX_BOARD_DRAWING_POINTS = 500_000;
const INTERNAL_CLIPBOARD_TYPE = "application/x-moodeur-cards";
const PRESENTATION_MAX_ZOOM = 2.5;
const PRESENTATION_PADDING = 72;
const PRESENTATION_CONTROL_HIDE_DELAY = 2200;
const PRESENTATION_SOUNDTRACK_FADE_MS = 1250;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const uid = () => crypto.randomUUID();

const elements = {
  app: $("#app"),
  canvas: $("#canvas-viewport"),
  world: $("#canvas-world"),
  marquee: $("#selection-marquee"),
  emptyHint: $("#empty-hint"),
  dropOverlay: $("#drop-overlay"),
  startTape: $("#start-tape"),
  presentationControls: $("#presentation-controls"),
  presentationCounter: $("#presentation-counter"),
  welcome: $("#welcome-dialog"),
  recentBoardList: $("#recent-board-list"),
  youtubeDialog: $("#youtube-dialog"),
  youtubeForm: $("#youtube-form"),
  youtubeUrl: $("#youtube-url"),
  youtubePermission: $("#youtube-permission"),
  youtubeProgressBox: $("#youtube-progress-box"),
  youtubeProgress: $("#youtube-progress"),
  youtubeProgressStatus: $("#youtube-progress-status"),
  youtubeCancel: $("#youtube-cancel"),
  youtubeSubmit: $("#youtube-submit"),
  youtubeClose: $("#youtube-close"),
  titleDialog: $("#title-dialog"),
  titleForm: $("#title-form"),
  titleInput: $("#board-title-input"),
  confirmDialog: $("#confirm-dialog"),
  confirmTitle: $("#confirm-title"),
  confirmMessage: $("#confirm-message"),
  windowTitle: $("#window-title"),
  boardFolder: $("#board-folder"),
  zoomOutput: $("#zoom-output"),
  saveStatus: $("#save-status"),
  selectionStatus: $("#selection-status"),
  pointerStatus: $("#pointer-status"),
  noSelection: $("#no-selection"),
  inspectorContent: $("#inspector-content"),
  backgroundContent: $("#background-content"),
  queueList: $("#queue-list"),
  queueCount: $("#queue-count"),
  queuePlayToggle: $("#queue-play-toggle"),
  queueShuffle: $("#queue-shuffle"),
  toastStack: $("#toast-stack"),
};

const state = {
  boardPath: null,
  document: null,
  assetUrls: new Map(),
  selectedId: null,
  selectedIds: new Set(),
  history: [],
  future: [],
  internalClipboard: null,
  saveTimer: null,
  saveInFlight: false,
  saveQueued: false,
  dirty: false,
  spaceHeld: false,
  interaction: null,
  youtubeDownloading: false,
  youtubePlacement: null,
  lastPointerBoard: null,
  lastItemClick: null,
  lastRotateHandlePress: null,
  drawingTool: "select",
  markerColor: MARKER_COLORS[0].value,
  drawingRenderFrame: null,
  dirtyDrawingTargets: new Set(),
  dragDepth: 0,
  presentation: null,
  presentationControlTimer: null,
};

const player = new Audio();
player.preload = "metadata";
let currentTrackId = null;
let playingQueue = false;
let queuePlaybackOrder = [];
const failedQueueIds = new Set();
let youtubeProgressListenerPromise = null;
let playerVolumeFadeFrame = null;

function tauriApi() {
  if (!window.__TAURI__) throw new Error("Moodeur must be launched through its desktop application.");
  return window.__TAURI__;
}

function invoke(command, payload, options) {
  return tauriApi().core.invoke(command, payload, options);
}

function toast(message, type = "info", duration = 4200) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  elements.toastStack.append(node);
  window.setTimeout(() => node.remove(), duration);
}

function displayError(error, prefix = "") {
  const message = error instanceof Error ? error.message : String(error);
  toast(`${prefix}${message}`, "error", 6500);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function extensionOf(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function assetFor(item) {
  return state.document?.assets.find((asset) => asset.id === item.assetId) || null;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture could not be decoded for copying."));
    image.src = source;
  });
}

async function imageItemAsPng(item) {
  const asset = assetFor(item);
  const url = asset && state.assetUrls.get(asset.id);
  if (!asset || item.kind !== "image" || !url) throw new Error("This picture's media file is missing.");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`The picture could not be read (${response.status}).`);
  const sourceBlob = await response.blob();
  const objectUrl = URL.createObjectURL(sourceBlob);
  try {
    const image = await loadImage(objectUrl);
    const maximumDimension = 8192;
    const scale = Math.min(1, maximumDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The picture could not be prepared for copying.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("The picture could not be converted to PNG.")),
        "image/png"
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function copyImageToClipboard(item) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    toast("This system webview does not support copying pictures.", "error");
    return;
  }
  const png = imageItemAsPng(item);
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
    .then(() => toast("Picture copied to the clipboard.", "success"))
    .catch((error) => displayError(error, "Could not copy picture: "));
}

function itemById(id) {
  return state.document?.items.find((item) => item.id === id) || null;
}

function selectedItem() {
  return itemById(state.selectedId);
}

function selectedItems() {
  if (!state.document) return [];
  return state.document.items.filter((item) => state.selectedIds.has(item.id));
}

function setSelection(ids, primaryId = null) {
  const validIds = [...new Set(ids)].filter((id) => itemById(id));
  state.selectedIds = new Set(validIds);
  state.selectedId = primaryId && state.selectedIds.has(primaryId)
    ? primaryId
    : validIds.at(-1) || null;
}

function clearSelection() {
  setSelection([]);
}

function reconcileSelection() {
  setSelection([...state.selectedIds], state.selectedId);
}

function notePaperColor(value) {
  return NOTE_PAPER_COLORS.some((entry) => entry.value === value) ? value : DEFAULT_NOTE_PAPER;
}

function noteTextAlignment(value) {
  return ["left", "center", "right"].includes(value) ? value : "center";
}

function boardBackground() {
  const background = state.document?.background;
  const color = /^#[0-9a-f]{6}$/i.test(background?.color || "") ? background.color : DEFAULT_BACKGROUND.color;
  const pattern = BACKGROUND_PATTERNS.some((entry) => entry.value === background?.pattern)
    ? background.pattern
    : DEFAULT_BACKGROUND.pattern;
  return { color, pattern };
}

function rgbFromHex(color) {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function mixRgb(rgb, target, amount) {
  return rgb.map((channel) => Math.round(channel + (target - channel) * amount));
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function styleBackgroundSurface(surface, background, viewport = { x: 0, y: 0, zoom: 1 }) {
  const zoom = clamp(Number(viewport.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
  const rgb = rgbFromHex(background.color);
  const luminance = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
  const ink = luminance < 0.48 ? mixRgb(rgb, 255, 0.48) : mixRgb(rgb, 0, 0.24);
  const shine = luminance < 0.48 ? mixRgb(rgb, 255, 0.24) : mixRgb(rgb, 255, 0.48);
  const x = Number(viewport.x) || 0;
  const y = Number(viewport.y) || 0;
  const line = Math.max(0.75, zoom);
  surface.style.backgroundColor = background.color;
  surface.style.backgroundRepeat = "repeat";

  if (background.pattern === "plain") {
    surface.style.backgroundImage = "none";
    surface.style.backgroundSize = "auto";
    surface.style.backgroundPosition = "0 0";
  } else if (background.pattern === "stipple") {
    const size = 6 * zoom;
    const dot = Math.max(0.55, 0.75 * zoom);
    surface.style.backgroundImage = `radial-gradient(${rgba(ink, 0.62)} ${dot}px, transparent ${dot}px), radial-gradient(${rgba(shine, 0.78)} ${dot}px, transparent ${dot}px)`;
    surface.style.backgroundSize = `${size}px ${size}px`;
    surface.style.backgroundPosition = `${x}px ${y}px, ${x + size / 2}px ${y + size / 2}px`;
  } else if (background.pattern === "graph-grid") {
    const minor = 12 * zoom;
    const major = 48 * zoom;
    surface.style.backgroundImage = `linear-gradient(to right, ${rgba(ink, 0.22)} ${line}px, transparent ${line}px), linear-gradient(to bottom, ${rgba(ink, 0.22)} ${line}px, transparent ${line}px), linear-gradient(to right, ${rgba(ink, 0.42)} ${line}px, transparent ${line}px), linear-gradient(to bottom, ${rgba(ink, 0.42)} ${line}px, transparent ${line}px)`;
    surface.style.backgroundSize = `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`;
    surface.style.backgroundPosition = `${x}px ${y}px`;
  } else if (background.pattern === "ruled-paper") {
    const size = 28 * zoom;
    surface.style.backgroundImage = `linear-gradient(to bottom, transparent ${Math.max(0, size - line)}px, ${rgba(ink, 0.42)} ${Math.max(0, size - line)}px)`;
    surface.style.backgroundSize = `${size}px ${size}px`;
    surface.style.backgroundPosition = `${x}px ${y}px`;
  } else {
    const size = 28 * zoom;
    surface.style.backgroundImage = `conic-gradient(${rgba(ink, 0.17)} 25%, transparent 0 50%, ${rgba(ink, 0.17)} 0 75%, transparent 0)`;
    surface.style.backgroundSize = `${size}px ${size}px`;
    surface.style.backgroundPosition = `${x}px ${y}px`;
  }
}

function activeViewport() {
  return state.presentation?.viewport || state.document?.viewport || { x: 0, y: 0, zoom: 1 };
}

function applyCanvasBackground() {
  styleBackgroundSurface(
    elements.canvas,
    boardBackground(),
    activeViewport(),
  );
}

function operationBounds(operation) {
  if (!operation?.points?.length) return null;
  const radius = operation.width / 2;
  return {
    left: Math.min(...operation.points.map((point) => point.x)) - radius,
    top: Math.min(...operation.points.map((point) => point.y)) - radius,
    right: Math.max(...operation.points.map((point) => point.x)) + radius,
    bottom: Math.max(...operation.points.map((point) => point.y)) + radius,
  };
}

function boundsIntersect(first, second) {
  return first && second
    && first.left <= second.right && first.right >= second.left
    && first.top <= second.bottom && first.bottom >= second.top;
}

function paintDrawingOperation(context, operation, mapPoint, lineWidth) {
  if (!operation.points?.length) return;
  const points = operation.points.map(mapPoint);
  const erasing = operation.mode === "erase";
  context.save();
  context.globalCompositeOperation = erasing ? "destination-out" : "source-over";
  context.globalAlpha = erasing ? 1 : 0.88;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  context.strokeStyle = erasing ? "#000000" : operation.color;
  context.fillStyle = erasing ? "#000000" : operation.color;
  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.stroke();
  }
  context.restore();
}

function createBoardDrawingLayer() {
  const layer = document.createElement("div");
  layer.id = "board-drawing-layer";
  layer.className = "board-drawing-layer";
  const operations = state.document?.boardDrawings || [];
  const drawOperations = operations.filter((operation) => operation.mode === "draw");
  if (!drawOperations.length) return layer;

  const tileKeys = new Set();
  for (const operation of drawOperations) {
    const bounds = operationBounds(operation);
    if (!bounds) continue;
    const firstX = Math.floor(bounds.left / DRAWING_TILE_SIZE);
    const lastX = Math.floor(bounds.right / DRAWING_TILE_SIZE);
    const firstY = Math.floor(bounds.top / DRAWING_TILE_SIZE);
    const lastY = Math.floor(bounds.bottom / DRAWING_TILE_SIZE);
    for (let tileY = firstY; tileY <= lastY && tileKeys.size < 2048; tileY += 1) {
      for (let tileX = firstX; tileX <= lastX && tileKeys.size < 2048; tileX += 1) {
        tileKeys.add(`${tileX},${tileY}`);
      }
    }
  }

  tileKeys.forEach((key) => {
    const [tileX, tileY] = key.split(",").map(Number);
    const tileLeft = tileX * DRAWING_TILE_SIZE;
    const tileTop = tileY * DRAWING_TILE_SIZE;
    const tileBounds = {
      left: tileLeft,
      top: tileTop,
      right: tileLeft + DRAWING_TILE_SIZE,
      bottom: tileTop + DRAWING_TILE_SIZE,
    };
    const canvas = document.createElement("canvas");
    canvas.className = "board-drawing-tile";
    canvas.width = DRAWING_TILE_SIZE * DRAWING_TILE_SCALE;
    canvas.height = DRAWING_TILE_SIZE * DRAWING_TILE_SCALE;
    canvas.style.left = `${tileLeft}px`;
    canvas.style.top = `${tileTop}px`;
    canvas.style.width = `${DRAWING_TILE_SIZE}px`;
    canvas.style.height = `${DRAWING_TILE_SIZE}px`;
    const context = canvas.getContext("2d");
    operations.forEach((operation) => {
      if (!boundsIntersect(operationBounds(operation), tileBounds)) return;
      paintDrawingOperation(
        context,
        operation,
        (point) => ({
          x: (point.x - tileLeft) * DRAWING_TILE_SCALE,
          y: (point.y - tileTop) * DRAWING_TILE_SCALE,
        }),
        operation.width * DRAWING_TILE_SCALE,
      );
    });
    layer.append(canvas);
  });
  return layer;
}

function createPhotoDrawingLayer(item) {
  const canvas = document.createElement("canvas");
  canvas.className = "photo-drawing-layer";
  const scale = Math.min(2, 2048 / Math.max(item.width, item.height));
  canvas.width = Math.max(1, Math.round(item.width * scale));
  canvas.height = Math.max(1, Math.round(item.height * scale));
  paintPhotoDrawingLayer(canvas, item);
  return canvas;
}

function paintPhotoDrawingLayer(canvas, item) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const shortSide = Math.min(canvas.width, canvas.height);
  (item.drawings || []).forEach((operation) => {
    paintDrawingOperation(
      context,
      operation,
      (point) => ({ x: point.x * canvas.width, y: point.y * canvas.height }),
      operation.width * shortSide,
    );
  });
}

function redrawDrawingTarget(target) {
  if (target === "board") {
    const existing = $("#board-drawing-layer", elements.world);
    if (existing) existing.replaceWith(createBoardDrawingLayer());
    return;
  }
  const item = itemById(target);
  const element = elements.world.querySelector(`[data-item-id="${target}"]`);
  const canvas = element && $(".photo-drawing-layer", element);
  if (item && canvas) paintPhotoDrawingLayer(canvas, item);
}

function scheduleDrawingTargetRender(target) {
  state.dirtyDrawingTargets.add(target);
  if (state.drawingRenderFrame !== null) return;
  state.drawingRenderFrame = requestAnimationFrame(() => {
    state.drawingRenderFrame = null;
    const targets = [...state.dirtyDrawingTargets];
    state.dirtyDrawingTargets.clear();
    targets.forEach(redrawDrawingTarget);
  });
}

function snapshot() {
  return clone(state.document);
}

function documentsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordHistory(before) {
  if (!before || documentsEqual(before, state.document)) return;
  state.history.push(before);
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.future.length = 0;
  scheduleSave();
  updateActionStates();
}

function mutate(mutator) {
  if (!state.document) return;
  const before = snapshot();
  mutator();
  recordHistory(before);
  renderAll();
}

function undo() {
  if (!state.history.length || !state.document) return;
  state.future.push(snapshot());
  state.document = state.history.pop();
  reconcileSelection();
  scheduleSave();
  renderAll();
}

function redo() {
  if (!state.future.length || !state.document) return;
  state.history.push(snapshot());
  state.document = state.future.pop();
  reconcileSelection();
  scheduleSave();
  renderAll();
}

function setSaveState(kind, text) {
  elements.saveStatus.className = `status-cell save-state ${kind}`;
  elements.saveStatus.textContent = text;
}

function scheduleSave() {
  if (!state.document) return;
  state.dirty = true;
  setSaveState("saving", "Waiting to save…");
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => saveBoard(), SAVE_DELAY);
}

async function saveBoard() {
  if (!state.document || !state.dirty) return;
  if (state.interaction?.type === "drawing") {
    state.saveQueued = true;
    return;
  }
  window.clearTimeout(state.saveTimer);
  if (state.saveInFlight) {
    state.saveQueued = true;
    return;
  }
  state.saveInFlight = true;
  state.dirty = false;
  setSaveState("saving", "Saving…");
  const savingDocument = snapshot();
  try {
    await invoke("save_board", { document: savingDocument });
    if (state.dirty) {
      setSaveState("saving", "More changes…");
    } else {
      setSaveState("saved", "Saved");
    }
  } catch (error) {
    state.dirty = true;
    setSaveState("error", "Save failed — click to retry");
    displayError(error, "Could not save: ");
  } finally {
    state.saveInFlight = false;
    if (state.saveQueued || state.dirty && !elements.saveStatus.classList.contains("error")) {
      state.saveQueued = false;
      window.setTimeout(saveBoard, 20);
    }
  }
}

function showConfirm(message, title = "Moodeur") {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmDialog.hidden = false;
  return new Promise((resolve) => {
    const finish = (event) => {
      const value = event.target.closest("[data-confirm]")?.dataset.confirm;
      if (value === undefined) return;
      elements.confirmDialog.hidden = true;
      elements.confirmDialog.removeEventListener("click", finish);
      resolve(value === "true");
    };
    elements.confirmDialog.addEventListener("click", finish);
  });
}

async function askFolder() {
  return tauriApi().dialog.open({ directory: true, multiple: false });
}

async function createBoardFlow() {
  elements.titleDialog.hidden = false;
  elements.titleInput.value = "Untitled Board";
  window.setTimeout(() => {
    elements.titleInput.focus();
    elements.titleInput.select();
  }, 20);
}

async function finishCreateBoard(title) {
  const folder = await askFolder();
  if (!folder) return;
  try {
    const response = await invoke("create_board", { boardDir: folder, title });
    await loadBoardResponse(response);
    toast("Fresh board created. Make it strange.", "success");
  } catch (error) {
    displayError(error, "Could not create board: ");
  }
}

async function openBoardFlow() {
  const folder = await askFolder();
  if (!folder) return;
  await openBoardFolder(folder);
}

async function openBoardFolder(folder) {
  try {
    const response = await invoke("open_board", { boardDir: folder });
    await loadBoardResponse(response);
    if (response.recoveredFromBackup) {
      const restore = await showConfirm(
        `The main board file was damaged, but Moodeur found a valid backup.\n\n${response.primaryError}\n\nRestore the backup as the current board?`,
        "Backup found"
      );
      if (restore) {
        state.dirty = true;
        await saveBoard();
      }
    }
    return true;
  } catch (error) {
    displayError(error, "Could not open board: ");
    await refreshRecentBoards();
    return false;
  }
}

async function refreshRecentBoards() {
  if (!elements.recentBoardList) return;
  if (!window.__TAURI__) {
    elements.recentBoardList.innerHTML = '<div class="recent-board-empty">Recent boards appear in the desktop app.</div>';
    return;
  }
  try {
    const boards = await invoke("list_recent_boards");
    if (!boards.length) {
      elements.recentBoardList.innerHTML = '<div class="recent-board-empty">No recent boards yet. Open or create one to pin it here.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    boards.forEach((board) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-board";
      button.title = board.path;
      const icon = document.createElement("span");
      icon.className = "recent-board-icon";
      icon.textContent = "M";
      icon.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "recent-board-copy";
      const title = document.createElement("span");
      title.className = "recent-board-title";
      title.textContent = board.title;
      const path = document.createElement("span");
      path.className = "recent-board-path";
      path.textContent = board.path;
      copy.append(title, path);
      button.append(icon, copy);
      button.addEventListener("click", async () => {
        $$('button', elements.recentBoardList).forEach((entry) => { entry.disabled = true; });
        await openBoardFolder(board.path);
      });
      fragment.append(button);
    });
    elements.recentBoardList.replaceChildren(fragment);
  } catch (error) {
    elements.recentBoardList.innerHTML = '<div class="recent-board-empty">Recent boards could not be read. You can still use Open.</div>';
  }
}

function setYoutubeDownloading(downloading) {
  state.youtubeDownloading = downloading;
  elements.youtubeDialog.setAttribute("aria-busy", String(downloading));
  elements.youtubeUrl.disabled = downloading;
  elements.youtubePermission.disabled = downloading;
  elements.youtubeSubmit.disabled = downloading;
  elements.youtubeCancel.disabled = false;
  elements.youtubeCancel.textContent = downloading ? "Stop" : "Cancel";
  elements.youtubeClose.disabled = downloading;
  if (downloading) elements.youtubeProgressBox.hidden = false;
}

async function ensureYoutubeProgressListener() {
  if (!youtubeProgressListenerPromise) {
    youtubeProgressListenerPromise = tauriApi().event.listen("youtube-download-progress", (event) => {
      const progress = event.payload || {};
      elements.youtubeProgressStatus.textContent = progress.message || "Recording tape…";
      if (Number.isFinite(progress.percent)) {
        elements.youtubeProgress.value = clamp(progress.percent, 0, 100);
      } else {
        elements.youtubeProgress.removeAttribute("value");
      }
    }).catch((error) => {
      youtubeProgressListenerPromise = null;
      throw error;
    });
  }
  await youtubeProgressListenerPromise;
}

async function openYoutubeDialog() {
  if (!state.document) {
    toast("Create or open a board before recording audio.", "error");
    return;
  }
  try {
    await ensureYoutubeProgressListener();
  } catch (error) {
    displayError(error, "Could not prepare YouTube import: ");
    return;
  }
  elements.youtubeUrl.value = "";
  elements.youtubePermission.checked = false;
  elements.youtubeProgress.value = 0;
  elements.youtubeProgressStatus.textContent = "Preparing the tape deck…";
  elements.youtubeProgressBox.hidden = true;
  setYoutubeDownloading(false);
  elements.youtubeDialog.hidden = false;
  window.setTimeout(() => elements.youtubeUrl.focus(), 20);
}

async function submitYoutubeDownload(event) {
  event.preventDefault();
  if (state.youtubeDownloading || !state.document) return;
  if (!elements.youtubeForm.reportValidity()) return;
  state.youtubePlacement = preferredPlacement();
  elements.youtubeProgress.value = 0;
  elements.youtubeProgressStatus.textContent = "Finding the audio track…";
  setYoutubeDownloading(true);
  try {
    const asset = await invoke("download_youtube_audio", {
      url: elements.youtubeUrl.value,
      permissionConfirmed: elements.youtubePermission.checked,
    });
    elements.youtubeProgressStatus.textContent = "Checking the recorded tape…";
    await acceptImportedAssets([asset], state.youtubePlacement);
    elements.youtubeDialog.hidden = true;
  } catch (error) {
    if (String(error).toLowerCase().includes("cancel")) {
      elements.youtubeProgressStatus.textContent = "Recording cancelled.";
      elements.youtubeProgress.value = 0;
    } else {
      displayError(error, "Could not record YouTube audio: ");
      elements.youtubeProgressStatus.textContent = "Recording failed. Check the message and try again.";
    }
  } finally {
    state.youtubePlacement = null;
    setYoutubeDownloading(false);
  }
}

async function cancelYoutubeDownload() {
  if (!state.youtubeDownloading) {
    elements.youtubeDialog.hidden = true;
    return;
  }
  elements.youtubeProgressStatus.textContent = "Stopping the tape…";
  elements.youtubeCancel.disabled = true;
  try {
    await invoke("cancel_youtube_download");
  } catch (error) {
    displayError(error, "Could not stop the download: ");
  } finally {
    elements.youtubeCancel.disabled = false;
  }
}

async function loadBoardResponse(response) {
  if (state.presentation) exitPresentation();
  stopMusic();
  state.boardPath = response.boardPath;
  state.document = response.document;
  clearSelection();
  state.history.length = 0;
  state.future.length = 0;
  state.internalClipboard = null;
  state.drawingTool = "select";
  state.dirtyDrawingTargets.clear();
  state.dirty = false;
  state.assetUrls.clear();
  await refreshAssetUrls();
  elements.welcome.hidden = true;
  elements.titleDialog.hidden = true;
  elements.windowTitle.textContent = `${state.document.title} — Moodeur`;
  document.title = `${state.document.title} — Moodeur`;
  elements.boardFolder.textContent = state.boardPath;
  setSaveState("saved", "Saved");
  renderAll();
  elements.canvas.focus();
  window.setTimeout(() => startQueue(true), 250);
}

async function refreshAssetUrls(assets = state.document?.assets || []) {
  if (!state.document || !assets.length) return;
  const paths = await invoke("asset_paths", { relativePaths: assets.map((asset) => asset.relativePath) });
  paths.forEach((path, index) => {
    const asset = assets[index];
    state.assetUrls.set(asset.id, path ? tauriApi().core.convertFileSrc(path) : null);
  });
}

async function chooseImportFiles() {
  if (!state.document) {
    toast("Create or open a board first.", "error");
    return;
  }
  const paths = await tauriApi().dialog.open({
    multiple: true,
    directory: false,
    filters: [{ name: "Pictures and music", extensions: ALL_EXTENSIONS }],
  });
  if (!paths) return;
  const list = Array.isArray(paths) ? paths : [paths];
  try {
    const assets = await invoke("import_paths", { paths: list });
    await acceptImportedAssets(assets, preferredPlacement());
  } catch (error) {
    displayError(error, "Import failed: ");
  }
}

function preferredPlacement() {
  if (state.lastPointerBoard) return { ...state.lastPointerBoard };
  const rect = elements.canvas.getBoundingClientRect();
  return screenToBoard(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

async function importFileBlob(file, placement) {
  const extension = extensionOf(file.name) || (file.type === "image/png" ? "png" : "");
  if (!ALL_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported file type: ${file.name || file.type || "unknown"}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const asset = await invoke("import_blob", bytes, {
    headers: {
      "x-moodeur-extension": extension,
      "x-moodeur-name": encodeURIComponent(file.name || `Pasted image.${extension}`),
    },
  });
  await acceptImportedAssets([asset], placement);
}

function probeImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The native image decoder could not read this file."));
    image.src = url;
  });
}

function probeAudio(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
    };
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      resolve({ duration });
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("The native audio decoder could not read this file."));
    };
    audio.src = url;
    audio.load();
  });
}

async function acceptImportedAssets(assets, placement) {
  await refreshAssetUrls(assets);
  const valid = [];
  const failures = [];
  for (const asset of assets) {
    const url = state.assetUrls.get(asset.id);
    if (!url) {
      failures.push(`${asset.originalName}: copied file is unavailable`);
      continue;
    }
    try {
      if (asset.kind === "image") Object.assign(asset, await probeImage(url));
      else Object.assign(asset, await probeAudio(url));
      valid.push(asset);
    } catch (error) {
      failures.push(`${asset.originalName}: ${error.message}`);
    }
  }
  if (valid.length) {
    const before = snapshot();
    let topZ = Math.max(0, ...state.document.items.map((item) => item.z));
    const importedIds = [];
    valid.forEach((asset, index) => {
      state.document.assets.push(asset);
      const offset = index * 24;
      const item = createItemForAsset(asset, placement.x + offset, placement.y + offset, ++topZ);
      state.document.items.push(item);
      if (item.kind === "audio") state.document.autoplayQueue.push(item.id);
      importedIds.push(item.id);
    });
    setSelection(importedIds, importedIds.at(-1));
    recordHistory(before);
    renderAll();
    toast(`${valid.length} item${valid.length === 1 ? "" : "s"} added to the board.`, "success");
  }
  if (failures.length) toast(failures.join("\n"), "error", 7500);
}

function createItemForAsset(asset, centerX, centerY, z) {
  if (asset.kind === "audio") {
    return {
      id: uid(), kind: "audio", assetId: asset.id,
      x: centerX - 140, y: centerY - 53, width: 280, height: 106,
      rotation: 0, z, volume: 0.8,
    };
  }
  const naturalWidth = asset.width || 640;
  const naturalHeight = asset.height || 480;
  const scale = Math.min(1, 360 / naturalWidth, 300 / naturalHeight);
  const width = Math.max(80, naturalWidth * scale);
  const height = Math.max(80, naturalHeight * scale);
  return {
    id: uid(), kind: "image", assetId: asset.id,
    x: centerX - width / 2, y: centerY - height / 2, width, height,
    rotation: 0, z, crop: { left: 0, top: 0, right: 0, bottom: 0 }, drawings: [],
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function applyWorldTransform() {
  applyCanvasBackground();
  if (!state.document) return;
  const viewport = activeViewport();
  elements.world.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  elements.zoomOutput.textContent = `${Math.round(viewport.zoom * 100)}%`;
}

function renderAll() {
  const hasBoard = Boolean(state.document);
  applyCanvasBackground();
  renderBackgroundPanel();
  const hasBoardInk = Boolean(state.document?.boardDrawings?.some((operation) => operation.mode === "draw"));
  elements.emptyHint.hidden = !hasBoard || state.document.items.length !== 0 || hasBoardInk;
  if (!hasBoard) {
    elements.world.replaceChildren();
    renderInspector();
    renderQueue();
    updateActionStates();
    return;
  }
  applyWorldTransform();
  renderBoard();
  renderInspector();
  renderQueue();
  updateActionStates();
  const selectionCount = selectedItems().length;
  const marker = MARKER_COLORS.find((entry) => entry.value === state.markerColor)?.label || "Marker";
  elements.selectionStatus.textContent = state.drawingTool === "draw"
    ? `DRAW · ${marker}`
    : state.drawingTool === "erase"
      ? "ERASE · scrub marker ink"
      : `${state.document.items.length} object${state.document.items.length === 1 ? "" : "s"}${selectionCount ? ` · ${selectionCount} selected` : ""}`;
}

function renderBoard() {
  if (state.drawingRenderFrame !== null) cancelAnimationFrame(state.drawingRenderFrame);
  state.drawingRenderFrame = null;
  state.dirtyDrawingTargets.clear();
  const fragment = document.createDocumentFragment();
  fragment.append(createBoardDrawingLayer());
  const sorted = [...state.document.items].sort((left, right) => left.z - right.z);
  for (const item of sorted) fragment.append(createItemElement(item));
  elements.world.replaceChildren(fragment);
  updatePlaybackUi();
}

function positionItemElement(element, item) {
  element.style.width = `${item.width}px`;
  element.style.height = `${item.height}px`;
  element.style.transform = `translate(${item.x}px, ${item.y}px) rotate(${item.rotation}deg)`;
  element.style.zIndex = String(item.z);
}

function createItemElement(item) {
  const asset = assetFor(item);
  const url = asset ? state.assetUrls.get(asset.id) : null;
  const element = document.createElement("article");
  const missingMedia = item.kind !== "text" && !url;
  element.className = `board-item ${item.kind}-item${state.selectedIds.has(item.id) ? " selected" : ""}${missingMedia ? " missing" : ""}`;
  element.classList.toggle("presentation-current", state.presentation?.slideIds[state.presentation.index] === item.id);
  element.dataset.itemId = item.id;
  positionItemElement(element, item);

  if (item.kind === "text") {
    element.style.setProperty("--note-paper", notePaperColor(item.paperColor));
    const note = document.createElement("div");
    note.className = "text-note";
    note.textContent = item.text || "";
    note.style.fontSize = `${item.fontSize || 28}px`;
    note.style.color = item.color || "#4b2142";
    note.style.textAlign = noteTextAlignment(item.textAlign);
    note.setAttribute("aria-label", "Handwritten text note. Double-click to edit.");
    element.append(note);
  } else if (!asset || !url) {
    element.innerHTML = `<div class="missing-card">MISSING MEDIA<br><small>${escapeHtml(asset?.originalName || item.assetId)}</small></div>`;
  } else if (item.kind === "image") {
    const crop = item.crop || { left: 0, top: 0, right: 0, bottom: 0 };
    const visibleWidth = Math.max(0.05, 1 - crop.left - crop.right);
    const visibleHeight = Math.max(0.05, 1 - crop.top - crop.bottom);
    const image = document.createElement("img");
    image.src = url;
    image.alt = asset.originalName;
    image.draggable = false;
    image.style.width = `${100 / visibleWidth}%`;
    image.style.height = `${100 / visibleHeight}%`;
    image.style.left = `${(-crop.left / visibleWidth) * 100}%`;
    image.style.top = `${(-crop.top / visibleHeight) * 100}%`;
    const frame = document.createElement("div");
    frame.className = "image-frame";
    frame.append(image);
    element.append(frame, createPhotoDrawingLayer(item));
  } else if (item.kind === "audio") {
    const queued = state.document.autoplayQueue.includes(item.id);
    element.classList.add("audio-card");
    element.innerHTML = `
      <div class="cassette-label">${escapeHtml(asset.originalName)}</div>
      <div class="cassette-body">
        <button class="play-button" data-track-action="play" title="Play or pause">▶</button>
        <div class="track-controls">
          <input class="track-progress" data-track-action="seek" type="range" min="0" max="${asset.duration || 0}" step="0.1" value="0" aria-label="Track position" />
          <span class="track-time">0:00 / ${formatTime(asset.duration)}</span>
          <span class="queue-led ${queued ? "on" : ""}" title="${queued ? "In the board-start queue" : "Not queued"}">● ${queued ? "QUEUED" : "LOCAL"}</span>
          <input class="mini-volume" data-track-action="volume" type="range" min="0" max="1" step="0.05" value="${item.volume ?? 0.8}" aria-label="Track volume" />
        </div>
      </div>`;
  }

  if (state.selectedIds.size === 1 && state.selectedId === item.id) {
    const stem = document.createElement("span");
    stem.className = "rotate-stem";
    const rotate = document.createElement("button");
    rotate.className = "selection-handle rotate-handle";
    rotate.title = "Drag to rotate (Shift snaps to 15°); double-click to reset";
    rotate.setAttribute("aria-label", "Rotate item");
    rotate.addEventListener("pointerdown", (event) => beginRotateHandlePress(event, item.id));
    rotate.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      mutate(() => {
        const rotatedItem = itemById(item.id);
        if (rotatedItem) rotatedItem.rotation = 0;
      });
    });
    const resize = document.createElement("button");
    resize.className = "selection-handle resize-handle";
    resize.title = "Drag to resize";
    resize.setAttribute("aria-label", "Resize item");
    resize.addEventListener("pointerdown", (event) => beginResize(event, item.id));
    element.append(stem, rotate, resize);
  }

  element.addEventListener("pointerdown", (event) => beginItemDrag(event, item.id));
  if (item.kind === "image") {
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSelection([item.id], item.id);
      copyImageToClipboard(item);
      renderAll();
    });
  }
  element.addEventListener("dblclick", () => {
    setSelection([item.id], item.id);
    if (item.kind === "text") beginInlineTextEdit(element, item);
    else {
      renderAll();
      if (item.kind === "audio") playTrack(item.id);
    }
  });
  if (item.kind === "audio") wireAudioCard(element, item);
  return element;
}

function beginInlineTextEdit(element, item) {
  const note = $(".text-note", element);
  if (!note || note.isContentEditable) return;
  const before = snapshot();
  note.contentEditable = "true";
  note.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(note);
  selection.removeAllRanges();
  selection.addRange(range);

  const finish = () => {
    item.text = note.innerText.replaceAll("\r\n", "\n").slice(0, 10_000);
    note.contentEditable = "false";
    recordHistory(before);
    const inspectorField = $("[data-inspector-action='text']", elements.inspectorContent);
    if (inspectorField) inspectorField.value = item.text;
    updateActionStates();
  };
  note.addEventListener("input", () => {
    item.text = note.innerText.replaceAll("\r\n", "\n").slice(0, 10_000);
  });
  note.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      note.blur();
    }
  });
  note.addEventListener("blur", finish, { once: true });
}

function wireAudioCard(element, item) {
  $("[data-track-action='play']", element)?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (currentTrackId === item.id && !player.paused) player.pause();
    else playTrack(item.id);
  });
  $("[data-track-action='seek']", element)?.addEventListener("input", (event) => {
    event.stopPropagation();
    if (currentTrackId !== item.id) playTrack(item.id, false, Number(event.target.value));
    else player.currentTime = Number(event.target.value);
  });
  $("[data-track-action='volume']", element)?.addEventListener("input", (event) => {
    event.stopPropagation();
    item.volume = Number(event.target.value);
    if (currentTrackId === item.id) player.volume = item.volume;
    scheduleSave();
  });
  $$(`input, button`, element).forEach((control) => control.addEventListener("pointerdown", (event) => event.stopPropagation()));
}

function changeBackground(changes) {
  if (!state.document) return;
  mutate(() => {
    state.document.background = { ...boardBackground(), ...changes };
  });
}

function renderBackgroundPanel() {
  if (!elements.backgroundContent) return;
  if (!state.document) {
    elements.backgroundContent.innerHTML = `
      <div class="panel-message background-empty">
        <div class="tiny-monitor" aria-hidden="true">BG</div>
        <strong>No board open</strong>
        <span>Create or open a board to dress up its background.</span>
      </div>`;
    return;
  }

  const background = boardBackground();
  const palette = BACKGROUND_COLORS.map(({ value, label }) => `
    <button type="button" class="background-swatch${value.toLowerCase() === background.color.toLowerCase() ? " selected" : ""}" data-background-color="${value}" role="radio" aria-checked="${value.toLowerCase() === background.color.toLowerCase()}" title="${label}">
      <span style="--swatch: ${value}" aria-hidden="true"></span><em>${label}</em>
    </button>`).join("");
  const patterns = BACKGROUND_PATTERNS.map(({ value, label, description }) => `
    <button type="button" class="pattern-choice${value === background.pattern ? " selected" : ""}" data-background-pattern="${value}" role="radio" aria-checked="${value === background.pattern}">
      <span class="pattern-thumbnail pattern-${value}" aria-hidden="true"></span>
      <span><strong>${label}</strong><small>${description}</small></span>
    </button>`).join("");

  elements.backgroundContent.innerHTML = `
    <div id="background-preview" class="background-preview" aria-label="Background preview">
      <span>MOODEUR BOARD</span>
      <i></i><i></i><i></i>
    </div>
    <fieldset class="inspector-section">
      <header>Retro colors</header>
      <div class="inspector-body">
        <div class="background-palette" role="radiogroup" aria-label="Background color">${palette}</div>
        <label for="background-custom-color">Custom color</label>
        <div class="custom-background-row">
          <input id="background-custom-color" class="color-field" type="color" value="${escapeHtml(background.color)}" />
          <output id="background-color-code">${escapeHtml(background.color.toUpperCase())}</output>
        </div>
      </div>
    </fieldset>
    <fieldset class="inspector-section">
      <header>Pattern</header>
      <div class="inspector-body">
        <div class="pattern-list" role="radiogroup" aria-label="Background pattern">${patterns}</div>
        <div class="hint-text">Patterns stay attached to the board while you pan and zoom.</div>
      </div>
    </fieldset>
    <button id="background-reset" class="wide-button">Restore Original Background</button>`;

  const preview = $("#background-preview", elements.backgroundContent);
  styleBackgroundSurface(preview, background);
  wireBackgroundPanel(preview);
}

function wireBackgroundPanel(preview) {
  $$('[data-background-color]', elements.backgroundContent).forEach((button) => {
    button.addEventListener("click", () => changeBackground({ color: button.dataset.backgroundColor }));
  });
  $$('[data-background-pattern]', elements.backgroundContent).forEach((button) => {
    button.addEventListener("click", () => changeBackground({ pattern: button.dataset.backgroundPattern }));
  });
  const custom = $("#background-custom-color", elements.backgroundContent);
  custom?.addEventListener("input", () => {
    const temporary = { ...boardBackground(), color: custom.value };
    $("#background-color-code", elements.backgroundContent).textContent = custom.value.toUpperCase();
    styleBackgroundSurface(preview, temporary);
    styleBackgroundSurface(elements.canvas, temporary, state.document.viewport);
  });
  custom?.addEventListener("change", () => changeBackground({ color: custom.value }));
  $("#background-reset", elements.backgroundContent)?.addEventListener("click", () => {
    changeBackground({ ...DEFAULT_BACKGROUND });
  });
}

function renderInspector() {
  if (state.drawingTool !== "select") {
    renderDrawingInspector();
    return;
  }
  const selection = selectedItems();
  if (selection.length > 1) {
    elements.noSelection.hidden = true;
    elements.inspectorContent.hidden = false;
    elements.inspectorContent.innerHTML = `
      <fieldset class="inspector-section">
        <header>Multiple selection</header>
        <div class="inspector-body">
          <div class="asset-name">${selection.length} cards selected</div>
          <div class="hint-text">Drag any selected card to move the whole group. Resize and rotation handles return when one card is selected.</div>
        </div>
      </fieldset>
      <div class="button-grid">
        <button data-action="duplicate">Duplicate group</button>
        <button data-action="delete">Delete group</button>
      </div>`;
    return;
  }
  const item = selectedItem();
  elements.noSelection.hidden = Boolean(item);
  elements.inspectorContent.hidden = !item;
  if (!item) {
    elements.inspectorContent.replaceChildren();
    return;
  }
  const asset = assetFor(item);
  const angle = Math.round(item.rotation * 10) / 10;
  let mediaSection = "";
  if (item.kind === "image") {
    const crop = item.crop || { left: 0, top: 0, right: 0, bottom: 0 };
    mediaSection = `
      <fieldset class="inspector-section">
        <header>Non-destructive crop</header>
        <div class="inspector-body">
          ${cropControl("Left", "left", crop.left)}
          ${cropControl("Right", "right", crop.right)}
          ${cropControl("Top", "top", crop.top)}
          ${cropControl("Bottom", "bottom", crop.bottom)}
          <button data-inspector-action="reset-crop">Reset crop</button>
          <div class="hint-text">The original picture stays untouched. Crop values are stored as percentages.</div>
        </div>
      </fieldset>`;
  } else if (item.kind === "audio") {
    const checked = state.document.autoplayQueue.includes(item.id) ? "checked" : "";
    mediaSection = `
      <fieldset class="inspector-section">
        <header>Tape settings</header>
        <div class="inspector-body">
          <label class="checkbox-row"><input data-inspector-action="queue-toggle" type="checkbox" ${checked} /> Add To Tape</label>
          <div class="field-row"><label for="volume-field">Volume</label><input id="volume-field" data-inspector-action="volume" type="range" min="0" max="1" step="0.05" value="${item.volume ?? 0.8}" /><output>${Math.round((item.volume ?? 0.8) * 100)}%</output></div>
          <button data-inspector-action="play">▶ Play this track</button>
        </div>
      </fieldset>`;
  } else {
    const paperColor = notePaperColor(item.paperColor);
    const textAlign = noteTextAlignment(item.textAlign);
    const paperPalette = NOTE_PAPER_COLORS.map(({ value, label }) => `
      <button type="button" class="note-swatch${value === paperColor ? " selected" : ""}" data-note-paper="${value}" style="--swatch: ${value}" role="radio" aria-checked="${value === paperColor}" title="${label}">
        <span aria-hidden="true"></span>${label}
      </button>`).join("");
    mediaSection = `
      <fieldset class="inspector-section">
        <header>Handwritten note</header>
        <div class="inspector-body">
          <label for="note-text-field">Words</label>
          <textarea id="note-text-field" class="inspector-textarea" data-inspector-action="text" maxlength="10000">${escapeHtml(item.text || "")}</textarea>
          <label>Paper</label>
          <div class="note-palette" role="radiogroup" aria-label="Note paper color">${paperPalette}</div>
          <label>Alignment</label>
          <div class="alignment-picker" role="radiogroup" aria-label="Text alignment">
            <button type="button" class="${textAlign === "left" ? "selected" : ""}" data-text-align="left" role="radio" aria-checked="${textAlign === "left"}"><span aria-hidden="true">☰</span>Left</button>
            <button type="button" class="${textAlign === "center" ? "selected" : ""}" data-text-align="center" role="radio" aria-checked="${textAlign === "center"}"><span aria-hidden="true">☰</span>Center</button>
            <button type="button" class="${textAlign === "right" ? "selected" : ""}" data-text-align="right" role="radio" aria-checked="${textAlign === "right"}"><span aria-hidden="true">☰</span>Right</button>
          </div>
          <div class="field-row"><label for="font-size-field">Text size</label><input id="font-size-field" data-inspector-action="font-size" type="number" min="10" max="200" step="1" value="${item.fontSize || 28}" /><span>px</span></div>
          <div class="field-row"><label for="color-field">Ink</label><input id="color-field" class="color-field" data-inspector-action="color" type="color" value="${escapeHtml(item.color || "#4b2142")}" /><span></span></div>
          <div class="hint-text">Double-click the note to type. Enter finishes; Shift+Enter adds a new line.</div>
        </div>
      </fieldset>`;
  }
  const kindTitle = item.kind === "image" ? "Picture" : item.kind === "audio" ? "Music card" : "Text note";
  const identity = item.kind === "text" ? "Retro handwritten note" : asset?.originalName || "Missing media";
  elements.inspectorContent.innerHTML = `
    <fieldset class="inspector-section">
      <header>${kindTitle}</header>
      <div class="inspector-body">
        <div class="asset-name" title="${escapeHtml(identity)}">${escapeHtml(identity)}</div>
        <div class="field-row"><label for="angle-field">Rotation</label><input id="angle-field" data-inspector-action="angle" type="number" min="-360" max="360" step="0.1" value="${angle}" /><span>°</span></div>
        <div class="field-row"><span>Size</span><span>${Math.round(item.width)} × ${Math.round(item.height)}</span><span>px</span></div>
      </div>
    </fieldset>
    <fieldset class="inspector-section">
      <header>Stacking order</header>
      <div class="inspector-body button-grid">
        <button data-inspector-action="forward">Bring forward</button>
        <button data-inspector-action="front">Bring to front</button>
        <button data-inspector-action="backward">Send backward</button>
        <button data-inspector-action="back">Send to back</button>
      </div>
    </fieldset>
    ${mediaSection}
    <div class="button-grid">
      <button data-action="duplicate">Duplicate</button>
      <button data-action="delete">Delete</button>
    </div>`;
  wireInspector();
}

function renderDrawingInspector() {
  elements.noSelection.hidden = true;
  elements.inspectorContent.hidden = false;
  const drawing = state.drawingTool === "draw";
  const palette = MARKER_COLORS.map(({ value, label }) => `
    <button type="button" class="marker-swatch${value === state.markerColor ? " selected" : ""}" data-marker-color="${value}" style="--marker-color: ${value}" role="radio" aria-checked="${value === state.markerColor}">
      <span aria-hidden="true"></span>${label}
    </button>`).join("");
  elements.inspectorContent.innerHTML = `
    <div class="drawing-tool-hero ${drawing ? "marker" : "eraser"}">
      <span aria-hidden="true">${drawing ? "✎" : "▰"}</span>
      <div><strong>${drawing ? "MARKER READY" : "ERASER READY"}</strong><small>${drawing ? "Draw anywhere on the board." : "Scrub away marker ink."}</small></div>
    </div>
    ${drawing ? `
      <fieldset class="inspector-section">
        <header>Retro marker ink</header>
        <div class="inspector-body">
          <div class="marker-palette" role="radiogroup" aria-label="Marker ink color">${palette}</div>
          <div class="hint-text">One sturdy marker width. Ink automatically sticks to a photo beneath the cursor.</div>
        </div>
      </fieldset>` : `
      <fieldset class="inspector-section">
        <header>Scrub eraser</header>
        <div class="inspector-body">
          <div class="eraser-demo" aria-hidden="true"><i></i></div>
          <div class="hint-text">The eraser removes only ink on the surface beneath it. It is three times wider than the marker.</div>
        </div>
      </fieldset>`}
    <fieldset class="inspector-section">
      <header>Physical layers</header>
      <div class="inspector-body">
        <div class="hint-text">Board ink stays on the board. Photo ink follows that photo when it moves, rotates, resizes, duplicates, or is pasted.</div>
        <div class="hint-text">Hold Space or use the middle mouse button to pan.</div>
      </div>
    </fieldset>
    <button class="wide-button" data-action="select-tool">Return to Select (Esc)</button>`;
  $$('[data-marker-color]', elements.inspectorContent).forEach((button) => {
    button.addEventListener("click", () => {
      state.markerColor = button.dataset.markerColor;
      renderInspector();
      updateDrawingToolUi();
    });
  });
}

function cropControl(label, side, value) {
  return `<div class="crop-grid"><label for="crop-${side}">${label}</label><input id="crop-${side}" data-crop-side="${side}" type="range" min="0" max="45" step="1" value="${Math.round(value * 100)}" /><output>${Math.round(value * 100)}%</output></div>`;
}

function wireInspector() {
  $("[data-inspector-action='angle']", elements.inspectorContent)?.addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    mutate(() => { selectedItem().rotation = normalizeAngle(value); });
  });
  $("[data-inspector-action='queue-toggle']", elements.inspectorContent)?.addEventListener("change", (event) => {
    mutate(() => setQueued(state.selectedId, event.target.checked));
  });
  $("[data-inspector-action='volume']", elements.inspectorContent)?.addEventListener("input", (event) => {
    const item = selectedItem();
    item.volume = Number(event.target.value);
    if (currentTrackId === item.id) player.volume = item.volume;
    event.target.nextElementSibling.textContent = `${Math.round(item.volume * 100)}%`;
    scheduleSave();
  });
  $("[data-inspector-action='play']", elements.inspectorContent)?.addEventListener("click", () => playTrack(state.selectedId));
  $("[data-inspector-action='text']", elements.inspectorContent)?.addEventListener("change", (event) => {
    mutate(() => { selectedItem().text = event.target.value.slice(0, 10_000); });
  });
  $("[data-inspector-action='font-size']", elements.inspectorContent)?.addEventListener("change", (event) => {
    const value = clamp(Number(event.target.value), 10, 200);
    if (Number.isFinite(value)) mutate(() => { selectedItem().fontSize = value; });
  });
  $("[data-inspector-action='color']", elements.inspectorContent)?.addEventListener("change", (event) => {
    mutate(() => { selectedItem().color = event.target.value; });
  });
  $$('[data-note-paper]', elements.inspectorContent).forEach((button) => {
    button.addEventListener("click", () => {
      mutate(() => { selectedItem().paperColor = notePaperColor(button.dataset.notePaper); });
    });
  });
  $$('[data-text-align]', elements.inspectorContent).forEach((button) => {
    button.addEventListener("click", () => {
      mutate(() => { selectedItem().textAlign = noteTextAlignment(button.dataset.textAlign); });
    });
  });
  $("[data-inspector-action='reset-crop']", elements.inspectorContent)?.addEventListener("click", () => {
    mutate(() => {
      const item = selectedItem();
      item.crop = { left: 0, top: 0, right: 0, bottom: 0 };
      adjustItemToCrop(item);
    });
  });
  $$('[data-crop-side]', elements.inspectorContent).forEach((input) => {
    input.addEventListener("change", () => {
      const side = input.dataset.cropSide;
      const value = Number(input.value) / 100;
      mutate(() => {
        const item = selectedItem();
        const crop = item.crop || (item.crop = { left: 0, top: 0, right: 0, bottom: 0 });
        const opposite = side === "left" ? "right" : side === "right" ? "left" : side === "top" ? "bottom" : "top";
        crop[side] = Math.min(value, 0.9 - crop[opposite]);
        adjustItemToCrop(item);
      });
    });
  });
  $$('[data-inspector-action]', elements.inspectorContent).forEach((button) => {
    const action = button.dataset.inspectorAction;
    if (["forward", "front", "backward", "back"].includes(action)) {
      button.addEventListener("click", () => changeLayer(action));
    }
  });
}

function adjustItemToCrop(item) {
  const asset = assetFor(item);
  if (!asset?.width || !asset?.height) return;
  const crop = item.crop;
  const ratio = (asset.width * (1 - crop.left - crop.right)) / (asset.height * (1 - crop.top - crop.bottom));
  const centerX = item.x + item.width / 2;
  item.width = Math.max(48, item.height * ratio);
  item.x = centerX - item.width / 2;
}

function renderQueue() {
  const queue = state.document?.autoplayQueue || [];
  elements.queueCount.textContent = String(queue.length);
  elements.queueShuffle.checked = Boolean(state.document?.shuffleQueue);
  elements.queueShuffle.disabled = !state.document;
  elements.queuePlayToggle.disabled = queue.length === 0;
  if (!queue.length) {
    elements.queueList.innerHTML = '<div class="queue-empty">The tape is empty.<br />Select a music card and switch on “Add To Tape”.</div>';
    updateQueuePlaybackUi();
    return;
  }
  elements.queueList.innerHTML = queue.map((id, index) => {
    const item = itemById(id);
    const asset = item ? assetFor(item) : null;
    const isPlaying = currentTrackId === id && !player.paused;
    return `<div class="queue-entry ${currentTrackId === id ? "current" : ""}" data-queue-id="${id}">
      <span class="queue-index">${index + 1}</span><span class="queue-title">${escapeHtml(asset?.originalName || "Missing track")}</span>
      <button class="${isPlaying ? "queue-stop" : ""}" data-queue-action="play" title="${isPlaying ? "Stop" : "Play"}" aria-label="${isPlaying ? "Stop this track" : "Play this track"}">${isPlaying ? "■" : "▶"}</button><button data-queue-action="up" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button><button data-queue-action="down" title="Move down" ${index === queue.length - 1 ? "disabled" : ""}>↓</button>
    </div>`;
  }).join("");
  $$('[data-queue-action]', elements.queueList).forEach((button) => {
    button.addEventListener("click", () => {
      const entry = button.closest("[data-queue-id]");
      const id = entry.dataset.queueId;
      if (button.dataset.queueAction === "play") {
        if (currentTrackId === id && !player.paused) stopMusic();
        else startQueueAt(id);
      }
      else moveQueueItem(id, button.dataset.queueAction === "up" ? -1 : 1);
    });
  });
  updateQueuePlaybackUi();
}

function updateActionStates() {
  const hasBoard = Boolean(state.document);
  const hasSelection = selectedItems().length > 0;
  const hasPresentationSlide = Boolean(state.document?.items.some((item) => item.kind === "image"));
  $$('[data-action="import"], [data-action="open-media-folder"], [data-action="youtube"], [data-action="save"], [data-action="add-text"], [data-action="draw"], [data-action="erase"]').forEach((button) => { button.disabled = !hasBoard; });
  $$('[data-action="presentation"]').forEach((button) => { button.disabled = !hasPresentationSlide; });
  $$('[data-action="undo"]').forEach((button) => { button.disabled = !state.history.length; });
  $$('[data-action="redo"]').forEach((button) => { button.disabled = !state.future.length; });
  $$('[data-action="duplicate"], [data-action="delete"]').forEach((button) => { button.disabled = !hasSelection; });
  updateDrawingToolUi();
}

function screenToBoard(clientX, clientY) {
  if (!state.document) return { x: 0, y: 0 };
  const rect = elements.canvas.getBoundingClientRect();
  const viewport = activeViewport();
  return {
    x: (clientX - rect.left - viewport.x) / viewport.zoom,
    y: (clientY - rect.top - viewport.y) / viewport.zoom,
  };
}

function setDrawingTool(tool) {
  if (tool !== "select" && !state.document) {
    toast("Create or open a board before drawing.", "error");
    return;
  }
  state.drawingTool = state.drawingTool === tool && tool !== "select" ? "select" : tool;
  if (state.drawingTool !== "select") switchTab("inspector");
  updateDrawingToolUi();
  renderInspector();
  updateActionStates();
  elements.canvas.focus();
}

function updateDrawingToolUi() {
  const drawing = state.drawingTool === "draw";
  const erasing = state.drawingTool === "erase";
  elements.canvas.classList.toggle("draw-mode", drawing);
  elements.canvas.classList.toggle("erase-mode", erasing);
  $$('[data-action="draw"]').forEach((button) => {
    button.classList.toggle("pressed", drawing);
    button.setAttribute("aria-pressed", String(drawing));
  });
  $$('[data-action="erase"]').forEach((button) => {
    button.classList.toggle("pressed", erasing);
    button.setAttribute("aria-pressed", String(erasing));
  });
  if (state.document && drawing) {
    const marker = MARKER_COLORS.find((entry) => entry.value === state.markerColor)?.label || "Marker";
    elements.selectionStatus.textContent = `DRAW · ${marker}`;
  } else if (state.document && erasing) {
    elements.selectionStatus.textContent = "ERASE · scrub marker ink";
  }
}

function drawingPointCount() {
  if (!state.document) return 0;
  const boardPoints = (state.document.boardDrawings || [])
    .reduce((total, operation) => total + operation.points.length, 0);
  return state.document.items.reduce(
    (total, item) => total + (item.drawings || []).reduce((count, operation) => count + operation.points.length, 0),
    boardPoints,
  );
}

function drawingOperationCount() {
  if (!state.document) return 0;
  return state.document.items.reduce(
    (total, item) => total + (item.drawings || []).length,
    (state.document.boardDrawings || []).length,
  );
}

function canCopyDrawingData(items) {
  const addedOperations = items.reduce((total, item) => total + (item.drawings || []).length, 0);
  const addedPoints = items.reduce(
    (total, item) => total + (item.drawings || []).reduce((count, operation) => count + operation.points.length, 0),
    0,
  );
  if (drawingOperationCount() + addedOperations > MAX_DRAWING_OPERATIONS
      || drawingPointCount() + addedPoints > MAX_BOARD_DRAWING_POINTS) {
    toast("Duplicating those photo markings would exceed this board's drawing limit.", "error");
    return false;
  }
  return true;
}

function drawingSurfaceAt(clientX, clientY) {
  const topItemElement = document.elementsFromPoint(clientX, clientY)
    .map((element) => element.closest?.(".board-item"))
    .find(Boolean);
  if (!topItemElement) return "board";
  const item = itemById(topItemElement.dataset.itemId);
  return item?.kind === "image" ? item.id : "board";
}

function pointForDrawingSurface(surface, clientX, clientY) {
  const boardPoint = screenToBoard(clientX, clientY);
  if (surface === "board") return boardPoint;
  const item = itemById(surface);
  if (!item) return null;
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const radians = -item.rotation * Math.PI / 180;
  const dx = boardPoint.x - centerX;
  const dy = boardPoint.y - centerY;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians) + item.width / 2;
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians) + item.height / 2;
  return {
    x: clamp(localX / item.width, 0, 1),
    y: clamp(localY / item.height, 0, 1),
  };
}

function operationsForDrawingSurface(surface) {
  if (surface === "board") {
    return state.document.boardDrawings || (state.document.boardDrawings = []);
  }
  const item = itemById(surface);
  if (!item || item.kind !== "image") return null;
  return item.drawings || (item.drawings = []);
}

function appendDrawingSample(interaction, clientX, clientY) {
  const canvasRect = elements.canvas.getBoundingClientRect();
  if (clientX < canvasRect.left || clientX > canvasRect.right
      || clientY < canvasRect.top || clientY > canvasRect.bottom) {
    interaction.surface = null;
    interaction.operation = null;
    return;
  }
  if (interaction.totalPoints >= MAX_BOARD_DRAWING_POINTS) {
    if (!interaction.limitReported) toast("This board has reached its marker point limit.", "error");
    interaction.limitReported = true;
    return;
  }
  const surface = drawingSurfaceAt(clientX, clientY);
  const point = pointForDrawingSurface(surface, clientX, clientY);
  const operations = operationsForDrawingSurface(surface);
  if (!point || !operations) return;
  let operation = interaction.operation;
  if (interaction.surface !== surface || !operation || operation.points.length >= MAX_POINTS_PER_DRAWING) {
    if (interaction.totalOperations >= MAX_DRAWING_OPERATIONS) {
      if (!interaction.limitReported) toast("This board has reached its marker operation limit.", "error");
      interaction.limitReported = true;
      return;
    }
    const photo = surface !== "board";
    const item = photo ? itemById(surface) : null;
    const baseWidth = state.drawingTool === "erase" ? ERASER_WIDTH : MARKER_WIDTH;
    operation = {
      id: uid(),
      mode: state.drawingTool,
      width: photo ? clamp(baseWidth / Math.min(item.width, item.height), 0.0001, 0.5) : baseWidth,
      points: [],
    };
    if (state.drawingTool === "draw") operation.color = state.markerColor;
    operations.push(operation);
    interaction.totalOperations += 1;
    interaction.surface = surface;
    interaction.operation = operation;
  }
  const previous = operation.points.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.000001) return;
  operation.points.push(point);
  interaction.totalPoints += 1;
  scheduleDrawingTargetRender(surface);
}

function beginDrawingGesture(event) {
  if (!state.document || state.presentation || state.drawingTool === "select" || state.spaceHeld || event.button !== 0) return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  state.interaction = {
    type: "drawing",
    pointerId: event.pointerId,
    before: snapshot(),
    surface: null,
    operation: null,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    totalPoints: drawingPointCount(),
    totalOperations: drawingOperationCount(),
    limitReported: false,
  };
  appendDrawingSample(state.interaction, event.clientX, event.clientY);
  elements.canvas.setPointerCapture(event.pointerId);
  return true;
}

function updateDrawingGesture(interaction, event) {
  const dx = event.clientX - interaction.lastClientX;
  const dy = event.clientY - interaction.lastClientY;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(distance / DRAWING_SAMPLE_PIXELS));
  for (let step = 1; step <= steps; step += 1) {
    appendDrawingSample(
      interaction,
      interaction.lastClientX + dx * step / steps,
      interaction.lastClientY + dy * step / steps,
    );
  }
  interaction.lastClientX = event.clientX;
  interaction.lastClientY = event.clientY;
}

function beginItemDrag(event, itemId) {
  if (state.presentation || event.button !== 0 || event.target.closest("button, input, textarea, [contenteditable='true']") || state.spaceHeld) return;
  event.preventDefault();
  const item = itemById(itemId);
  if (!item) return;
  if (!state.selectedIds.has(itemId)) {
    setSelection([itemId], itemId);
    renderAll();
  }
  const startPositions = selectedItems().map((selected) => ({ id: selected.id, x: selected.x, y: selected.y }));
  state.interaction = {
    type: "move", pointerId: event.pointerId, itemId,
    startClientX: event.clientX, startClientY: event.clientY,
    startPositions, before: snapshot(),
  };
  elements.canvas.setPointerCapture(event.pointerId);
}

function beginResize(event, itemId) {
  if (state.presentation) return;
  event.preventDefault();
  event.stopPropagation();
  const item = itemById(itemId);
  state.interaction = {
    type: "resize", pointerId: event.pointerId, itemId,
    startClientX: event.clientX, startClientY: event.clientY,
    startWidth: item.width, startHeight: item.height, before: snapshot(),
  };
  elements.canvas.setPointerCapture(event.pointerId);
}

function beginRotate(event, itemId) {
  if (state.presentation) return;
  event.preventDefault();
  event.stopPropagation();
  state.interaction = { type: "rotate", pointerId: event.pointerId, itemId, before: snapshot() };
  elements.canvas.setPointerCapture(event.pointerId);
}

function beginRotateHandlePress(event, itemId) {
  const now = performance.now();
  const previous = state.lastRotateHandlePress;
  if (previous?.itemId === itemId && now - previous.time < 400) {
    event.preventDefault();
    event.stopPropagation();
    state.lastRotateHandlePress = null;
    mutate(() => {
      const item = itemById(itemId);
      if (item) item.rotation = 0;
    });
    return;
  }
  state.lastRotateHandlePress = { itemId, time: now };
  beginRotate(event, itemId);
}

function beginPan(event) {
  if (!state.document || state.presentation || !(event.button === 1 || event.button === 0 && state.spaceHeld)) return false;
  event.preventDefault();
  state.interaction = {
    type: "pan", pointerId: event.pointerId,
    startClientX: event.clientX, startClientY: event.clientY,
    startX: state.document.viewport.x, startY: state.document.viewport.y,
  };
  elements.canvas.classList.add("panning");
  elements.canvas.setPointerCapture(event.pointerId);
  return true;
}

function beginMarquee(event) {
  if (!state.document || state.presentation || event.button !== 0 || state.spaceHeld) return false;
  event.preventDefault();
  clearSelection();
  renderAll();
  state.interaction = {
    type: "marquee", pointerId: event.pointerId,
    startClientX: event.clientX, startClientY: event.clientY,
  };
  elements.marquee.hidden = false;
  elements.marquee.style.left = `${event.clientX - elements.canvas.getBoundingClientRect().left}px`;
  elements.marquee.style.top = `${event.clientY - elements.canvas.getBoundingClientRect().top}px`;
  elements.marquee.style.width = "0px";
  elements.marquee.style.height = "0px";
  elements.canvas.setPointerCapture(event.pointerId);
  return true;
}

function updateMarquee(interaction, event) {
  const canvasRect = elements.canvas.getBoundingClientRect();
  const left = Math.min(interaction.startClientX, event.clientX);
  const top = Math.min(interaction.startClientY, event.clientY);
  const right = Math.max(interaction.startClientX, event.clientX);
  const bottom = Math.max(interaction.startClientY, event.clientY);
  elements.marquee.style.left = `${left - canvasRect.left}px`;
  elements.marquee.style.top = `${top - canvasRect.top}px`;
  elements.marquee.style.width = `${right - left}px`;
  elements.marquee.style.height = `${bottom - top}px`;

  const hits = state.document.items
    .filter((item) => {
      const element = elements.world.querySelector(`[data-item-id="${item.id}"]`);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top;
    })
    .sort((first, second) => first.z - second.z);
  setSelection(hits.map((item) => item.id), hits.at(-1)?.id || null);
  $$('.board-item', elements.world).forEach((element) => {
    element.classList.toggle("selected", state.selectedIds.has(element.dataset.itemId));
  });
  const selectionCount = hits.length;
  elements.selectionStatus.textContent = `${state.document.items.length} object${state.document.items.length === 1 ? "" : "s"}${selectionCount ? ` · ${selectionCount} selected` : ""}`;
}

function handlePointerMove(event) {
  if (!state.document) return;
  const point = screenToBoard(event.clientX, event.clientY);
  state.lastPointerBoard = point;
  elements.pointerStatus.textContent = `X: ${Math.round(point.x)}   Y: ${Math.round(point.y)}`;
  const interaction = state.interaction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  if (interaction.type === "drawing") {
    updateDrawingGesture(interaction, event);
    return;
  }
  if (interaction.type === "marquee") {
    updateMarquee(interaction, event);
    return;
  }
  if (interaction.type === "pan") {
    state.document.viewport.x = interaction.startX + event.clientX - interaction.startClientX;
    state.document.viewport.y = interaction.startY + event.clientY - interaction.startClientY;
    applyWorldTransform();
    return;
  }
  if (interaction.type === "move") {
    const dx = (event.clientX - interaction.startClientX) / state.document.viewport.zoom;
    const dy = (event.clientY - interaction.startClientY) / state.document.viewport.zoom;
    interaction.startPositions.forEach((start) => {
      const movedItem = itemById(start.id);
      if (!movedItem) return;
      movedItem.x = start.x + dx;
      movedItem.y = start.y + dy;
      const element = elements.world.querySelector(`[data-item-id="${movedItem.id}"]`);
      if (element) positionItemElement(element, movedItem);
    });
    return;
  }
  const item = interaction.itemId ? itemById(interaction.itemId) : null;
  if (!item) return;
  if (interaction.type === "resize") {
    const dx = (event.clientX - interaction.startClientX) / state.document.viewport.zoom;
    const dy = (event.clientY - interaction.startClientY) / state.document.viewport.zoom;
    if (item.kind === "image") {
      const scale = Math.max(48 / interaction.startWidth, (interaction.startWidth + dx) / interaction.startWidth);
      item.width = interaction.startWidth * scale;
      item.height = interaction.startHeight * scale;
    } else if (item.kind === "audio") {
      item.width = clamp(interaction.startWidth + dx, 220, 620);
      item.height = interaction.startHeight;
    } else {
      item.width = clamp(interaction.startWidth + dx, 120, 800);
      item.height = clamp(interaction.startHeight + dy, 50, 600);
    }
  } else if (interaction.type === "rotate") {
    const center = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    let angle = Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI + 90;
    if (event.shiftKey) angle = Math.round(angle / 15) * 15;
    item.rotation = normalizeAngle(angle);
  }
  const element = elements.world.querySelector(`[data-item-id="${item.id}"]`);
  if (element) positionItemElement(element, item);
}

function finishPointer(event) {
  const interaction = state.interaction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  const wasItemClick = interaction.type === "move"
    && Math.hypot(event.clientX - interaction.startClientX, event.clientY - interaction.startClientY) < 5;
  state.interaction = null;
  elements.canvas.classList.remove("panning");
  try { elements.canvas.releasePointerCapture(event.pointerId); } catch (_) { /* no capture */ }
  if (interaction.type === "marquee") {
    elements.marquee.hidden = true;
    state.lastItemClick = null;
    renderAll();
    return;
  }
  if (interaction.type === "pan") scheduleSave();
  else recordHistory(interaction.before);
  renderAll();

  if (!wasItemClick) {
    state.lastItemClick = null;
    return;
  }

  const now = performance.now();
  const previous = state.lastItemClick;
  const isDoubleClick = previous
    && previous.itemId === interaction.itemId
    && now - previous.time < 500
    && Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) < 8;
  state.lastItemClick = isDoubleClick
    ? null
    : { itemId: interaction.itemId, time: now, clientX: event.clientX, clientY: event.clientY };

  if (isDoubleClick) {
    const item = itemById(interaction.itemId);
    const element = elements.world.querySelector(`[data-item-id="${interaction.itemId}"]`);
    if (item?.kind === "text" && element) beginInlineTextEdit(element, item);
    else if (item?.kind === "audio") playTrack(item.id);
  }
}

function normalizeAngle(value) {
  let angle = value % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return Math.round(angle * 10) / 10;
}

function setQueued(itemId, enabled) {
  const queue = state.document.autoplayQueue;
  const index = queue.indexOf(itemId);
  if (enabled && index === -1) queue.push(itemId);
  if (!enabled && index !== -1) queue.splice(index, 1);
}

function moveQueueItem(itemId, direction) {
  mutate(() => {
    const queue = state.document.autoplayQueue;
    const index = queue.indexOf(itemId);
    const target = clamp(index + direction, 0, queue.length - 1);
    if (index === target) return;
    [queue[index], queue[target]] = [queue[target], queue[index]];
  });
}

function createQueueLoopOrder(previousTrackId = null) {
  const order = [...(state.document?.autoplayQueue || [])];
  if (!state.document?.shuffleQueue) return order;
  for (let index = order.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [order[index], order[target]] = [order[target], order[index]];
  }
  if (order.length > 1 && order[0] === previousTrackId) {
    const alternatives = order
      .map((id, index) => ({ id, index }))
      .filter((entry) => entry.id !== previousTrackId);
    if (alternatives.length) {
      const replacement = alternatives[Math.floor(Math.random() * alternatives.length)].index;
      [order[0], order[replacement]] = [order[replacement], order[0]];
    }
  }
  return order;
}

function startQueueAt(itemId) {
  const order = createQueueLoopOrder();
  queuePlaybackOrder = state.document?.shuffleQueue
    ? [itemId, ...order.filter((id) => id !== itemId)]
    : order;
  failedQueueIds.clear();
  playTrack(itemId, true);
}

function trackTargetVolume(itemId = currentTrackId) {
  const item = itemId && itemById(itemId);
  return item?.kind === "audio" ? clamp(item.volume ?? 0.8, 0, 1) : 0.8;
}

function cancelPlayerVolumeFade() {
  if (playerVolumeFadeFrame !== null) cancelAnimationFrame(playerVolumeFadeFrame);
  playerVolumeFadeFrame = null;
}

function animatePlayerVolume(target, duration = PRESENTATION_SOUNDTRACK_FADE_MS) {
  cancelPlayerVolumeFade();
  const trackId = currentTrackId;
  const startVolume = player.volume;
  const startedAt = performance.now();
  const step = (now) => {
    if (currentTrackId !== trackId || player.paused) {
      playerVolumeFadeFrame = null;
      return;
    }
    const progress = clamp((now - startedAt) / duration, 0, 1);
    player.volume = clamp(startVolume + (target - startVolume) * progress, 0, 1);
    if (progress < 1) playerVolumeFadeFrame = requestAnimationFrame(step);
    else playerVolumeFadeFrame = null;
  };
  playerVolumeFadeFrame = requestAnimationFrame(step);
}

function applyPresentationSoundtrackTailFade() {
  if (!state.presentation || !playingQueue || player.paused || !Number.isFinite(player.duration)) return;
  const remaining = player.duration - player.currentTime;
  const fadeSeconds = PRESENTATION_SOUNDTRACK_FADE_MS / 1000;
  if (remaining > fadeSeconds || remaining < 0) return;
  cancelPlayerVolumeFade();
  player.volume = trackTargetVolume() * clamp(remaining / fadeSeconds, 0, 1);
}

async function playTrack(itemId, queueMode = null, startTime = 0, automatic = false) {
  const item = itemById(itemId);
  const asset = item && assetFor(item);
  const url = asset && state.assetUrls.get(asset.id);
  const inferredQueue = Boolean(state.document?.autoplayQueue.includes(itemId));
  if (queueMode === null && inferredQueue && (!playingQueue || currentTrackId !== itemId)) {
    const order = createQueueLoopOrder();
    queuePlaybackOrder = state.document?.shuffleQueue
      ? [itemId, ...order.filter((id) => id !== itemId)]
      : order;
    failedQueueIds.clear();
  }
  playingQueue = queueMode === null ? inferredQueue : queueMode;
  if (!item || item.kind !== "audio" || !url) {
    toast("That track's media file is missing.", "error");
    if (playingQueue) playNextQueued(itemId, true);
    return;
  }
  if (currentTrackId === itemId && player.src === url) {
    if (startTime > 0) player.currentTime = startTime;
  } else {
    player.pause();
    currentTrackId = itemId;
    player.src = url;
    player.load();
    if (startTime > 0) {
      player.addEventListener("loadedmetadata", () => { player.currentTime = startTime; }, { once: true });
    }
  }
  cancelPlayerVolumeFade();
  const targetVolume = clamp(item.volume ?? 0.8, 0, 1);
  const fadeIn = Boolean(state.presentation && playingQueue);
  player.volume = fadeIn ? 0 : targetVolume;
  try {
    await player.play();
    if (fadeIn && state.presentation && playingQueue && currentTrackId === itemId) {
      animatePlayerVolume(targetVolume);
    } else {
      player.volume = targetVolume;
    }
    elements.startTape.hidden = true;
    updatePlaybackUi();
    renderQueue();
  } catch (error) {
    if (automatic || error?.name === "NotAllowedError") {
      elements.startTape.hidden = false;
    } else {
      displayError(error, `Could not play ${asset.originalName}: `);
      if (playingQueue) playNextQueued(itemId, true);
    }
  }
}

function startQueue(automatic = false) {
  queuePlaybackOrder = createQueueLoopOrder();
  const first = queuePlaybackOrder[0];
  if (!first) {
    if (!automatic) toast("The board-start queue is empty.");
    return;
  }
  failedQueueIds.clear();
  playTrack(first, true, 0, automatic);
}

function playNextQueued(finishedId, failed = false) {
  if (!state.document || !playingQueue) return;
  const queue = state.document.autoplayQueue;
  if (!queue.length) {
    stopMusic();
    return;
  }

  if (failed) {
    if (failedQueueIds.has(finishedId)) return;
    failedQueueIds.add(finishedId);
    if (queue.every((id) => failedQueueIds.has(id))) {
      toast("No tracks in the tape queue could be played.", "error");
      stopMusic();
      return;
    }
  } else {
    failedQueueIds.clear();
  }

  const stillQueued = new Set(queue);
  queuePlaybackOrder = queuePlaybackOrder.filter((id) => stillQueued.has(id));
  queue.forEach((id) => {
    if (!queuePlaybackOrder.includes(id)) queuePlaybackOrder.push(id);
  });
  const index = queuePlaybackOrder.indexOf(finishedId);
  if (index >= 0 && index + 1 < queuePlaybackOrder.length) {
    window.setTimeout(() => playTrack(queuePlaybackOrder[index + 1], true), 0);
    return;
  }

  queuePlaybackOrder = createQueueLoopOrder(finishedId);
  window.setTimeout(() => playTrack(queuePlaybackOrder[0], true), 0);
}

function stopMusic() {
  cancelPlayerVolumeFade();
  player.pause();
  currentTrackId = null;
  playingQueue = false;
  queuePlaybackOrder = [];
  failedQueueIds.clear();
  player.removeAttribute("src");
  player.load();
  elements.startTape.hidden = true;
  updatePlaybackUi();
  renderQueue();
}

function updatePlaybackUi() {
  $$(".audio-card", elements.world).forEach((card) => {
    const id = card.dataset.itemId;
    const active = id === currentTrackId;
    card.classList.toggle("playing", active && !player.paused);
    const playButton = $("[data-track-action='play']", card);
    if (playButton) playButton.textContent = active && !player.paused ? "❚❚" : "▶";
    const progress = $("[data-track-action='seek']", card);
    const item = itemById(id);
    const asset = item && assetFor(item);
    if (progress) {
      progress.max = String(active && Number.isFinite(player.duration) ? player.duration : asset?.duration || 0);
      progress.value = String(active && Number.isFinite(player.currentTime) ? player.currentTime : 0);
    }
    const time = $(".track-time", card);
    if (time) time.textContent = `${formatTime(active ? player.currentTime : 0)} / ${formatTime(active && Number.isFinite(player.duration) ? player.duration : asset?.duration)}`;
  });
  updateQueuePlaybackUi();
}

function updateQueuePlaybackUi() {
  const tapePlaying = playingQueue && Boolean(currentTrackId) && !player.paused;
  if (elements.queuePlayToggle) {
    elements.queuePlayToggle.textContent = tapePlaying ? "■ Stop tape" : "▶ Play queue from start";
    elements.queuePlayToggle.classList.toggle("queue-stop", tapePlaying);
    elements.queuePlayToggle.title = tapePlaying ? "Stop tape playback" : "Play queue from start";
  }
  $$('[data-queue-action="play"]', elements.queueList).forEach((button) => {
    const id = button.closest("[data-queue-id]")?.dataset.queueId;
    const active = id === currentTrackId && !player.paused;
    button.textContent = active ? "■" : "▶";
    button.title = active ? "Stop" : "Play";
    button.setAttribute("aria-label", active ? "Stop this track" : "Play this track");
    button.classList.toggle("queue-stop", active);
  });
}

function changeLayer(action) {
  const item = selectedItem();
  if (!item) return;
  mutate(() => {
    const sorted = [...state.document.items].sort((left, right) => left.z - right.z);
    const index = sorted.findIndex((candidate) => candidate.id === item.id);
    let target = index;
    if (action === "forward") target = Math.min(sorted.length - 1, index + 1);
    if (action === "backward") target = Math.max(0, index - 1);
    if (action === "front") target = sorted.length - 1;
    if (action === "back") target = 0;
    sorted.splice(index, 1);
    sorted.splice(target, 0, item);
    sorted.forEach((candidate, position) => { candidate.z = position + 1; });
  });
}

function addTextCard(initialText = null) {
  if (!state.document) {
    toast("Create or open a board first.", "error");
    return;
  }
  const pastedText = typeof initialText === "string" ? initialText.slice(0, 10_000) : null;
  const before = snapshot();
  const placement = preferredPlacement();
  const item = {
    id: uid(),
    kind: "text",
    x: placement.x - 140,
    y: placement.y - 65,
    width: 280,
    height: 130,
    rotation: -1.5,
    z: Math.max(0, ...state.document.items.map((candidate) => candidate.z)) + 1,
    text: pastedText ?? "Type something…",
    fontSize: 28,
    color: "#4b2142",
    paperColor: DEFAULT_NOTE_PAPER,
    textAlign: "center",
  };
  state.document.items.push(item);
  setSelection([item.id], item.id);
  recordHistory(before);
  renderAll();
  if (pastedText === null) {
    window.setTimeout(() => {
      const element = elements.world.querySelector(`[data-item-id="${item.id}"]`);
      if (element) beginInlineTextEdit(element, item);
    }, 0);
  }
}

function duplicateSelection() {
  const sources = selectedItems().sort((first, second) => first.z - second.z);
  if (!sources.length) return;
  if (!canCopyDrawingData(sources)) return;
  const before = snapshot();
  let topZ = Math.max(0, ...state.document.items.map((item) => item.z));
  const duplicates = sources.map((source) => {
    const duplicate = clone(source);
    duplicate.id = uid();
    duplicate.x += 24;
    duplicate.y += 24;
    duplicate.z = ++topZ;
    return duplicate;
  });
  state.document.items.push(...duplicates);
  setSelection(duplicates.map((item) => item.id), duplicates.at(-1).id);
  recordHistory(before);
  renderAll();
}

function pasteInternal() {
  if (!state.internalClipboard || !state.document) return;
  const sources = Array.isArray(state.internalClipboard.items)
    ? clone(state.internalClipboard.items)
    : [clone(state.internalClipboard)];
  if (!sources.length) return;
  if (!canCopyDrawingData(sources)) return;
  const before = snapshot();
  const placement = preferredPlacement();
  const left = Math.min(...sources.map((item) => item.x));
  const top = Math.min(...sources.map((item) => item.y));
  const right = Math.max(...sources.map((item) => item.x + item.width));
  const bottom = Math.max(...sources.map((item) => item.y + item.height));
  const dx = placement.x - (left + right) / 2;
  const dy = placement.y - (top + bottom) / 2;
  let topZ = Math.max(0, ...state.document.items.map((candidate) => candidate.z));
  const pasted = sources.map((source) => ({
    ...source,
    id: uid(),
    x: source.x + dx,
    y: source.y + dy,
    z: ++topZ,
  }));
  state.document.items.push(...pasted);
  setSelection(pasted.map((item) => item.id), pasted.at(-1).id);
  recordHistory(before);
  renderAll();
}

function deleteSelection() {
  const ids = new Set(selectedItems().map((item) => item.id));
  if (!ids.size) return;
  mutate(() => {
    state.document.items = state.document.items.filter((candidate) => !ids.has(candidate.id));
    state.document.autoplayQueue = state.document.autoplayQueue.filter((id) => !ids.has(id));
    if (currentTrackId && ids.has(currentTrackId)) stopMusic();
    clearSelection();
  });
}

function presentationImageItems() {
  if (!state.document) return [];
  return window.MoodeurPresentationOrder
    .imageIds(state.document.items, state.selectedIds)
    .map(itemById)
    .filter(Boolean);
}

function rotatedItemBounds(item) {
  const radians = (Number(item.rotation) || 0) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const width = item.width * cosine + item.height * sine;
  const height = item.width * sine + item.height * cosine;
  return {
    centerX: item.x + item.width / 2,
    centerY: item.y + item.height / 2,
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function presentationViewportFor(item) {
  const rect = elements.canvas.getBoundingClientRect();
  const bounds = rotatedItemBounds(item);
  const horizontalPadding = Math.min(PRESENTATION_PADDING, rect.width * 0.18);
  const verticalPadding = Math.min(PRESENTATION_PADDING, rect.height * 0.18);
  const availableWidth = Math.max(80, rect.width - horizontalPadding * 2);
  const availableHeight = Math.max(80, rect.height - verticalPadding * 2);
  const zoom = clamp(
    Math.min(availableWidth / bounds.width, availableHeight / bounds.height),
    MIN_ZOOM,
    PRESENTATION_MAX_ZOOM,
  );
  return {
    zoom,
    x: rect.width / 2 - bounds.centerX * zoom,
    y: rect.height / 2 - bounds.centerY * zoom,
  };
}

function showPresentationControls() {
  if (!state.presentation) return;
  elements.presentationControls.classList.remove("idle");
  window.clearTimeout(state.presentationControlTimer);
  state.presentationControlTimer = window.setTimeout(() => {
    if (!state.presentation || elements.presentationControls.contains(document.activeElement)) return;
    elements.presentationControls.classList.add("idle");
  }, PRESENTATION_CONTROL_HIDE_DELAY);
}

function syncPresentationUi() {
  if (!state.presentation) return;
  const { slideIds, index } = state.presentation;
  const currentId = slideIds[index];
  $$(".board-item", elements.world).forEach((element) => {
    const current = element.dataset.itemId === currentId;
    element.classList.toggle("presentation-current", current);
    element.setAttribute("aria-hidden", String(!current));
  });
  elements.presentationCounter.textContent = `${index + 1} / ${slideIds.length}`;
  const previous = $('[data-action="presentation-previous"]', elements.presentationControls);
  const next = $('[data-action="presentation-next"]', elements.presentationControls);
  previous.disabled = index === 0;
  next.disabled = index === slideIds.length - 1;
}

function setPresentationSlide(index) {
  if (!state.presentation) return;
  const maximum = state.presentation.slideIds.length - 1;
  state.presentation.index = clamp(index, 0, maximum);
  const item = itemById(state.presentation.slideIds[state.presentation.index]);
  if (!item) {
    exitPresentation();
    return;
  }
  state.presentation.viewport = presentationViewportFor(item);
  syncPresentationUi();
  applyWorldTransform();
  showPresentationControls();
}

function enterPresentation() {
  if (!state.document) {
    toast("Create or open a board first.", "error");
    return;
  }
  if (state.presentation) return;
  const dialogOpen = !elements.welcome.hidden
    || !elements.titleDialog.hidden
    || !elements.youtubeDialog.hidden
    || !elements.confirmDialog.hidden;
  if (dialogOpen || state.interaction) {
    toast("Finish the current dialog or canvas gesture first.", "error");
    return;
  }
  const slides = presentationImageItems();
  if (!slides.length) {
    toast("Add a picture before starting a presentation.", "error");
    return;
  }
  document.activeElement?.blur();
  closeMenus();
  state.spaceHeld = false;
  if (state.drawingTool !== "select") setDrawingTool("select");
  state.presentation = {
    slideIds: slides.map((item) => item.id),
    index: 0,
    viewport: null,
  };
  elements.app.classList.add("presentation-mode");
  elements.presentationControls.hidden = false;
  elements.canvas.setAttribute("aria-label", "Moodeur presentation");
  setPresentationSlide(0);
  if (state.document.autoplayQueue.length && !(playingQueue && currentTrackId && !player.paused)) {
    startQueue(false);
  } else if (!state.document.autoplayQueue.length && currentTrackId && !player.paused) {
    stopMusic();
  }
}

function restoreCurrentTrackVolume() {
  const item = currentTrackId && itemById(currentTrackId);
  if (item?.kind === "audio") player.volume = clamp(item.volume ?? 0.8, 0, 1);
}

function exitPresentation() {
  if (!state.presentation) return;
  window.clearTimeout(state.presentationControlTimer);
  state.presentationControlTimer = null;
  cancelPlayerVolumeFade();
  state.presentation = null;
  elements.app.classList.remove("presentation-mode");
  elements.presentationControls.hidden = true;
  elements.presentationControls.classList.remove("idle");
  $$(".board-item", elements.world).forEach((element) => {
    element.classList.remove("presentation-current");
    element.removeAttribute("aria-hidden");
  });
  elements.canvas.setAttribute("aria-label", "Moodboard canvas");
  restoreCurrentTrackVolume();
  applyWorldTransform();
  updateActionStates();
  elements.canvas.focus();
}

function movePresentation(direction) {
  if (!state.presentation) return;
  setPresentationSlide(state.presentation.index + direction);
}

function zoomAt(factor, clientX, clientY) {
  if (!state.document || state.presentation) return;
  const viewport = state.document.viewport;
  const rect = elements.canvas.getBoundingClientRect();
  const anchorX = clientX ?? rect.left + rect.width / 2;
  const anchorY = clientY ?? rect.top + rect.height / 2;
  const before = screenToBoard(anchorX, anchorY);
  viewport.zoom = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  viewport.x = anchorX - rect.left - before.x * viewport.zoom;
  viewport.y = anchorY - rect.top - before.y * viewport.zoom;
  applyWorldTransform();
  scheduleSave();
}

function resetZoom() {
  if (!state.document || state.presentation) return;
  state.document.viewport.zoom = 1;
  applyWorldTransform();
  scheduleSave();
}

function frameAll() {
  if (!state.document || state.presentation) return;
  const rect = elements.canvas.getBoundingClientRect();
  const items = state.document.items;
  const bounds = [
    ...items.map((item) => ({ left: item.x, top: item.y, right: item.x + item.width, bottom: item.y + item.height })),
    ...(state.document.boardDrawings || [])
      .filter((operation) => operation.mode === "draw")
      .map(operationBounds)
      .filter(Boolean),
  ];
  if (!bounds.length) return;
  const left = Math.min(...bounds.map((entry) => entry.left));
  const top = Math.min(...bounds.map((entry) => entry.top));
  const right = Math.max(...bounds.map((entry) => entry.right));
  const bottom = Math.max(...bounds.map((entry) => entry.bottom));
  const width = Math.max(100, right - left);
  const height = Math.max(100, bottom - top);
  const zoom = clamp(Math.min((rect.width - 100) / width, (rect.height - 100) / height), MIN_ZOOM, 1.5);
  state.document.viewport.zoom = zoom;
  state.document.viewport.x = (rect.width - width * zoom) / 2 - left * zoom;
  state.document.viewport.y = (rect.height - height * zoom) / 2 - top * zoom;
  applyWorldTransform();
  scheduleSave();
}

function switchTab(tab) {
  const selected = ["inspector", "background", "queue"].includes(tab) ? tab : "inspector";
  ["inspector", "background", "queue"].forEach((name) => {
    const active = name === selected;
    $(`#${name}-tab`).classList.toggle("active", active);
    $(`#${name}-tab`).setAttribute("aria-selected", String(active));
    $(`#${name}-panel`).hidden = !active;
  });
}

async function dispatchAction(action) {
  closeMenus();
  switch (action) {
    case "new": await saveBoard(); createBoardFlow(); break;
    case "open": await saveBoard(); openBoardFlow(); break;
    case "import": chooseImportFiles(); break;
    case "open-media-folder":
      try { await invoke("open_media_folder"); }
      catch (error) { displayError(error, "Could not open media folder: "); }
      break;
    case "youtube": openYoutubeDialog(); break;
    case "add-text": addTextCard(); break;
    case "draw": setDrawingTool("draw"); break;
    case "erase": setDrawingTool("erase"); break;
    case "select-tool": setDrawingTool("select"); break;
    case "save": state.dirty = true; saveBoard(); break;
    case "undo": undo(); break;
    case "redo": redo(); break;
    case "duplicate": duplicateSelection(); break;
    case "delete": deleteSelection(); break;
    case "zoom-in": zoomAt(1.2); break;
    case "zoom-out": zoomAt(1 / 1.2); break;
    case "zoom-reset": resetZoom(); break;
    case "frame-all": frameAll(); break;
    case "presentation": enterPresentation(); break;
    case "presentation-previous": movePresentation(-1); break;
    case "presentation-next": movePresentation(1); break;
    case "presentation-exit": exitPresentation(); break;
    case "start-tape": startQueue(false); break;
    case "toggle-tape":
      if (playingQueue && currentTrackId && !player.paused) stopMusic();
      else startQueue(false);
      break;
    case "stop-music": stopMusic(); break;
    case "show-queue": switchTab("queue"); break;
    case "cancel-title": elements.titleDialog.hidden = true; break;
  }
}

function closeMenus() {
  $$(".popup-menu").forEach((menu) => { menu.hidden = true; });
  $$(".menu-button").forEach((button) => button.classList.remove("open"));
}

function toggleMenu(id, button) {
  const menu = document.getElementById(id);
  const opening = menu.hidden;
  closeMenus();
  if (opening) {
    menu.hidden = false;
    button.classList.add("open");
  }
}

async function handleDrop(event) {
  event.preventDefault();
  state.dragDepth = 0;
  elements.dropOverlay.hidden = true;
  if (state.presentation) return;
  if (!state.document) {
    toast("Create or open a board before dropping media.", "error");
    return;
  }
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  const placement = screenToBoard(event.clientX, event.clientY);
  for (let index = 0; index < files.length; index += 1) {
    try {
      await importFileBlob(files[index], { x: placement.x + index * 24, y: placement.y + index * 24 });
    } catch (error) {
      displayError(error, `${files[index].name}: `);
    }
  }
}

async function handlePaste(event) {
  if (!state.document || state.presentation || event.target.matches("input, textarea, [contenteditable='true']")) return;
  const clipboard = event.clipboardData;
  const files = [...(clipboard?.files || [])].filter((file) => file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extensionOf(file.name)));
  if (files.length) {
    event.preventDefault();
    const placement = preferredPlacement();
    for (let index = 0; index < files.length; index += 1) {
      try {
        await importFileBlob(files[index], { x: placement.x + index * 24, y: placement.y + index * 24 });
      } catch (error) {
        displayError(error, "Could not paste image: ");
      }
    }
  } else if (clipboard?.getData(INTERNAL_CLIPBOARD_TYPE) === state.internalClipboard?.token) {
    event.preventDefault();
    pasteInternal();
  } else {
    const text = clipboard?.getData("text/plain") || "";
    if (!text) return;
    event.preventDefault();
    addTextCard(text);
    toast("Clipboard text added as a note.", "success");
  }
}

function keyboardHandler(event) {
  const command = event.ctrlKey || event.metaKey;
  const typing = event.target.matches("input, textarea, [contenteditable='true']");
  if (event.key === "F5") {
    event.preventDefault();
    if (state.presentation) exitPresentation();
    else enterPresentation();
    return;
  }
  if (state.presentation) {
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      exitPresentation();
    } else if (key === "ArrowLeft" || key === "PageUp") {
      event.preventDefault();
      movePresentation(-1);
    } else if (key === "ArrowRight" || key === "PageDown" || key === " " || key === "Enter") {
      event.preventDefault();
      movePresentation(1);
    } else if (key === "Home") {
      event.preventDefault();
      setPresentationSlide(0);
    } else if (key === "End") {
      event.preventDefault();
      setPresentationSlide(state.presentation.slideIds.length - 1);
    } else if (command || event.altKey) {
      event.preventDefault();
    }
    return;
  }
  if (event.key === "Escape" && !elements.youtubeDialog.hidden) {
    event.preventDefault();
    cancelYoutubeDownload();
    return;
  }
  if (event.code === "Space" && !typing) state.spaceHeld = true;
  if (typing) return;
  if (event.key === "Escape" && state.drawingTool !== "select") {
    event.preventDefault();
    setDrawingTool("select");
    return;
  }
  if (command && event.key.toLowerCase() === "n") { event.preventDefault(); dispatchAction("new"); }
  else if (command && event.key.toLowerCase() === "o") { event.preventDefault(); dispatchAction("open"); }
  else if (command && event.key.toLowerCase() === "i") { event.preventDefault(); dispatchAction("import"); }
  else if (command && event.key.toLowerCase() === "s") { event.preventDefault(); dispatchAction("save"); }
  else if (command && event.key.toLowerCase() === "t") { event.preventDefault(); addTextCard(); }
  else if (command && event.key.toLowerCase() === "z" && event.shiftKey) { event.preventDefault(); redo(); }
  else if (command && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
  else if (command && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
  else if (command && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelection(); }
  else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelection(); }
  else if (!command && event.key.toLowerCase() === "b") { event.preventDefault(); setDrawingTool("draw"); }
  else if (!command && event.key.toLowerCase() === "e") { event.preventDefault(); setDrawingTool("erase"); }
  else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(1.2); }
  else if (event.key === "-") { event.preventDefault(); zoomAt(1 / 1.2); }
  else if (event.key === "0") { event.preventDefault(); resetZoom(); }
  else if (event.key === "Home") { event.preventDefault(); frameAll(); }
  else if (event.key === "Escape") stopMusic();
}

function initializeEvents() {
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) dispatchAction(action);
    const menuButton = event.target.closest("[data-menu]");
    if (menuButton) {
      event.stopPropagation();
      toggleMenu(menuButton.dataset.menu, menuButton);
    } else if (!event.target.closest(".popup-menu")) closeMenus();
  });
  $$("[data-tab]").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  elements.titleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = elements.titleInput.value.trim();
    if (!title) return;
    elements.titleDialog.hidden = true;
    finishCreateBoard(title);
  });
  elements.youtubeForm.addEventListener("submit", submitYoutubeDownload);
  elements.youtubeCancel.addEventListener("click", cancelYoutubeDownload);
  elements.youtubeClose.addEventListener("click", cancelYoutubeDownload);
  elements.queueShuffle.addEventListener("change", () => {
    if (!state.document) return;
    mutate(() => { state.document.shuffleQueue = elements.queueShuffle.checked; });
  });

  elements.canvas.addEventListener("pointerdown", (event) => beginDrawingGesture(event), true);
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (state.presentation) return;
    if (state.document) state.lastPointerBoard = screenToBoard(event.clientX, event.clientY);
    if (beginPan(event)) return;
    if (event.target === elements.canvas || event.target === elements.world) {
      beginMarquee(event);
    }
  });
  elements.canvas.addEventListener("pointermove", showPresentationControls);
  elements.canvas.addEventListener("pointermove", handlePointerMove);
  elements.canvas.addEventListener("pointerup", finishPointer);
  elements.canvas.addEventListener("pointercancel", finishPointer);
  elements.canvas.addEventListener("wheel", (event) => {
    if (!state.document) return;
    event.preventDefault();
    if (state.presentation) {
      showPresentationControls();
      return;
    }
    zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
  }, { passive: false });

  elements.canvas.addEventListener("dragenter", (event) => {
    event.preventDefault();
    if (state.presentation) return;
    state.dragDepth += 1;
    elements.dropOverlay.hidden = false;
  });
  elements.canvas.addEventListener("dragover", (event) => event.preventDefault());
  elements.canvas.addEventListener("dragleave", () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) elements.dropOverlay.hidden = true;
  });
  elements.canvas.addEventListener("drop", handleDrop);
  elements.startTape.addEventListener("click", () => startQueue(false));
  elements.presentationControls.addEventListener("focusin", showPresentationControls);
  elements.presentationControls.addEventListener("focusout", showPresentationControls);

  window.addEventListener("keydown", keyboardHandler);
  window.addEventListener("keyup", (event) => { if (event.code === "Space") state.spaceHeld = false; });
  window.addEventListener("blur", () => { state.spaceHeld = false; });
  window.addEventListener("paste", handlePaste);
  window.addEventListener("copy", (event) => {
    if (state.presentation) {
      event.preventDefault();
      return;
    }
    const items = selectedItems().sort((first, second) => first.z - second.z);
    if (!items.length || event.target.matches("input, textarea, [contenteditable='true']")) return;
    const token = uid();
    state.internalClipboard = { items: clone(items), token };
    const clipboardText = items.length === 1 && items[0].kind === "text"
      ? items[0].text || ""
      : `Moodeur ${items.length} card${items.length === 1 ? "" : "s"}`;
    event.clipboardData?.setData("text/plain", clipboardText);
    event.clipboardData?.setData(INTERNAL_CLIPBOARD_TYPE, token);
    event.preventDefault();
    if (items.length === 1 && items[0].kind === "image") copyImageToClipboard(items[0]);
    else if (items.length === 1 && items[0].kind === "text") toast("Note text copied to the clipboard.", "success");
    else toast(`${items.length} card${items.length === 1 ? "" : "s"} copied. Paste at the pointer.`);
  });
  window.addEventListener("beforeunload", () => { if (state.dirty) saveBoard(); });
  window.addEventListener("resize", () => {
    if (!state.presentation) return;
    setPresentationSlide(state.presentation.index);
  });

  player.addEventListener("timeupdate", updatePlaybackUi);
  player.addEventListener("timeupdate", applyPresentationSoundtrackTailFade);
  player.addEventListener("play", updatePlaybackUi);
  player.addEventListener("pause", updatePlaybackUi);
  player.addEventListener("ended", () => playNextQueued(currentTrackId));
  player.addEventListener("error", () => {
    cancelPlayerVolumeFade();
    const failed = currentTrackId;
    if (failed && playingQueue) playNextQueued(failed, true);
    else if (failed) toast("This track could not be played by the native decoder.", "error");
  });
}

initializeEvents();
renderAll();
refreshRecentBoards();

if (!window.__TAURI__) {
  window.setTimeout(() => toast("Preview mode: launch with Tauri to create and open boards.", "error", 9000), 100);
}
