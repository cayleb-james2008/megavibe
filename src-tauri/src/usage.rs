use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_PROFILE_IDS: usize = 100;
const MAX_LOG_FILES: usize = 1_500;
const MAX_LOG_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LOG_RECORDS: usize = 1_000_000;
const MAX_PROBE_OUTPUT: usize = 32 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalytics {
    days: u32,
    dates: Vec<String>,
    series: Vec<UsageSeries>,
    files_scanned: usize,
    files_skipped: usize,
    records_skipped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSeries {
    cli: String,
    profile_id: Option<String>,
    daily: Vec<u64>,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProbe {
    cli: String,
    checked_at: u64,
    periods: Vec<UsagePeriod>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsagePeriod {
    label: String,
    used_percent: u8,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default)]
struct ClaudeTokenUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_input_tokens: u64,
    cache_read_input_tokens: u64,
}

impl ClaudeTokenUsage {
    fn max_with(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.max(other.input_tokens),
            output_tokens: self.output_tokens.max(other.output_tokens),
            cache_creation_input_tokens: self
                .cache_creation_input_tokens
                .max(other.cache_creation_input_tokens),
            cache_read_input_tokens: self
                .cache_read_input_tokens
                .max(other.cache_read_input_tokens),
        }
    }

    fn total(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_creation_input_tokens)
            .saturating_add(self.cache_read_input_tokens)
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ClaudeMessage {
    id: Option<String>,
    usage: Option<ClaudeTokenUsage>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ClaudeRecord {
    #[serde(rename = "type")]
    record_type: Option<String>,
    timestamp: Option<Timestamp>,
    message: Option<ClaudeMessage>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default)]
struct CodexTokenUsage {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}

impl CodexTokenUsage {
    fn total(self) -> u64 {
        if self.total_tokens > 0 {
            self.total_tokens
        } else {
            self.input_tokens.saturating_add(self.output_tokens)
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CodexPayload {
    response_id: Option<String>,
    usage: Option<CodexTokenUsage>,
    info: Option<CodexTokenSnapshot>,
    total_token_usage: Option<CodexTokenUsage>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CodexTokenSnapshot {
    total_token_usage: Option<CodexTokenUsage>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CodexRecord {
    #[serde(rename = "type")]
    record_type: Option<String>,
    timestamp: Option<Timestamp>,
    payload: Option<CodexPayload>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default)]
struct GeminiTokenUsage {
    input: u64,
    output: u64,
    cached: u64,
    thoughts: u64,
    tool: u64,
    total: u64,
}

impl GeminiTokenUsage {
    fn total(self) -> u64 {
        if self.total > 0 {
            self.total
        } else {
            self.input
                .saturating_add(self.output)
                .saturating_add(self.thoughts)
                .saturating_add(self.tool)
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct GeminiMessage {
    #[serde(rename = "type")]
    message_type: Option<String>,
    timestamp: Option<Timestamp>,
    tokens: Option<GeminiTokenUsage>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct GeminiRecord {
    #[serde(rename = "type")]
    message_type: Option<String>,
    timestamp: Option<Timestamp>,
    tokens: Option<GeminiTokenUsage>,
    messages: Option<Vec<GeminiMessage>>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum Timestamp {
    Text(String),
    Number(u64),
}

impl Default for Timestamp {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

impl Timestamp {
    fn date(&self) -> Option<String> {
        match self {
            Self::Text(value) => iso_date_utc(value),
            Self::Number(value) => {
                let seconds = if *value > 100_000_000_000 {
                    value / 1000
                } else {
                    *value
                };
                Some(day_number_to_date((seconds / 86_400) as i64))
            }
        }
    }
}

#[derive(Clone)]
struct ScanTarget {
    profile_id: Option<String>,
    home: PathBuf,
}

#[derive(Clone, Hash, PartialEq, Eq, PartialOrd, Ord)]
struct SeriesKey {
    cli: &'static str,
    profile_id: Option<String>,
}

#[derive(Default)]
struct ScanOutput {
    daily: BTreeMap<(String, SeriesKey), u64>,
    files_scanned: usize,
    files_skipped: usize,
    bytes_scanned: u64,
    records_skipped: bool,
}

pub fn load_analytics(
    app: &AppHandle,
    requested_days: u32,
    profile_ids: &[String],
) -> Result<UsageAnalytics, String> {
    let days = match requested_days {
        7 | 30 | 90 => requested_days,
        _ => 30,
    };
    let today = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        / 86_400;
    let start = day_number_to_date(today - (days as i64 - 1));
    let dates = (0..days)
        .map(|offset| add_days(&start, offset as i64))
        .collect::<Vec<_>>();
    let date_indexes = dates
        .iter()
        .enumerate()
        .map(|(index, date)| (date.clone(), index))
        .collect::<HashMap<_, _>>();
    let targets = scan_targets(app, profile_ids)?;
    let mut output = ScanOutput::default();
    let mut claude = HashMap::<(Option<String>, String), (String, ClaudeTokenUsage)>::new();
    let mut codex_response_ids = HashMap::<(Option<String>, String), bool>::new();
    let mut seen_records = 0usize;

    for target in targets {
        let profile_id = target.profile_id.clone();
        scan_tree(
            &target.home.join(".claude").join("projects"),
            |path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"),
            &mut output,
            |file, scan| {
                let skipped = parse_stream::<_, ClaudeRecord, _>(
                    file,
                    &mut seen_records,
                    |record, exceeded| {
                        if exceeded {
                            scan.records_skipped = true;
                            return;
                        }
                        let Some(message) = record.message else {
                            return;
                        };
                        if record.record_type.as_deref() != Some("assistant") {
                            return;
                        }
                        let Some(usage) = message.usage else { return };
                        let Some(date) = record.timestamp.as_ref().and_then(Timestamp::date) else {
                            return;
                        };
                        if !date_indexes.contains_key(&date) {
                            return;
                        }
                        if let Some(id) = message.id.filter(|id| !id.is_empty()) {
                            let entry = claude
                                .entry((profile_id.clone(), id))
                                .or_insert((date.clone(), usage));
                            if usage.total() >= entry.1.total() {
                                entry.0 = date;
                            }
                            entry.1 = entry.1.max_with(usage);
                        } else {
                            add_daily(scan, "Claude Code", profile_id.clone(), date, usage.total());
                        }
                    },
                );
                scan.records_skipped |= skipped;
            },
        );

        let codex_home = if profile_id.is_some() {
            target.home.join(".codex")
        } else {
            default_codex_home(&target.home)
        };
        scan_tree(
            &codex_home.join("sessions"),
            |path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            },
            &mut output,
            |file, scan| {
                let mut previous_cumulative = 0u64;
                let mut response_usage = Vec::<(String, u64)>::new();
                let mut cumulative_usage = Vec::<(String, u64)>::new();
                let skipped = parse_stream::<_, CodexRecord, _>(
                    file,
                    &mut seen_records,
                    |record, exceeded| {
                        if exceeded {
                            scan.records_skipped = true;
                            return;
                        }
                        let Some(payload) = record.payload else {
                            return;
                        };
                        let Some(date) = record.timestamp.as_ref().and_then(Timestamp::date) else {
                            return;
                        };
                        match record.record_type.as_deref() {
                            Some("token_usage_record") => {
                                if !date_indexes.contains_key(&date) {
                                    return;
                                }
                                let Some(usage) = payload.usage else { return };
                                if let Some(response_id) =
                                    payload.response_id.filter(|id| !id.is_empty())
                                {
                                    if codex_response_ids
                                        .insert((profile_id.clone(), response_id), true)
                                        .is_some()
                                    {
                                        return;
                                    }
                                }
                                response_usage.push((date, usage.total()));
                            }
                            Some("event_msg")
                                if payload.info.is_some()
                                    || payload.total_token_usage.is_some() =>
                            {
                                let cumulative = payload
                                    .total_token_usage
                                    .or_else(|| {
                                        payload.info.and_then(|info| info.total_token_usage)
                                    })
                                    .unwrap_or_default()
                                    .total();
                                let increment = if cumulative >= previous_cumulative {
                                    cumulative - previous_cumulative
                                } else {
                                    cumulative
                                };
                                previous_cumulative = cumulative;
                                if date_indexes.contains_key(&date) {
                                    cumulative_usage.push((date, increment));
                                }
                            }
                            _ => {}
                        }
                    },
                );
                scan.records_skipped |= skipped;
                let chosen = if response_usage.is_empty() {
                    cumulative_usage
                } else {
                    response_usage
                };
                for (date, tokens) in chosen {
                    add_daily(scan, "Codex", profile_id.clone(), date, tokens);
                }
            },
        );

        let gemini_home = if profile_id.is_some() {
            target.home.join(".gemini")
        } else {
            std::env::var_os("GEMINI_CLI_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| target.home.join(".gemini"))
        };
        scan_tree(
            &gemini_home.join("tmp"),
            |path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("session-")
                            && (name.ends_with(".json") || name.ends_with(".jsonl"))
                    })
            },
            &mut output,
            |file, scan| {
                let skipped = parse_stream::<_, GeminiRecord, _>(
                    file,
                    &mut seen_records,
                    |record, exceeded| {
                        if exceeded {
                            scan.records_skipped = true;
                            return;
                        }
                        if record.message_type.as_deref() == Some("gemini") {
                            if let (Some(timestamp), Some(tokens)) =
                                (record.timestamp.as_ref(), record.tokens)
                            {
                                if let Some(date) = timestamp.date() {
                                    if date_indexes.contains_key(&date) {
                                        add_daily(
                                            scan,
                                            "Gemini CLI",
                                            profile_id.clone(),
                                            date,
                                            tokens.total(),
                                        );
                                    }
                                }
                            }
                        }
                        let messages = record.messages.unwrap_or_default();
                        if messages.len() > MAX_LOG_RECORDS {
                            scan.records_skipped = true;
                        }
                        for message in messages.into_iter().take(MAX_LOG_RECORDS) {
                            if message.message_type.as_deref() != Some("gemini") {
                                continue;
                            }
                            if let (Some(timestamp), Some(tokens)) =
                                (message.timestamp.as_ref(), message.tokens)
                            {
                                if let Some(date) = timestamp.date() {
                                    if date_indexes.contains_key(&date) {
                                        add_daily(
                                            scan,
                                            "Gemini CLI",
                                            profile_id.clone(),
                                            date,
                                            tokens.total(),
                                        );
                                    }
                                }
                            }
                        }
                    },
                );
                scan.records_skipped |= skipped;
            },
        );
    }

    for ((profile_id, _id), (date, usage)) in claude {
        add_daily(&mut output, "Claude Code", profile_id, date, usage.total());
    }

    let mut series_values = BTreeMap::<SeriesKey, Vec<u64>>::new();
    for ((date, key), tokens) in output.daily {
        if let Some(index) = date_indexes.get(&date) {
            let daily = series_values
                .entry(key)
                .or_insert_with(|| vec![0; dates.len()]);
            daily[*index] = daily[*index].saturating_add(tokens);
        }
    }
    let series = series_values
        .into_iter()
        .map(|(key, daily)| UsageSeries {
            cli: key.cli.to_owned(),
            profile_id: key.profile_id,
            total: daily.iter().copied().fold(0u64, u64::saturating_add),
            daily,
        })
        .collect();

    Ok(UsageAnalytics {
        days,
        dates,
        series,
        files_scanned: output.files_scanned,
        files_skipped: output.files_skipped,
        records_skipped: output.records_skipped,
    })
}

fn scan_targets(app: &AppHandle, profile_ids: &[String]) -> Result<Vec<ScanTarget>, String> {
    let default_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "The default home folder is unavailable.".to_owned())?;
    let mut targets = vec![ScanTarget {
        profile_id: None,
        home: default_home,
    }];
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("profiles");
    for id in profile_ids.iter().take(MAX_PROFILE_IDS) {
        if !valid_profile_id(id) {
            continue;
        }
        let home = profile_root.join(id);
        let Ok(metadata) = fs::symlink_metadata(&home) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        targets.push(ScanTarget {
            profile_id: Some(id.clone()),
            home,
        });
    }
    Ok(targets)
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn default_codex_home(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

fn scan_tree<F, P>(root: &Path, accepts_file: P, output: &mut ScanOutput, mut parse: F)
where
    F: FnMut(File, &mut ScanOutput),
    P: Fn(&Path) -> bool,
{
    if !path_has_no_symlinks(root) {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    let mut directories = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = directories.pop() {
        if depth > 16 || output.files_scanned + output.files_skipped >= MAX_LOG_FILES {
            output.files_skipped += 1;
            break;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if depth < 16 {
                    directories.push((path, depth + 1));
                } else {
                    output.files_skipped += 1;
                }
                continue;
            }
            if !metadata.is_file() || !accepts_file(&path) {
                continue;
            }
            if output.files_scanned + output.files_skipped >= MAX_LOG_FILES
                || output.bytes_scanned.saturating_add(metadata.len()) > MAX_TOTAL_LOG_BYTES
            {
                output.files_skipped += 1;
                break;
            }
            if metadata.len() > MAX_LOG_FILE_BYTES {
                output.files_skipped += 1;
                continue;
            }
            match File::open(&path) {
                Ok(file) => {
                    output.files_scanned += 1;
                    output.bytes_scanned = output.bytes_scanned.saturating_add(metadata.len());
                    parse(file, output);
                }
                Err(_) => output.files_skipped += 1,
            }
        }
    }
}

fn parse_stream<R, T, F>(reader: R, seen_records: &mut usize, mut consume: F) -> bool
where
    R: Read,
    T: for<'de> Deserialize<'de>,
    F: FnMut(T, bool),
{
    let stream = serde_json::Deserializer::from_reader(reader).into_iter::<T>();
    let mut skipped = false;
    for record in stream {
        match record {
            Ok(record) => {
                *seen_records += 1;
                consume(record, *seen_records > MAX_LOG_RECORDS);
            }
            Err(_) => {
                skipped = true;
                break;
            }
        }
        if *seen_records > MAX_LOG_RECORDS {
            skipped = true;
            break;
        }
    }
    skipped
}

fn add_daily(
    output: &mut ScanOutput,
    cli: &'static str,
    profile_id: Option<String>,
    date: String,
    tokens: u64,
) {
    if tokens == 0 {
        return;
    }
    let key = SeriesKey { cli, profile_id };
    let value = output.daily.entry((date, key)).or_default();
    *value = value.saturating_add(tokens);
}

pub fn probe_cli(
    app: &AppHandle,
    cli: &str,
    profile_id: Option<&str>,
) -> Result<UsageProbe, String> {
    let fixed = match cli {
        "claude" => ("Claude Code", "/usage\r"),
        "codex" => ("Codex", "/status\r"),
        "gemini" => ("Gemini CLI", "/stats model\r"),
        _ => return Err("Usage probes support Claude Code, Codex, and Gemini CLI.".into()),
    };
    let mut command = CommandBuilder::new(cli);
    command.env_clear();
    for key in [
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GEMINI_CLI_HOME",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLUMNS", "100");
    command.env("LINES", "24");
    let home = if let Some(id) = profile_id {
        if !valid_profile_id(id) {
            return Err("Invalid CLI profile.".into());
        }
        let home = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("profiles")
            .join(id);
        let metadata =
            fs::symlink_metadata(&home).map_err(|_| "This CLI profile is unavailable.")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("This CLI profile is unavailable.".into());
        }
        command.env("HOME", &home);
        command.env("XDG_CONFIG_HOME", home.join(".config"));
        command.env("XDG_DATA_HOME", home.join(".local/share"));
        command.env("XDG_CACHE_HOME", home.join(".cache"));
        command.env("CLAUDE_CONFIG_DIR", home.join(".claude"));
        command.env("CODEX_HOME", home.join(".codex"));
        command.env("GEMINI_CLI_HOME", &home);
        home
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "The default home folder is unavailable.".to_owned())?
    };
    command.env("HOME", &home);
    command.cwd(&home);

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open a usage probe terminal: {error}"))?;
    let mut child = pair.slave.spawn_command(command).map_err(|_| {
        format!(
            "Could not start {}. Check that it is installed and on PATH.",
            fixed.0
        )
    })?;
    drop(pair.slave);
    let mut writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(16);
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let started = SystemTime::now();
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    let send_at = std::time::Instant::now() + Duration::from_millis(850);
    let mut sent = false;
    let mut write_failed = false;
    let mut captured = Vec::with_capacity(MAX_PROBE_OUTPUT);
    while std::time::Instant::now() < deadline && captured.len() < MAX_PROBE_OUTPUT {
        if !sent && std::time::Instant::now() >= send_at {
            if writer.write_all(fixed.1.as_bytes()).is_err() {
                write_failed = true;
                break;
            }
            writer.flush().ok();
            sent = true;
        }
        match receiver.recv_timeout(Duration::from_millis(150)) {
            Ok(bytes) => {
                let remaining = MAX_PROBE_OUTPUT - captured.len();
                captured.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    if write_failed {
        return Err("The CLI closed before it accepted the usage command.".into());
    }
    let periods = parse_probe_periods(&String::from_utf8_lossy(&captured));
    let message = if periods.is_empty() {
        "No usage percentages were recognized. The CLI may need sign-in, a different version, or may not expose this status.".to_owned()
    } else {
        "Read from the CLI’s local status screen.".to_owned()
    };
    let checked_at = started
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(UsageProbe {
        cli: fixed.0.to_owned(),
        checked_at,
        periods,
        message,
    })
}

fn parse_probe_periods(output: &str) -> Vec<UsagePeriod> {
    let mut periods = BTreeMap::<String, u8>::new();
    let clean = strip_terminal_controls(output);
    let lines = clean.lines().collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        let context = lines[index.saturating_sub(2)..=index]
            .join(" ")
            .to_ascii_lowercase();
        for (mark_index, _) in line.match_indices('%') {
            if ![
                "usage", "limit", "session", "weekly", "week", "5h", "5-hour", "rate",
            ]
            .iter()
            .any(|word| context.contains(word))
            {
                continue;
            }
            let Some(percent) = percentage_before_mark(line, mark_index) else {
                continue;
            };
            let label = if context.contains("week") {
                "Weekly"
            } else if context.contains("5-hour")
                || context.contains("5h")
                || context.contains("rate")
            {
                "Rate limit"
            } else {
                "Session"
            };
            let used = if context.contains("remaining") {
                100u8.saturating_sub(percent)
            } else {
                percent
            };
            periods
                .entry(label.to_owned())
                .and_modify(|value| *value = (*value).max(used))
                .or_insert(used);
        }
    }
    periods
        .into_iter()
        .map(|(label, used_percent)| UsagePeriod {
            label,
            used_percent,
        })
        .collect()
}

fn percentage_before_mark(line: &str, marker: usize) -> Option<u8> {
    let prefix = &line[..marker];
    let mut digits = String::new();
    for character in prefix.chars().rev() {
        if character.is_ascii_digit() || character == '.' {
            digits.push(character);
        } else if !digits.is_empty() {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    let value = digits
        .chars()
        .rev()
        .collect::<String>()
        .parse::<f32>()
        .ok()?;
    Some(value.round().clamp(0.0, 100.0) as u8)
}

fn strip_terminal_controls(output: &str) -> String {
    let bytes = output.as_bytes();
    let mut clean = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && index + 1 < bytes.len() {
            index += 1;
            match bytes[index] {
                b'[' => {
                    index += 1;
                    while index < bytes.len() {
                        let byte = bytes[index];
                        index += 1;
                        if (0x40..=0x7e).contains(&byte) {
                            break;
                        }
                    }
                }
                b']' => {
                    index += 1;
                    while index < bytes.len() {
                        if bytes[index] == 0x07 {
                            index += 1;
                            break;
                        }
                        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                            index += 2;
                            break;
                        }
                        index += 1;
                    }
                }
                _ => index += 1,
            }
            continue;
        }
        if bytes[index] == b'\r' {
            clean.push(b'\n');
        } else if bytes[index] == b'\n' || bytes[index] >= b' ' || bytes[index] == b'\t' {
            clean.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&clean).into_owned()
}

fn path_has_no_symlinks(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if current.as_os_str().is_empty() {
            continue;
        }
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return false;
            }
        }
    }
    true
}

fn iso_date_utc(value: &str) -> Option<String> {
    let date = value.get(..10)?;
    if !is_date(date) {
        return None;
    }
    let day = date_to_day_number(date)?;
    let rest = value.get(10..)?;
    let time = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '));
    let Some(time) = time else {
        return Some(date.to_owned());
    };
    let hour = time.get(0..2)?.parse::<i64>().ok()?;
    let minute = time.get(3..5)?.parse::<i64>().ok()?;
    let second_text = time.get(6..8)?;
    let second = second_text.parse::<i64>().ok()?;
    let tail = time.get(8..).unwrap_or("");
    let offset_start = tail.find(['+', '-']);
    let offset = if let Some(start) = offset_start {
        let sign = if tail.as_bytes()[start] == b'+' {
            1
        } else {
            -1
        };
        let parts = tail[start + 1..].split(':').collect::<Vec<_>>();
        if parts.len() < 2 {
            0
        } else {
            sign * (parts[0].parse::<i64>().ok()? * 3600
                + parts[1].get(..2)?.parse::<i64>().ok()? * 60)
        }
    } else {
        0
    };
    let local_seconds = hour * 3600 + minute * 60 + second;
    let utc_day = (day * 86_400 + local_seconds - offset).div_euclid(86_400);
    Some(day_number_to_date(utc_day))
}

fn date_to_day_number(date: &str) -> Option<i64> {
    let year = date.get(..4)?.parse::<i64>().ok()?;
    let month = date.get(5..7)?.parse::<i64>().ok()?;
    let day = date.get(8..10)?.parse::<i64>().ok()?;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * adjusted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn day_number_to_date(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn add_days(date: &str, days: i64) -> String {
    let year = date[..4].parse::<i64>().unwrap_or(1970);
    let month = date[5..7].parse::<i64>().unwrap_or(1);
    let day = date[8..10].parse::<i64>().unwrap_or(1);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * adjusted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    day_number_to_date(era * 146_097 + doe - 719_468 + days)
}
