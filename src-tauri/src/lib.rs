use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashMap,
    fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
#[cfg(target_os = "linux")]
use std::{ffi::CString, os::unix::ffi::OsStrExt};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, ipc::Channel};

const MAX_STATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_VAULT_FILE_BYTES: usize = 1024 * 1024;
const MAX_VAULT_FILES: usize = 1000;
const MAX_VAULT_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_VAULT_DEPTH: usize = 16;

mod usage;
mod voice;

#[derive(Default)]
struct PtyState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

struct PtySession {
    run_token: u64,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl Drop for PtyState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    kind: &'static str,
    data: String,
    run_token: u64,
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(directory.join("workspace.json"))
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    let path = state_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_STATE_BYTES as u64 {
        return Err("Saved workspace data is larger than the 32 MB local limit.".into());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("Saved workspace data is invalid: {error}"))
}

#[tauri::command]
fn save_state(app: AppHandle, state: Value) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    if contents.len() > MAX_STATE_BYTES {
        return Err("Workspace data is larger than the 32 MB local limit.".into());
    }
    let path = state_file(&app)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn choose_project_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a project folder")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_cli_profile(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(
            "Profile id must contain only letters, numbers, hyphens, or underscores.".into(),
        );
    }
    let mut root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    root.push("profiles");
    root.push(id);
    for directory in [
        root.clone(),
        root.join(".config"),
        root.join(".local/share"),
        root.join(".cache"),
        root.join(".claude"),
        root.join(".codex"),
    ] {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn git_status(path: String) -> Result<String, String> {
    let project = PathBuf::from(&path);
    if !project.is_dir() {
        return Err("Choose an existing project folder first.".into());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&project)
        .args(["status", "--short", "--branch"])
        .output()
        .map_err(|error| format!("Could not start git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
fn git_action(path: String, action: String, message: Option<String>) -> Result<String, String> {
    let project = PathBuf::from(&path);
    if !project.is_dir() {
        return Err("Choose an existing project folder first.".into());
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&project)
        .env("GIT_TERMINAL_PROMPT", "0");
    match action.as_str() {
        "commit" => {
            let message = message.unwrap_or_default();
            if message.trim().is_empty() || message.len() > 500 {
                return Err("Enter a commit message between 1 and 500 characters.".into());
            }
            command.args(["commit", "-m", &message]);
        }
        "push" => {
            command.arg("push");
        }
        "pull" => {
            command.arg("pull");
        }
        _ => return Err("Unsupported Git action.".into()),
    }
    let output = command
        .output()
        .map_err(|error| format!("Could not start git: {error}"))?;
    let result = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.status.success() {
        Ok(if result.is_empty() { error } else { result })
    } else {
        Err(if error.is_empty() { result } else { error })
    }
}

fn run_gh_json(project: &PathBuf, args: &[String]) -> Result<Value, String> {
    let output = Command::new("gh")
        .args(args)
        .current_dir(project)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Could not start GitHub CLI: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if message.is_empty() {
            "GitHub CLI request failed.".into()
        } else {
            message
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GitHub CLI returned invalid JSON: {error}"))
}

#[tauri::command]
fn github_summary(path: String) -> Result<Value, String> {
    let project = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !project.is_dir() {
        return Err("Choose an existing project folder first.".into());
    }
    let repository_info = run_gh_json(
        &project,
        &[
            "repo".into(),
            "view".into(),
            "--json".into(),
            "nameWithOwner".into(),
        ],
    )?;
    let repository = repository_info
        .get("nameWithOwner")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && name.len() <= 255)
        .ok_or("GitHub CLI did not identify a repository for this project.")?
        .to_owned();
    let pull_requests = run_gh_json(
        &project,
        &[
            "pr".into(),
            "list".into(),
            "--repo".into(),
            repository.clone(),
            "--limit".into(),
            "10".into(),
            "--json".into(),
            "number,title,state,url,author".into(),
        ],
    )?;
    let issues = run_gh_json(
        &project,
        &[
            "issue".into(),
            "list".into(),
            "--repo".into(),
            repository.clone(),
            "--limit".into(),
            "10".into(),
            "--json".into(),
            "number,title,state,url,author".into(),
        ],
    )?;
    Ok(json!({ "repository": repository, "pullRequests": pull_requests, "issues": issues }))
}

fn project_root(path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Choose an existing project folder first.".into());
    }
    Ok(root)
}

#[derive(Serialize)]
struct ProjectFileEntry {
    path: String,
    directory: bool,
}

fn is_sensitive_project_file(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name.as_str(),
            ".npmrc" | ".pypirc" | ".netrc" | ".git-credentials" | "credentials" | "secrets"
        )
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".secret"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn visit_project(
    root: &PathBuf,
    current: &PathBuf,
    depth: usize,
    entries: &mut Vec<ProjectFileEntry>,
) -> Result<(), String> {
    if depth > 5 || entries.len() >= 1000 {
        return Ok(());
    }
    let ignored = [
        ".git",
        "node_modules",
        "target",
        "dist",
        ".venv",
        "vendor",
        "build",
    ];
    for entry in fs::read_dir(current)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
    {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_file() && !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignored.contains(&name.as_str()) {
            continue;
        }
        if file_type.is_file() && is_sensitive_project_file(&name) {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        let directory = file_type.is_dir();
        entries.push(ProjectFileEntry {
            path: relative.to_string_lossy().into_owned(),
            directory,
        });
        if directory {
            visit_project(root, &path, depth + 1, entries)?;
        }
        if entries.len() >= 1000 {
            break;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_project_files(path: String) -> Result<Vec<ProjectFileEntry>, String> {
    let root = project_root(&path)?;
    let mut entries = Vec::new();
    visit_project(&root, &root, 0, &mut entries)?;
    Ok(entries)
}

#[tauri::command]
fn read_project_file(path: String, relative_path: String) -> Result<String, String> {
    let root = project_root(&path)?;
    let file = fs::canonicalize(root.join(relative_path)).map_err(|error| error.to_string())?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("Select a file inside the active project.".into());
    }
    if file
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_sensitive_project_file)
    {
        return Err("Sensitive files are not available in the code preview.".into());
    }
    let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;
    if metadata.len() > 1024 * 1024 {
        return Err("Files larger than 1 MB are not shown in the code preview.".into());
    }
    fs::read_to_string(file)
        .map_err(|error| format!("This file is not readable as UTF-8 text: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    relative_path: String,
    title: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultListing {
    files: Vec<VaultFile>,
    truncated: bool,
}

fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn vault_root(
    app: &AppHandle,
    workspace_id: &str,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    if !valid_workspace_id(workspace_id) {
        return Err("Invalid workspace id for Markdown vault.".into());
    }
    let personal_base = if project_path.filter(|path| !path.is_empty()).is_none() {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
        let canonical_app_data = fs::canonicalize(&app_data).map_err(|error| error.to_string())?;
        let personal_base = app_data.join("vault");
        fs::create_dir_all(&personal_base).map_err(|error| error.to_string())?;
        let canonical_base = fs::canonicalize(personal_base).map_err(|error| error.to_string())?;
        if !canonical_base.starts_with(&canonical_app_data) {
            return Err("The personal Markdown vault must stay inside Megavibe data.".into());
        }
        Some(canonical_base)
    } else {
        None
    };
    let root = if let Some(project_path) = project_path.filter(|path| !path.is_empty()) {
        project_root(project_path)?.join(".hypervibe").join("vault")
    } else {
        personal_base
            .as_ref()
            .ok_or("Personal vault is unavailable")?
            .join(workspace_id)
    };
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let canonical = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    if let Some(project_path) = project_path.filter(|path| !path.is_empty()) {
        let project = project_root(project_path)?;
        if !canonical.starts_with(&project) {
            return Err("The Markdown vault folder must stay inside the project.".into());
        }
    } else {
        let allowed = personal_base
            .as_ref()
            .ok_or("Personal vault is unavailable")?;
        if canonical != allowed.join(workspace_id) {
            return Err("The Markdown vault folder must stay inside Megavibe data.".into());
        }
    }
    Ok(canonical)
}

fn safe_vault_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 240
        || value.contains('\\')
        || value.contains('\0')
        || !value.ends_with(".md")
    {
        return Err("Markdown vault paths must be short .md filenames.".into());
    }
    let relative = PathBuf::from(value);
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Markdown vault paths cannot leave the vault folder.".into());
    }
    Ok(relative)
}

fn rename_without_replacement(source: &PathBuf, destination: &PathBuf) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let source_c = CString::new(source.as_os_str().as_bytes()).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid source path")
        })?;
        let destination_c = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid destination path")
        })?;
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2 as libc::c_long,
                libc::AT_FDCWD,
                source_c.as_ptr(),
                libc::AT_FDCWD,
                destination_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::ENOSYS) | Some(libc::EINVAL)
        ) {
            return Err(error);
        }
    }

    fs::hard_link(source, destination)?;
    if let Err(error) = fs::remove_file(source) {
        return match fs::remove_file(destination) {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!(
                    "Could not remove the original file ({error}); a second link remains at the new path ({rollback_error})."
                ),
            )),
        };
    }
    Ok(())
}

fn collect_vault_files(
    root: &PathBuf,
    folder: &PathBuf,
    depth: usize,
    files: &mut Vec<VaultFile>,
    total_bytes: &mut usize,
    truncated: &mut bool,
) -> Result<(), String> {
    if depth > MAX_VAULT_DEPTH {
        *truncated = true;
        return Ok(());
    }
    if files.len() >= MAX_VAULT_FILES || *total_bytes >= MAX_VAULT_TOTAL_BYTES {
        *truncated = true;
        return Ok(());
    }
    for entry in fs::read_dir(folder)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
    {
        if files.len() >= MAX_VAULT_FILES || *total_bytes >= MAX_VAULT_TOTAL_BYTES {
            *truncated = true;
            break;
        }
        let entry_type = entry.file_type().map_err(|error| error.to_string())?;
        if entry_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if entry_type.is_dir() {
            collect_vault_files(root, &path, depth + 1, files, total_bytes, truncated)?;
            if files.len() >= MAX_VAULT_FILES || *total_bytes >= MAX_VAULT_TOTAL_BYTES {
                *truncated = true;
                break;
            }
            continue;
        }
        if !entry_type.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("md")
        {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_VAULT_FILE_BYTES as u64 {
            *truncated = true;
            continue;
        }
        let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !canonical.starts_with(root) {
            continue;
        }
        let mut content = String::new();
        fs::File::open(&canonical)
            .map_err(|error| error.to_string())?
            .take((MAX_VAULT_FILE_BYTES + 1) as u64)
            .read_to_string(&mut content)
            .map_err(|error| format!("This Markdown file is not readable as UTF-8: {error}"))?;
        if content.len() > MAX_VAULT_FILE_BYTES
            || total_bytes.saturating_add(content.len()) > MAX_VAULT_TOTAL_BYTES
        {
            *truncated = true;
            continue;
        }
        *total_bytes += content.len();
        let relative_path = canonical
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let title = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned();
        files.push(VaultFile {
            relative_path,
            title,
            content,
        });
    }
    Ok(())
}

fn scan_vault_usage(
    folder: &PathBuf,
    depth: usize,
    file_count: &mut usize,
    total_bytes: &mut u64,
    truncated: &mut bool,
) -> Result<(), String> {
    if depth > MAX_VAULT_DEPTH {
        *truncated = true;
        return Ok(());
    }
    for entry in fs::read_dir(folder).map_err(|error| error.to_string())? {
        if *file_count >= MAX_VAULT_FILES || *total_bytes >= MAX_VAULT_TOTAL_BYTES as u64 {
            *truncated = true;
            return Ok(());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_type = entry.file_type().map_err(|error| error.to_string())?;
        if entry_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if entry_type.is_dir() {
            scan_vault_usage(&path, depth + 1, file_count, total_bytes, truncated)?;
            if *truncated {
                return Ok(());
            }
            continue;
        }
        if !entry_type.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("md")
        {
            continue;
        }
        let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
        *file_count += 1;
        *total_bytes = total_bytes.saturating_add(size);
        if size > MAX_VAULT_FILE_BYTES as u64
            || *file_count > MAX_VAULT_FILES
            || *total_bytes > MAX_VAULT_TOTAL_BYTES as u64
        {
            *truncated = true;
            return Ok(());
        }
    }
    Ok(())
}

#[tauri::command]
fn list_vault_files(
    app: AppHandle,
    workspace_id: String,
    project_path: Option<String>,
) -> Result<VaultListing, String> {
    let root = vault_root(&app, &workspace_id, project_path.as_deref())?;
    let mut files = Vec::new();
    let mut total_bytes = 0;
    let mut truncated = false;
    collect_vault_files(
        &root,
        &root,
        0,
        &mut files,
        &mut total_bytes,
        &mut truncated,
    )?;
    files.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    Ok(VaultListing { files, truncated })
}

#[tauri::command]
fn write_vault_file(
    app: AppHandle,
    workspace_id: String,
    project_path: Option<String>,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > MAX_VAULT_FILE_BYTES {
        return Err("Markdown vault files are limited to 1 MB.".into());
    }
    let relative = safe_vault_relative_path(&relative_path)?;
    let root = vault_root(&app, &workspace_id, project_path.as_deref())?;
    let file = root.join(relative);
    let parent = file.parent().ok_or("Invalid Markdown vault path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err("The Markdown vault folder must stay inside the vault.".into());
    }
    let is_new = match fs::symlink_metadata(&file) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Markdown vault entries must be regular files.".into());
            }
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.to_string()),
    };
    let previous_size = if is_new {
        0
    } else {
        fs::metadata(&file)
            .map_err(|error| error.to_string())?
            .len()
    };
    let mut file_count = 0;
    let mut total_bytes = 0;
    let mut truncated = false;
    scan_vault_usage(&root, 0, &mut file_count, &mut total_bytes, &mut truncated)?;
    if is_new {
        if file_count >= MAX_VAULT_FILES
            || truncated
            || total_bytes.saturating_add(content.len() as u64) > MAX_VAULT_TOTAL_BYTES as u64
        {
            return Err("This Markdown vault is at a listing limit. Remove or move some files before adding a note.".into());
        }
    } else if truncated {
        if content.len() as u64 > previous_size {
            return Err("This Markdown vault is at a listing limit. An existing note can only be saved at its current size or smaller until space is available.".into());
        }
    } else if total_bytes
        .saturating_sub(previous_size)
        .saturating_add(content.len() as u64)
        > MAX_VAULT_TOTAL_BYTES as u64
    {
        return Err("Markdown vault files are limited to 16 MB combined. Reduce or remove files before expanding this note.".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(".megavibe-{nonce}.tmp"));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    output
        .write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    drop(output);
    fs::rename(&temporary, &file).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_vault_file(
    app: AppHandle,
    workspace_id: String,
    project_path: Option<String>,
    relative_path: String,
) -> Result<(), String> {
    let relative = safe_vault_relative_path(&relative_path)?;
    let root = vault_root(&app, &workspace_id, project_path.as_deref())?;
    let file = root.join(relative);
    let metadata = fs::symlink_metadata(&file).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Markdown vault entries must be regular files.".into());
    }
    let canonical = fs::canonicalize(&file).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("The Markdown vault folder must stay inside the vault.".into());
    }
    fs::remove_file(canonical).map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_vault_file(
    app: AppHandle,
    workspace_id: String,
    project_path: Option<String>,
    old_relative_path: String,
    new_relative_path: String,
) -> Result<(), String> {
    let old_relative = safe_vault_relative_path(&old_relative_path)?;
    let new_relative = safe_vault_relative_path(&new_relative_path)?;
    if old_relative == new_relative {
        return Ok(());
    }
    let root = vault_root(&app, &workspace_id, project_path.as_deref())?;
    let source = root.join(old_relative);
    let source_metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("Markdown vault entries must be regular files.".into());
    }
    let source = fs::canonicalize(source).map_err(|error| error.to_string())?;
    if !source.starts_with(&root) {
        return Err("The Markdown vault folder must stay inside the vault.".into());
    }
    let destination = root.join(new_relative);
    let parent = destination.parent().ok_or("Invalid Markdown vault path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err("The Markdown vault folder must stay inside the vault.".into());
    }
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err("A file already exists at that Markdown vault path.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    rename_without_replacement(&source, &destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "A file already exists at that Markdown vault path.".to_owned()
        } else {
            format!("Could not safely move this Markdown file: {error}")
        }
    })?;
    Ok(())
}

#[tauri::command]
fn spawn_terminal(
    state: State<'_, PtyState>,
    app: AppHandle,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    profile_id: Option<String>,
    run_token: u64,
    cols: u16,
    rows: u16,
    on_output: Channel<OutputEvent>,
) -> Result<(), String> {
    if program.trim().is_empty() || program.contains('\0') {
        return Err("Enter a valid command.".into());
    }
    if args.len() > 128 || args.iter().any(|arg| arg.contains('\0')) {
        return Err("The command has too many or invalid arguments.".into());
    }
    if let Some(directory) = &cwd {
        if !PathBuf::from(directory).is_dir() {
            return Err("The working folder does not exist.".into());
        }
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable")?;
    if sessions.contains_key(&id) {
        return Err("This terminal is already running.".into());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.clamp(4, 200),
            cols: cols.clamp(20, 400),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open terminal: {error}"))?;

    let mut command = CommandBuilder::new(&program);
    command.args(&args);
    if let Some(profile_id) = profile_id.as_ref() {
        if profile_id.is_empty()
            || profile_id.len() > 64
            || !profile_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '_'
            })
        {
            return Err("Invalid CLI profile.".into());
        }
        let mut home = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        home.push("profiles");
        home.push(profile_id);
        for directory in [
            home.clone(),
            home.join(".config"),
            home.join(".local/share"),
            home.join(".cache"),
            home.join(".claude"),
            home.join(".codex"),
        ] {
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        command.env("HOME", &home);
        command.env("XDG_CONFIG_HOME", home.join(".config"));
        command.env("XDG_DATA_HOME", home.join(".local/share"));
        command.env("XDG_CACHE_HOME", home.join(".cache"));
        command.env("CLAUDE_CONFIG_DIR", home.join(".claude"));
        command.env("CODEX_HOME", home.join(".codex"));
        command.env("GEMINI_CLI_HOME", &home);
    }
    if let Some(directory) = cwd.as_ref() {
        command.cwd(directory);
    } else if let Some(home) = std::env::var_os("HOME") {
        command.cwd(home);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start {program}: {error}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not open terminal input: {error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not open terminal output: {error}"))?;
    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(writer));
    let child: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));

    let session_id = id.clone();
    sessions.insert(
        id,
        PtySession {
            run_token,
            writer,
            master: Arc::clone(&master),
            child: Arc::clone(&child),
        },
    );
    drop(sessions);

    let output_channel = on_output.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let event = OutputEvent {
                        kind: "output",
                        data: String::from_utf8_lossy(&buffer[..length]).into_owned(),
                        run_token,
                    };
                    if output_channel.send(event).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let registry = Arc::clone(&state.sessions);
    thread::spawn(move || {
        let exit = loop {
            let result = child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten());
            if let Some(status) = result {
                break status.to_string();
            }
            thread::sleep(Duration::from_millis(250));
        };
        if let Ok(mut sessions) = registry.lock() {
            if sessions
                .get(&session_id)
                .is_some_and(|session| session.run_token == run_token)
            {
                sessions.remove(&session_id);
            }
        }
        let _ = on_output.send(OutputEvent {
            kind: "exit",
            data: exit,
            run_token,
        });
    });

    Ok(())
}

#[tauri::command]
fn write_terminal(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    if data.len() > 16 * 1024 {
        return Err("Terminal input is too large.".into());
    }
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable")?;
    let session = sessions.get(&id).ok_or("Terminal is not running")?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Terminal input is unavailable")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn paste_terminal(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("Prepared terminal text is too large.".into());
    }
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable")?;
    let session = sessions.get(&id).ok_or("Terminal is not running")?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Terminal input is unavailable")?;
    let safe_text: String = data
        .chars()
        .map(|character| {
            if character == '\u{1b}' {
                "^[".to_owned()
            } else if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                " ".to_owned()
            } else {
                character.to_string()
            }
        })
        .collect();
    writer
        .write_all(b"\x1b[200~")
        .and_then(|_| writer.write_all(safe_text.as_bytes()))
        .and_then(|_| writer.write_all(b"\x1b[201~"))
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable")?;
    let session = sessions.get(&id).ok_or("Terminal is not running")?;
    let master = session
        .master
        .lock()
        .map_err(|_| "Terminal is unavailable")?;
    master
        .resize(PtySize {
            rows: rows.clamp(4, 200),
            cols: cols.clamp(20, 400),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_terminal(state: State<'_, PtyState>, id: String, run_token: u64) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable")?;
    {
        let Some(session) = sessions.get(&id) else {
            return Ok(());
        };
        if session.run_token != run_token {
            return Err("Terminal run changed; no process was stopped.".into());
        }
        let mut child = session
            .child
            .lock()
            .map_err(|_| "Terminal process is unavailable")?;
        child
            .kill()
            .map_err(|error| format!("Could not stop terminal: {error}"))?;
    }
    sessions.remove(&id);
    Ok(())
}

#[tauri::command]
fn close_application(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn load_usage_analytics(
    app: AppHandle,
    days: u32,
    profile_ids: Vec<String>,
) -> Result<usage::UsageAnalytics, String> {
    usage::load_analytics(&app, days, &profile_ids)
}

#[tauri::command]
fn probe_cli_usage(
    app: AppHandle,
    cli: String,
    profile_id: Option<String>,
) -> Result<usage::UsageProbe, String> {
    usage::probe_cli(&app, &cli, profile_id.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(voice::VoiceState::default())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            choose_project_folder,
            git_status,
            git_action,
            github_summary,
            create_cli_profile,
            list_project_files,
            read_project_file,
            list_vault_files,
            write_vault_file,
            delete_vault_file,
            rename_vault_file,
            spawn_terminal,
            write_terminal,
            paste_terminal,
            resize_terminal,
            stop_terminal,
            load_usage_analytics,
            probe_cli_usage,
            voice::voice_status,
            voice::voice_download_models,
            voice::voice_cancel_download,
            voice::voice_start_recording,
            voice::voice_cancel_recording,
            voice::voice_stop_recording_and_plan,
            voice::voice_plan_text,
            voice::voice_synthesize,
            close_application
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("megavibe-close-request", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Megavibe");
}
