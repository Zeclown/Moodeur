use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{BufRead, BufReader, ErrorKind, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{ipc::InvokeBody, AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const BOARD_FILE: &str = "moodeur.json";
const BACKUP_FILE: &str = "moodeur.json.bak";
const MEDIA_DIR: &str = "media";
const RECENT_BOARDS_FILE: &str = "recent-boards.json";
const MAX_RECENT_BOARDS: usize = 10;
const SCHEMA_VERSION: u32 = 6;
const NOTE_PAPER_COLORS: [&str; 6] = [
    "#fff4b8", "#f2c3c9", "#cde4c1", "#c8d9ee", "#dccbed", "#f2cfaa",
];
const MARKER_COLORS: [&str; 6] = [
    "#b51f2e", "#1739ae", "#287052", "#b58b18", "#6b3e75", "#25232d",
];
const MAX_DRAWING_OPERATIONS: usize = 10_000;
const MAX_POINTS_PER_OPERATION: usize = 50_000;
const MAX_DRAWING_POINTS: usize = 500_000;

#[derive(Default)]
struct ActiveBoard(Mutex<Option<PathBuf>>);

#[derive(Clone)]
struct RunningDownload {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct DownloadManager(Mutex<Option<RunningDownload>>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Viewport {
    x: f64,
    y: f64,
    zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 120.0,
            y: 90.0,
            zoom: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum BackgroundPattern {
    Stipple,
    GraphGrid,
    RuledPaper,
    Checkerboard,
    Plain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BackgroundSettings {
    color: String,
    pattern: BackgroundPattern,
}

impl Default for BackgroundSettings {
    fn default() -> Self {
        Self {
            color: "#d6d2bc".to_string(),
            pattern: BackgroundPattern::Stipple,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum AssetKind {
    Image,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AssetRecord {
    id: String,
    kind: AssetKind,
    relative_path: String,
    original_name: String,
    mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Crop {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum DrawingMode {
    Draw,
    Erase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DrawingPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DrawingOperation {
    id: String,
    mode: DrawingMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    width: f64,
    points: Vec<DrawingPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ItemKind {
    Image,
    Audio,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum TextAlignment {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BoardItem {
    id: String,
    kind: ItemKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    z: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    crop: Option<Crop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paper_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_align: Option<TextAlignment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    drawings: Vec<DrawingOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BoardDocument {
    schema_version: u32,
    id: String,
    title: String,
    viewport: Viewport,
    #[serde(default)]
    background: BackgroundSettings,
    #[serde(default)]
    board_drawings: Vec<DrawingOperation>,
    assets: Vec<AssetRecord>,
    items: Vec<BoardItem>,
    autoplay_queue: Vec<String>,
    #[serde(default)]
    shuffle_queue: bool,
}

impl BoardDocument {
    fn new(title: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            id: Uuid::new_v4().to_string(),
            title,
            viewport: Viewport::default(),
            background: BackgroundSettings::default(),
            board_drawings: Vec::new(),
            assets: Vec::new(),
            items: Vec::new(),
            autoplay_queue: Vec::new(),
            shuffle_queue: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardResponse {
    board_path: String,
    document: BoardDocument,
    recovered_from_backup: bool,
    primary_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAck {
    saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RecentBoard {
    path: String,
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    phase: String,
    message: String,
    percent: Option<f64>,
}

fn err(message: impl Into<String>) -> String {
    message.into()
}

fn board_root(state: &State<'_, ActiveBoard>) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|_| err("Board state is unavailable"))?
        .clone()
        .ok_or_else(|| err("No board is open"))
}

fn set_board_root(state: &State<'_, ActiveBoard>, root: PathBuf) -> Result<(), String> {
    *state
        .0
        .lock()
        .map_err(|_| err("Board state is unavailable"))? = Some(root);
    Ok(())
}

fn recent_boards_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|e| err(format!("Could not locate Moodeur's settings folder: {e}")))?;
    fs::create_dir_all(&directory)
        .map_err(|e| err(format!("Could not create Moodeur's settings folder: {e}")))?;
    Ok(directory.join(RECENT_BOARDS_FILE))
}

fn read_recent_boards_file(path: &Path) -> Result<Vec<RecentBoard>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(err(format!("Could not read recent boards: {error}"))),
    };
    serde_json::from_slice(&bytes).map_err(|e| err(format!("Could not parse recent boards: {e}")))
}

fn write_recent_boards_file(path: &Path, boards: &[RecentBoard]) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(boards)
        .map_err(|e| err(format!("Could not serialize recent boards: {e}")))?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)
        .map_err(|e| err(format!("Could not create recent boards file: {e}")))?;
    file.write_all(&data)
        .and_then(|_| file.sync_all())
        .map_err(|e| err(format!("Could not finish recent boards file: {e}")))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|e| err(format!("Could not replace recent boards file: {e}")))?;
    }
    fs::rename(&temporary, path)
        .map_err(|e| err(format!("Could not install recent boards file: {e}")))
}

fn paths_match(first: &str, second: &str) -> bool {
    if cfg!(windows) {
        first.eq_ignore_ascii_case(second)
    } else {
        first == second
    }
}

fn remember_recent_board_file(path: &Path, board_root: &Path, title: &str) -> Result<(), String> {
    let board_path = board_root.to_string_lossy().into_owned();
    let mut boards = read_recent_boards_file(path).unwrap_or_default();
    boards.retain(|entry| !paths_match(&entry.path, &board_path));
    boards.insert(
        0,
        RecentBoard {
            path: board_path,
            title: title.to_string(),
        },
    );
    boards.truncate(MAX_RECENT_BOARDS);
    write_recent_boards_file(path, &boards)
}

fn remember_recent_board(app: &AppHandle, board_root: &Path, title: &str) -> Result<(), String> {
    remember_recent_board_file(&recent_boards_path(app)?, board_root, title)
}

fn validate_board_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 120 {
        return Err(err("Board title must contain 1 to 120 characters"));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(err("Board title contains invalid control characters"));
    }
    Ok(trimmed.to_string())
}

fn validate_document(document: &BoardDocument) -> Result<(), String> {
    if document.schema_version != SCHEMA_VERSION {
        return Err(err(format!(
            "Unsupported board version {} (this app supports version {})",
            document.schema_version, SCHEMA_VERSION
        )));
    }
    validate_board_name(&document.title)?;
    if !document.viewport.zoom.is_finite()
        || !(0.1..=4.0).contains(&document.viewport.zoom)
        || !document.viewport.x.is_finite()
        || !document.viewport.y.is_finite()
    {
        return Err(err("Board viewport contains invalid values"));
    }
    if !is_hex_color(&document.background.color) {
        return Err(err("Board background color must use #RRGGBB notation"));
    }

    let mut drawing_operation_count = 0;
    let mut drawing_point_count = 0;
    validate_drawing_operations(
        &document.board_drawings,
        false,
        &mut drawing_operation_count,
        &mut drawing_point_count,
    )?;

    let mut asset_ids = HashSet::new();
    for asset in &document.assets {
        if !asset_ids.insert(asset.id.as_str()) {
            return Err(err("Board contains duplicate asset identifiers"));
        }
        validate_relative_asset_path(&asset.relative_path)?;
    }

    let mut item_ids = HashSet::new();
    for item in &document.items {
        if !item_ids.insert(item.id.as_str()) {
            return Err(err("Board contains duplicate item identifiers"));
        }
        match &item.kind {
            ItemKind::Text => {
                if item.asset_id.is_some() {
                    return Err(err("Text items cannot reference media assets"));
                }
                if item.text.as_deref().unwrap_or_default().len() > 10_000 {
                    return Err(err("Text items are limited to 10,000 characters"));
                }
                let font_size = item.font_size.unwrap_or(28.0);
                if !font_size.is_finite() || !(10.0..=200.0).contains(&font_size) {
                    return Err(err("Text size must be between 10 and 200"));
                }
                if let Some(color) = &item.color {
                    if !is_hex_color(color) {
                        return Err(err("Text color must use #RRGGBB notation"));
                    }
                }
                if let Some(paper_color) = &item.paper_color {
                    if !NOTE_PAPER_COLORS
                        .iter()
                        .any(|allowed| allowed.eq_ignore_ascii_case(paper_color))
                    {
                        return Err(err("Note paper color is not in the Moodeur palette"));
                    }
                }
            }
            ItemKind::Image | ItemKind::Audio => {
                let asset_id = item
                    .asset_id
                    .as_deref()
                    .ok_or_else(|| err(format!("Item {} has no media asset", item.id)))?;
                if !asset_ids.contains(asset_id) {
                    return Err(err(format!("Item {} references a missing asset", item.id)));
                }
            }
        }
        if item.kind == ItemKind::Image {
            validate_drawing_operations(
                &item.drawings,
                true,
                &mut drawing_operation_count,
                &mut drawing_point_count,
            )?;
        } else if !item.drawings.is_empty() {
            return Err(err(
                "Only picture cards can contain attached marker drawings",
            ));
        }
        let values = [item.x, item.y, item.width, item.height, item.rotation];
        if values.iter().any(|value| !value.is_finite()) || item.width < 24.0 || item.height < 24.0
        {
            return Err(err("Board item contains invalid geometry"));
        }
        if let Some(volume) = item.volume {
            if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
                return Err(err("Audio volume must be between 0 and 1"));
            }
        }
        if let Some(crop) = &item.crop {
            let sides = [crop.left, crop.top, crop.right, crop.bottom];
            if sides
                .iter()
                .any(|side| !side.is_finite() || !(0.0..=0.9).contains(side))
                || crop.left + crop.right >= 0.95
                || crop.top + crop.bottom >= 0.95
            {
                return Err(err("Image crop is outside the valid range"));
            }
        }
    }

    for item_id in &document.autoplay_queue {
        let item = document
            .items
            .iter()
            .find(|item| item.id == *item_id)
            .ok_or_else(|| err("Autoplay queue references a missing item"))?;
        if item.kind != ItemKind::Audio {
            return Err(err("Autoplay queue may only contain music cards"));
        }
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_drawing_operations(
    operations: &[DrawingOperation],
    photo_coordinates: bool,
    operation_count: &mut usize,
    point_count: &mut usize,
) -> Result<(), String> {
    *operation_count = operation_count
        .checked_add(operations.len())
        .ok_or_else(|| err("Board contains too many drawing operations"))?;
    if *operation_count > MAX_DRAWING_OPERATIONS {
        return Err(err("Board contains too many drawing operations"));
    }

    for operation in operations {
        if operation.id.is_empty() || operation.id.len() > 128 {
            return Err(err("Drawing operation has an invalid identifier"));
        }
        if operation.points.is_empty() || operation.points.len() > MAX_POINTS_PER_OPERATION {
            return Err(err("Drawing operation has an invalid number of points"));
        }
        *point_count = point_count
            .checked_add(operation.points.len())
            .ok_or_else(|| err("Board contains too many drawing points"))?;
        if *point_count > MAX_DRAWING_POINTS {
            return Err(err("Board contains too many drawing points"));
        }

        let valid_width = if photo_coordinates {
            operation.width.is_finite() && (0.0001..=0.5).contains(&operation.width)
        } else {
            operation.width.is_finite() && (0.5..=100.0).contains(&operation.width)
        };
        if !valid_width {
            return Err(err("Drawing operation has an invalid marker width"));
        }

        match operation.mode {
            DrawingMode::Draw => {
                let color = operation
                    .color
                    .as_deref()
                    .ok_or_else(|| err("Marker drawing is missing its ink color"))?;
                if !MARKER_COLORS
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(color))
                {
                    return Err(err("Marker color is not in the Moodeur palette"));
                }
            }
            DrawingMode::Erase => {
                if operation.color.is_some() {
                    return Err(err("Eraser operations cannot contain an ink color"));
                }
            }
        }

        for point in &operation.points {
            if !point.x.is_finite() || !point.y.is_finite() {
                return Err(err("Drawing operation contains invalid coordinates"));
            }
            if photo_coordinates {
                if !(0.0..=1.0).contains(&point.x) || !(0.0..=1.0).contains(&point.y) {
                    return Err(err(
                        "Photo drawing coordinates must stay inside the picture card",
                    ));
                }
            } else if point.x.abs() > 10_000_000.0 || point.y.abs() > 10_000_000.0 {
                return Err(err("Board drawing coordinates are outside the valid range"));
            }
        }
    }
    Ok(())
}

fn validate_relative_asset_path(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err(err("Asset path must be relative"));
    }
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(first)) if first == MEDIA_DIR => {}
        _ => return Err(err("Asset path must be inside the media directory")),
    }
    if components
        .clone()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(err("Asset path contains unsafe components"));
    }
    if components.next().is_none() {
        return Err(err("Asset path must name a media file"));
    }
    Ok(path.to_path_buf())
}

fn parse_board(path: &Path) -> Result<BoardDocument, String> {
    let bytes =
        fs::read(path).map_err(|e| err(format!("Could not read {}: {e}", path.display())))?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| err(format!("Could not parse {}: {e}", path.display())))?;
    let version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| err("Board is missing a schema version"))? as u32;
    if (1..SCHEMA_VERSION).contains(&version) {
        value["schemaVersion"] = serde_json::json!(SCHEMA_VERSION);
    } else if version != SCHEMA_VERSION {
        return Err(err(format!(
            "Unsupported board version {version} (this app supports versions 1 through {SCHEMA_VERSION})"
        )));
    }
    let document: BoardDocument = serde_json::from_value(value)
        .map_err(|e| err(format!("Could not parse {}: {e}", path.display())))?;
    validate_document(&document)?;
    Ok(document)
}

fn write_board(root: &Path, document: &BoardDocument) -> Result<(), String> {
    validate_document(document)?;
    let data = serde_json::to_vec_pretty(document)
        .map_err(|e| err(format!("Could not serialize board: {e}")))?;
    let primary = root.join(BOARD_FILE);
    let backup = root.join(BACKUP_FILE);
    let temporary = root.join(format!("{BOARD_FILE}.tmp"));

    let mut file = File::create(&temporary)
        .map_err(|e| err(format!("Could not create temporary save: {e}")))?;
    file.write_all(&data)
        .and_then(|_| file.sync_all())
        .map_err(|e| err(format!("Could not finish temporary save: {e}")))?;
    parse_board(&temporary)?;

    if primary.exists() {
        // Never replace a known-good recovery file with a corrupt primary.
        if parse_board(&primary).is_ok() {
            fs::copy(&primary, &backup)
                .map_err(|e| err(format!("Could not update board backup: {e}")))?;
        }
        fs::remove_file(&primary)
            .map_err(|e| err(format!("Could not replace the previous board: {e}")))?;
    }
    if let Err(rename_error) = fs::rename(&temporary, &primary) {
        if !primary.exists() && backup.exists() {
            let _ = fs::copy(&backup, &primary);
        }
        return Err(err(format!(
            "Could not install the new board save: {rename_error}"
        )));
    }
    Ok(())
}

fn extension_info(extension: &str) -> Option<(AssetKind, &'static str, &'static str)> {
    let normalized = extension.trim_start_matches('.').to_ascii_lowercase();
    match normalized.as_str() {
        "jpg" | "jpeg" => Some((AssetKind::Image, "jpg", "image/jpeg")),
        "png" => Some((AssetKind::Image, "png", "image/png")),
        "gif" => Some((AssetKind::Image, "gif", "image/gif")),
        "webp" => Some((AssetKind::Image, "webp", "image/webp")),
        "avif" => Some((AssetKind::Image, "avif", "image/avif")),
        "svg" => Some((AssetKind::Image, "svg", "image/svg+xml")),
        "bmp" => Some((AssetKind::Image, "bmp", "image/bmp")),
        "mp3" => Some((AssetKind::Audio, "mp3", "audio/mpeg")),
        "wav" => Some((AssetKind::Audio, "wav", "audio/wav")),
        "m4a" => Some((AssetKind::Audio, "m4a", "audio/mp4")),
        "aac" => Some((AssetKind::Audio, "aac", "audio/aac")),
        "ogg" => Some((AssetKind::Audio, "ogg", "audio/ogg")),
        "flac" => Some((AssetKind::Audio, "flac", "audio/flac")),
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                decoded.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| "Pasted image".to_string())
}

fn safe_original_name(name: &str, fallback_extension: &str) -> String {
    let file_name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported file")
        .trim();
    if file_name.is_empty() {
        format!("Imported file.{fallback_extension}")
    } else {
        file_name.chars().take(180).collect()
    }
}

fn save_media_bytes(
    root: &Path,
    bytes: &[u8],
    extension: &str,
    original_name: &str,
) -> Result<AssetRecord, String> {
    let (kind, canonical_extension, mime_type) = extension_info(extension)
        .ok_or_else(|| err(format!("Unsupported media extension: {extension}")))?;
    if bytes.is_empty() {
        return Err(err("The imported media file is empty"));
    }
    let id = Uuid::new_v4().to_string();
    let file_name = format!("{id}.{canonical_extension}");
    let media_dir = root.join(MEDIA_DIR);
    fs::create_dir_all(&media_dir)
        .map_err(|e| err(format!("Could not create board media directory: {e}")))?;
    let destination = media_dir.join(&file_name);
    let mut output = File::create(&destination)
        .map_err(|e| err(format!("Could not create imported media: {e}")))?;
    output
        .write_all(bytes)
        .and_then(|_| output.sync_all())
        .map_err(|e| err(format!("Could not copy imported media: {e}")))?;

    Ok(AssetRecord {
        id,
        kind,
        relative_path: format!("{MEDIA_DIR}/{file_name}"),
        original_name: safe_original_name(original_name, canonical_extension),
        mime_type: mime_type.to_string(),
        width: None,
        height: None,
        duration: None,
    })
}

fn allow_media(app: &AppHandle, root: &Path) -> Result<(), String> {
    let media = root.join(MEDIA_DIR);
    app.asset_protocol_scope()
        .allow_directory(&media, true)
        .map_err(|e| err(format!("Could not allow board media access: {e}")))
}

fn validate_youtube_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 2_048 || trimmed.chars().any(char::is_control) {
        return Err(err("Enter a valid YouTube video URL"));
    }
    let remainder = trimmed
        .strip_prefix("https://")
        .ok_or_else(|| err("YouTube links must begin with https://"))?;
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(err("Enter a valid YouTube video URL"));
    }
    let mut host_parts = authority.split(':');
    let host = host_parts.next().unwrap_or_default().to_ascii_lowercase();
    if let Some(port) = host_parts.next() {
        if port != "443" || host_parts.next().is_some() {
            return Err(err("YouTube links may only use the standard HTTPS port"));
        }
    }
    let allowed = matches!(
        host.as_str(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be"
    );
    if !allowed {
        return Err(err("Only youtube.com and youtu.be links are accepted"));
    }
    Ok(trimmed.to_string())
}

fn sidecar_target_triple() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        (os, architecture) => Err(err(format!(
            "YouTube import is not packaged for {os}/{architecture}"
        ))),
    }
}

fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let executable_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let current_executable = std::env::current_exe()
        .map_err(|e| err(format!("Could not locate Moodeur's executable: {e}")))?;
    if let Some(directory) = current_executable.parent() {
        let packaged = directory.join(&executable_name);
        if packaged.is_file() {
            return Ok(packaged);
        }
    }

    let extension = if cfg!(windows) { ".exe" } else { "" };
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{}{extension}", sidecar_target_triple()?));
    if development.is_file() {
        Ok(development)
    } else {
        Err(err(format!("Moodeur's {name} utility is missing")))
    }
}

fn progress_from_line(line: &str) -> Option<DownloadProgress> {
    let payload = line.strip_prefix("MOODEUR_PROGRESS:")?;
    let mut parts = payload.split('|').map(str::trim);
    let percent_text = parts.next()?.trim_end_matches('%').trim();
    let percent = percent_text.parse::<f64>().ok();
    let speed = parts
        .next()
        .filter(|value| !value.is_empty() && *value != "NA");
    let eta = parts
        .next()
        .filter(|value| !value.is_empty() && *value != "NA");
    let mut message = percent
        .map(|value| format!("Recording tape… {value:.1}%"))
        .unwrap_or_else(|| "Recording tape…".to_string());
    if let Some(speed) = speed {
        message.push_str(&format!(" · {speed}"));
    }
    if let Some(eta) = eta {
        message.push_str(&format!(" · {eta} left"));
    }
    Some(DownloadProgress {
        phase: "downloading".to_string(),
        message,
        percent,
    })
}

fn emit_download_progress(app: &AppHandle, progress: DownloadProgress) {
    let _ = app.emit("youtube-download-progress", progress);
}

fn remember_process_output(lines: &Arc<Mutex<VecDeque<String>>>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if let Ok(mut lines) = lines.lock() {
        lines.push_back(line.trim().to_string());
        while lines.len() > 24 {
            lines.pop_front();
        }
    }
}

#[cfg(windows)]
fn hide_process_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_process_window(_command: &mut Command) {}

fn cleanup_download_directory(path: &Path) {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("moodeur-youtube-"))
    {
        let _ = fs::remove_dir_all(path);
    }
}

#[tauri::command]
async fn download_youtube_audio(
    app: AppHandle,
    active_board: State<'_, ActiveBoard>,
    downloads: State<'_, DownloadManager>,
    url: String,
    permission_confirmed: bool,
) -> Result<AssetRecord, String> {
    if !permission_confirmed {
        return Err(err(
            "Confirm that you have permission to download this audio",
        ));
    }
    let url = validate_youtube_url(&url)?;
    let board = board_root(&active_board)?;
    let yt_dlp = sidecar_path("yt-dlp")?;
    let quickjs = sidecar_path("qjs")?;
    let temporary = std::env::temp_dir().join(format!("moodeur-youtube-{}", Uuid::new_v4()));
    fs::create_dir(&temporary)
        .map_err(|e| err(format!("Could not create a temporary download folder: {e}")))?;

    let output_template = temporary.join("%(id)s.%(ext)s");
    let runtime_argument = format!("quickjs:{}", quickjs.to_string_lossy());
    let mut command = Command::new(&yt_dlp);
    command
        .arg("--ignore-config")
        .arg("--no-playlist")
        .arg("--no-overwrites")
        .arg("--no-colors")
        .arg("--newline")
        .arg("--progress-delta")
        .arg("0.2")
        .arg("--progress-template")
        .arg("download:MOODEUR_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s")
        .arg("--js-runtimes")
        .arg(runtime_argument)
        .arg("--write-info-json")
        .arg("--no-write-playlist-metafiles")
        .arg("-f")
        .arg("bestaudio[ext=m4a]")
        .arg("-o")
        .arg(&output_template)
        .arg("--")
        .arg(&url)
        .current_dir(&temporary)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_process_window(&mut command);

    let mut child = command.spawn().map_err(|e| {
        cleanup_download_directory(&temporary);
        err(format!("Could not start Moodeur's downloader: {e}"))
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let running = RunningDownload {
        child: Arc::new(Mutex::new(child)),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    {
        let mut slot = downloads
            .0
            .lock()
            .map_err(|_| err("Download manager is unavailable"))?;
        if slot.is_some() {
            if let Ok(mut child) = running.child.lock() {
                let _ = child.kill();
            }
            cleanup_download_directory(&temporary);
            return Err(err("Another YouTube download is already running"));
        }
        *slot = Some(running.clone());
    }

    emit_download_progress(
        &app,
        DownloadProgress {
            phase: "starting".to_string(),
            message: "Finding the audio track…".to_string(),
            percent: Some(0.0),
        },
    );
    let output_lines = Arc::new(Mutex::new(VecDeque::new()));
    let stdout_lines = output_lines.clone();
    let stdout_app = app.clone();
    let stdout_thread = thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(progress) = progress_from_line(&line) {
                    emit_download_progress(&stdout_app, progress);
                } else {
                    remember_process_output(&stdout_lines, &line);
                }
            }
        }
    });
    let stderr_lines = output_lines.clone();
    let stderr_thread = thread::spawn(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                remember_process_output(&stderr_lines, &line);
            }
        }
    });

    let wait_child = running.child.clone();
    let wait_result = tauri::async_runtime::spawn_blocking(move || loop {
        let result = wait_child
            .lock()
            .map_err(|_| err("Download process is unavailable"))?
            .try_wait()
            .map_err(|e| err(format!("Could not check the download process: {e}")))?;
        if let Some(status) = result {
            break Ok(status);
        }
        thread::sleep(Duration::from_millis(100));
    })
    .await;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    if let Ok(mut slot) = downloads.0.lock() {
        *slot = None;
    }
    let status_result = match wait_result {
        Ok(result) => result,
        Err(error) => {
            cleanup_download_directory(&temporary);
            return Err(err(format!("Download task failed: {error}")));
        }
    };
    let status = match status_result {
        Ok(status) => status,
        Err(error) => {
            cleanup_download_directory(&temporary);
            return Err(error);
        }
    };

    if running.cancelled.load(Ordering::SeqCst) {
        cleanup_download_directory(&temporary);
        return Err(err("Download cancelled"));
    }
    if !status.success() {
        let details = output_lines
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        cleanup_download_directory(&temporary);
        let message = if details.is_empty() {
            "YouTube did not provide a downloadable M4A audio track".to_string()
        } else {
            details
        };
        return Err(err(message));
    }

    let entries = fs::read_dir(&temporary)
        .map_err(|e| err(format!("Could not inspect the completed download: {e}")))?;
    let mut audio_path = None;
    let mut info_path = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("m4a") {
            audio_path = Some(path);
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.ends_with(".info.json"))
        {
            info_path = Some(path);
        }
    }
    let audio_path = audio_path.ok_or_else(|| {
        cleanup_download_directory(&temporary);
        err("The download finished without an M4A audio file")
    })?;
    let metadata = info_path
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let title = metadata
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("YouTube audio");
    let duration = metadata
        .as_ref()
        .and_then(|value| value.get("duration"))
        .and_then(|value| value.as_f64());
    let bytes = fs::read(&audio_path).map_err(|e| {
        cleanup_download_directory(&temporary);
        err(format!("Could not read the downloaded audio: {e}"))
    })?;
    let asset_result = save_media_bytes(&board, &bytes, "m4a", &format!("{title}.m4a"));
    cleanup_download_directory(&temporary);
    let mut asset = asset_result?;
    asset.duration = duration;
    emit_download_progress(
        &app,
        DownloadProgress {
            phase: "finished".to_string(),
            message: "Tape recorded. Adding it to the board…".to_string(),
            percent: Some(100.0),
        },
    );
    Ok(asset)
}

#[tauri::command]
fn cancel_youtube_download(downloads: State<'_, DownloadManager>) -> Result<(), String> {
    let running = downloads
        .0
        .lock()
        .map_err(|_| err("Download manager is unavailable"))?
        .clone();
    if let Some(running) = running {
        running.cancelled.store(true, Ordering::SeqCst);
        running
            .child
            .lock()
            .map_err(|_| err("Download process is unavailable"))?
            .kill()
            .map_err(|e| err(format!("Could not cancel the download: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
fn create_board(
    app: AppHandle,
    state: State<'_, ActiveBoard>,
    board_dir: String,
    title: String,
) -> Result<BoardResponse, String> {
    let title = validate_board_name(&title)?;
    let root = PathBuf::from(board_dir);
    fs::create_dir_all(&root).map_err(|e| err(format!("Could not create board folder: {e}")))?;
    let root =
        fs::canonicalize(&root).map_err(|e| err(format!("Could not open board folder: {e}")))?;
    if root.join(BOARD_FILE).exists() {
        return Err(err("That folder already contains a Moodeur board"));
    }
    fs::create_dir_all(root.join(MEDIA_DIR))
        .map_err(|e| err(format!("Could not create media folder: {e}")))?;
    let document = BoardDocument::new(title);
    write_board(&root, &document)?;
    set_board_root(&state, root.clone())?;
    allow_media(&app, &root)?;
    let _ = remember_recent_board(&app, &root, &document.title);
    Ok(BoardResponse {
        board_path: root.to_string_lossy().into_owned(),
        document,
        recovered_from_backup: false,
        primary_error: None,
    })
}

#[tauri::command]
fn open_board(
    app: AppHandle,
    state: State<'_, ActiveBoard>,
    board_dir: String,
) -> Result<BoardResponse, String> {
    let root = fs::canonicalize(PathBuf::from(board_dir))
        .map_err(|e| err(format!("Could not open board folder: {e}")))?;
    if !root.is_dir() {
        return Err(err("The selected board path is not a folder"));
    }
    let primary = root.join(BOARD_FILE);
    let backup = root.join(BACKUP_FILE);
    let (document, recovered, primary_error) = match parse_board(&primary) {
        Ok(document) => (document, false, None),
        Err(primary_error) => match parse_board(&backup) {
            Ok(document) => (document, true, Some(primary_error)),
            Err(backup_error) => {
                return Err(err(format!(
                    "The board and its backup could not be opened. Board: {primary_error}. Backup: {backup_error}"
                )))
            }
        },
    };
    fs::create_dir_all(root.join(MEDIA_DIR))
        .map_err(|e| err(format!("Could not access board media directory: {e}")))?;
    set_board_root(&state, root.clone())?;
    allow_media(&app, &root)?;
    let _ = remember_recent_board(&app, &root, &document.title);
    Ok(BoardResponse {
        board_path: root.to_string_lossy().into_owned(),
        document,
        recovered_from_backup: recovered,
        primary_error,
    })
}

#[tauri::command]
fn list_recent_boards(app: AppHandle) -> Result<Vec<RecentBoard>, String> {
    let path = recent_boards_path(&app)?;
    let mut boards = read_recent_boards_file(&path).unwrap_or_default();
    boards.retain(|entry| {
        let root = Path::new(&entry.path);
        root.is_dir() && (root.join(BOARD_FILE).is_file() || root.join(BACKUP_FILE).is_file())
    });
    boards.truncate(MAX_RECENT_BOARDS);
    let _ = write_recent_boards_file(&path, &boards);
    Ok(boards)
}

#[tauri::command]
fn save_board(state: State<'_, ActiveBoard>, document: BoardDocument) -> Result<SaveAck, String> {
    let root = board_root(&state)?;
    write_board(&root, &document)?;
    Ok(SaveAck { saved: true })
}

#[tauri::command]
fn import_paths(
    state: State<'_, ActiveBoard>,
    paths: Vec<String>,
) -> Result<Vec<AssetRecord>, String> {
    let root = board_root(&state)?;
    let mut imported = Vec::new();
    for source_text in paths {
        let source = PathBuf::from(&source_text);
        if !source.is_file() {
            return Err(err(format!("Not a readable file: {}", source.display())));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                err(format!(
                    "File has no supported extension: {}",
                    source.display()
                ))
            })?;
        extension_info(extension)
            .ok_or_else(|| err(format!("Unsupported file type: {}", source.display())))?;
        let bytes = fs::read(&source)
            .map_err(|e| err(format!("Could not read {}: {e}", source.display())))?;
        let original_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Imported file");
        imported.push(save_media_bytes(&root, &bytes, extension, original_name)?);
    }
    Ok(imported)
}

#[tauri::command]
fn import_blob(
    state: State<'_, ActiveBoard>,
    request: tauri::ipc::Request<'_>,
) -> Result<AssetRecord, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(err("Imported clipboard or drop data must be binary"));
    };
    let extension = request
        .headers()
        .get("x-moodeur-extension")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("png");
    let encoded_name = request
        .headers()
        .get("x-moodeur-name")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("Pasted%20image.png");
    let root = board_root(&state)?;
    save_media_bytes(&root, bytes, extension, &percent_decode(encoded_name))
}

#[tauri::command]
fn asset_paths(
    state: State<'_, ActiveBoard>,
    relative_paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let root = board_root(&state)?;
    relative_paths
        .into_iter()
        .map(|relative| {
            let validated = validate_relative_asset_path(&relative)?;
            let full = root.join(validated);
            if full.is_file() {
                Ok(Some(full.to_string_lossy().into_owned()))
            } else {
                Ok(None)
            }
        })
        .collect()
}

#[tauri::command]
fn open_media_folder(state: State<'_, ActiveBoard>) -> Result<(), String> {
    let root = board_root(&state)?;
    let media = root.join(MEDIA_DIR);
    fs::create_dir_all(&media)
        .map_err(|e| err(format!("Could not create {}: {e}", media.display())))?;

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(&media)
        .spawn()
        .map_err(|e| err(format!("Could not open {}: {e}", media.display())))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ActiveBoard::default())
        .manage(DownloadManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_board,
            open_board,
            list_recent_boards,
            download_youtube_audio,
            cancel_youtube_download,
            save_board,
            import_paths,
            import_blob,
            asset_paths,
            open_media_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moodeur");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_paths_outside_media() {
        assert!(validate_relative_asset_path("../secret.jpg").is_err());
        assert!(validate_relative_asset_path("media/../secret.jpg").is_err());
        assert!(validate_relative_asset_path("pictures/file.jpg").is_err());
        assert!(validate_relative_asset_path("media/photo.jpg").is_ok());
    }

    #[test]
    fn rejects_unknown_schema_versions() {
        let mut board = BoardDocument::new("Test".to_string());
        board.schema_version = SCHEMA_VERSION + 1;
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("Unsupported board version"));
    }

    #[test]
    fn saves_and_reopens_unicode_board() {
        let directory = tempdir().unwrap();
        let board = BoardDocument::new("Rêves d’été 🎵".to_string());
        write_board(directory.path(), &board).unwrap();
        let reopened = parse_board(&directory.path().join(BOARD_FILE)).unwrap();
        assert_eq!(reopened, board);
    }

    #[test]
    fn maintains_one_valid_backup() {
        let directory = tempdir().unwrap();
        let first = BoardDocument::new("First".to_string());
        write_board(directory.path(), &first).unwrap();
        let mut second = first.clone();
        second.title = "Second".to_string();
        write_board(directory.path(), &second).unwrap();
        assert_eq!(
            parse_board(&directory.path().join(BOARD_FILE)).unwrap(),
            second
        );
        assert_eq!(
            parse_board(&directory.path().join(BACKUP_FILE)).unwrap(),
            first
        );
    }

    #[test]
    fn restoring_does_not_replace_good_backup_with_corrupt_primary() {
        let directory = tempdir().unwrap();
        let recovered = BoardDocument::new("Recovered".to_string());
        fs::write(
            directory.path().join(BACKUP_FILE),
            serde_json::to_vec(&recovered).unwrap(),
        )
        .unwrap();
        fs::write(directory.path().join(BOARD_FILE), b"not valid json").unwrap();
        write_board(directory.path(), &recovered).unwrap();
        assert_eq!(
            parse_board(&directory.path().join(BOARD_FILE)).unwrap(),
            recovered
        );
        assert_eq!(
            parse_board(&directory.path().join(BACKUP_FILE)).unwrap(),
            recovered
        );
    }

    #[test]
    fn imported_media_names_never_collide() {
        let directory = tempdir().unwrap();
        let first = save_media_bytes(directory.path(), b"one", "png", "same.png").unwrap();
        let second = save_media_bytes(directory.path(), b"two", "png", "same.png").unwrap();
        assert_ne!(first.relative_path, second.relative_path);
        assert!(directory.path().join(first.relative_path).is_file());
        assert!(directory.path().join(second.relative_path).is_file());
    }

    #[test]
    fn invalid_references_are_rejected() {
        let mut board = BoardDocument::new("Test".to_string());
        board.items.push(BoardItem {
            id: "item".to_string(),
            kind: ItemKind::Image,
            asset_id: Some("missing".to_string()),
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 0.0,
            z: 1,
            crop: None,
            volume: None,
            text: None,
            font_size: None,
            color: None,
            paper_color: None,
            text_align: None,
            drawings: Vec::new(),
        });
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("missing asset"));
    }

    #[test]
    fn migrates_old_boards_with_the_original_background() {
        let directory = tempdir().unwrap();
        for version in [1, 2, 3, 4, 5] {
            let board = BoardDocument::new(format!("Version {version}"));
            let mut value = serde_json::to_value(&board).unwrap();
            value["schemaVersion"] = serde_json::json!(version);
            if version < 3 {
                value.as_object_mut().unwrap().remove("background");
            }
            value.as_object_mut().unwrap().remove("shuffleQueue");
            value.as_object_mut().unwrap().remove("boardDrawings");
            fs::write(
                directory.path().join(BOARD_FILE),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            let migrated = parse_board(&directory.path().join(BOARD_FILE)).unwrap();
            assert_eq!(migrated.schema_version, SCHEMA_VERSION);
            assert_eq!(migrated.background, BackgroundSettings::default());
            assert!(!migrated.shuffle_queue);
            assert!(migrated.board_drawings.is_empty());
        }
    }

    #[test]
    fn saves_and_reopens_marker_drawings() {
        let directory = tempdir().unwrap();
        let mut board = BoardDocument::new("Sketchbook".to_string());
        board.board_drawings.push(DrawingOperation {
            id: "stroke-1".to_string(),
            mode: DrawingMode::Draw,
            color: Some("#b51f2e".to_string()),
            width: 6.0,
            points: vec![
                DrawingPoint { x: -20.0, y: 15.0 },
                DrawingPoint { x: 80.0, y: 65.0 },
            ],
        });
        board.board_drawings.push(DrawingOperation {
            id: "erase-1".to_string(),
            mode: DrawingMode::Erase,
            color: None,
            width: 18.0,
            points: vec![DrawingPoint { x: 25.0, y: 30.0 }],
        });
        write_board(directory.path(), &board).unwrap();
        assert_eq!(
            parse_board(&directory.path().join(BOARD_FILE)).unwrap(),
            board
        );
    }

    #[test]
    fn rejects_invalid_marker_drawings() {
        let mut board = BoardDocument::new("Sketchbook".to_string());
        board.board_drawings.push(DrawingOperation {
            id: "bad-color".to_string(),
            mode: DrawingMode::Draw,
            color: Some("#ffffff".to_string()),
            width: 6.0,
            points: vec![DrawingPoint { x: 0.0, y: 0.0 }],
        });
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("Moodeur palette"));

        board.board_drawings[0].color = Some("#b51f2e".to_string());
        board.board_drawings[0].points[0].x = f64::INFINITY;
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("invalid coordinates"));

        board.board_drawings[0].points =
            vec![DrawingPoint { x: 0.0, y: 0.0 }; MAX_POINTS_PER_OPERATION + 1];
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("invalid number of points"));
    }

    #[test]
    fn saves_and_reopens_queue_shuffle_option() {
        let directory = tempdir().unwrap();
        let mut board = BoardDocument::new("Mixtape".to_string());
        board.shuffle_queue = true;
        write_board(directory.path(), &board).unwrap();
        assert!(
            parse_board(&directory.path().join(BOARD_FILE))
                .unwrap()
                .shuffle_queue
        );
    }

    #[test]
    fn saves_and_reopens_custom_background() {
        let directory = tempdir().unwrap();
        let mut board = BoardDocument::new("Wallpaper".to_string());
        board.background = BackgroundSettings {
            color: "#353545".to_string(),
            pattern: BackgroundPattern::GraphGrid,
        };
        write_board(directory.path(), &board).unwrap();
        assert_eq!(
            parse_board(&directory.path().join(BOARD_FILE)).unwrap(),
            board
        );
    }

    #[test]
    fn rejects_invalid_background_settings() {
        let mut board = BoardDocument::new("Wallpaper".to_string());
        board.background.color = "red".to_string();
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("background color"));

        let mut value = serde_json::to_value(BoardDocument::new("Wallpaper".to_string())).unwrap();
        value["background"]["pattern"] = serde_json::json!("future-pattern");
        assert!(serde_json::from_value::<BoardDocument>(value).is_err());
    }

    #[test]
    fn validates_text_items_without_assets() {
        let mut board = BoardDocument::new("Words".to_string());
        board.items.push(BoardItem {
            id: "words".to_string(),
            kind: ItemKind::Text,
            asset_id: None,
            x: 10.0,
            y: 20.0,
            width: 240.0,
            height: 100.0,
            rotation: -2.0,
            z: 1,
            crop: None,
            volume: None,
            text: Some("Remember this feeling".to_string()),
            font_size: Some(30.0),
            color: Some("#4b2142".to_string()),
            paper_color: Some("#c8d9ee".to_string()),
            text_align: Some(TextAlignment::Center),
            drawings: Vec::new(),
        });
        validate_document(&board).unwrap();
        assert_eq!(board.items[0].text_align, Some(TextAlignment::Center));
        let mut invalid_alignment = serde_json::to_value(&board).unwrap();
        invalid_alignment["items"][0]["textAlign"] = serde_json::json!("justify");
        assert!(serde_json::from_value::<BoardDocument>(invalid_alignment).is_err());
        board.items[0].paper_color = Some("#000000".to_string());
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("Moodeur palette"));
    }

    #[test]
    fn rejects_marker_drawings_on_non_picture_items() {
        let mut board = BoardDocument::new("Words".to_string());
        board.items.push(BoardItem {
            id: "words".to_string(),
            kind: ItemKind::Text,
            asset_id: None,
            x: 10.0,
            y: 20.0,
            width: 240.0,
            height: 100.0,
            rotation: 0.0,
            z: 1,
            crop: None,
            volume: None,
            text: Some("No marker layer here".to_string()),
            font_size: Some(28.0),
            color: Some("#4b2142".to_string()),
            paper_color: Some("#fff4b8".to_string()),
            text_align: None,
            drawings: vec![DrawingOperation {
                id: "stroke".to_string(),
                mode: DrawingMode::Draw,
                color: Some("#b51f2e".to_string()),
                width: 0.02,
                points: vec![DrawingPoint { x: 0.5, y: 0.5 }],
            }],
        });
        assert!(validate_document(&board)
            .unwrap_err()
            .contains("Only picture cards"));
    }

    #[test]
    fn recent_boards_are_deduplicated_and_capped() {
        let directory = tempdir().unwrap();
        let settings = directory.path().join(RECENT_BOARDS_FILE);
        let first = directory.path().join("First Board");
        fs::create_dir(&first).unwrap();
        remember_recent_board_file(&settings, &first, "First").unwrap();
        remember_recent_board_file(&settings, &first, "First Renamed").unwrap();
        let deduplicated = read_recent_boards_file(&settings).unwrap();
        assert_eq!(deduplicated.len(), 1);
        assert_eq!(deduplicated[0].title, "First Renamed");

        for index in 0..12 {
            let root = directory.path().join(format!("Board {index}"));
            fs::create_dir(&root).unwrap();
            remember_recent_board_file(&settings, &root, &format!("Board {index}")).unwrap();
        }

        let boards = read_recent_boards_file(&settings).unwrap();
        assert_eq!(boards.len(), MAX_RECENT_BOARDS);
        assert_eq!(boards[0].title, "Board 11");
        assert_eq!(boards[9].title, "Board 2");
        assert_eq!(
            boards.iter().filter(|entry| entry.title == "First").count(),
            0
        );
    }

    #[test]
    fn youtube_urls_are_strictly_scoped() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=abc123").is_ok());
        assert!(validate_youtube_url("https://youtu.be/abc123").is_ok());
        assert!(validate_youtube_url("https://music.youtube.com/watch?v=abc123").is_ok());
        assert!(validate_youtube_url("http://youtube.com/watch?v=abc123").is_err());
        assert!(validate_youtube_url("https://youtube.com.evil.test/watch?v=abc123").is_err());
        assert!(validate_youtube_url("https://user@youtube.com/watch?v=abc123").is_err());
        assert!(validate_youtube_url("https://youtube.com:444/watch?v=abc123").is_err());
    }

    #[test]
    fn youtube_progress_lines_are_parsed() {
        let progress = progress_from_line("MOODEUR_PROGRESS: 42.5%|1.2MiB/s|00:03").unwrap();
        assert_eq!(progress.phase, "downloading");
        assert_eq!(progress.percent, Some(42.5));
        assert!(progress.message.contains("1.2MiB/s"));
        assert!(progress.message.contains("00:03 left"));
        assert!(progress_from_line("ordinary downloader output").is_none());
    }
}
