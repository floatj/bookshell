use crate::general::load_general;
use crate::logger;
use crate::output_pipe;
use crate::ssh::{Cmd, SessionHandle};
use crate::AppState;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

#[cfg(target_os = "windows")]
fn platform_default_shell() -> String {
    "powershell.exe".to_string()
}
#[cfg(not(target_os = "windows"))]
fn platform_default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Resolve the shell field: explicit per-connection > user-configured default
/// in general.toml > platform default.
fn resolve_shell(shell: Option<&str>) -> String {
    if let Some(s) = shell.map(str::trim).filter(|s| !s.is_empty()) {
        return s.to_string();
    }
    if let Some(s) = load_general()
        .default_shell
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return s.to_string();
    }
    platform_default_shell()
}

fn expand_tilde<S: AsRef<str>>(s: S) -> String {
    let s = s.as_ref();
    if s == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return home;
        }
    } else if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{}/{}", home.trim_end_matches('/'), rest);
        }
    }
    s.to_string()
}

/// Split a shell command string into program + args while respecting
/// double-quoted segments, so paths containing spaces work:
///   `"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo`
/// yields `["C:\Program Files\PowerShell\7\pwsh.exe", "-NoLogo"]`.
/// Unquoted whitespace separates tokens; backslash is treated literally
/// (Windows path separator), so no escape handling is needed.
fn split_shell_command(input: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut has_token = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                in_quote = !in_quote;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quote => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(cur);
    }
    out
}

/// Spawn a local interactive shell on a fresh PTY. The session shows up in
/// the same `state.sessions` map as SSH PTYs and is driven by ssh_write /
/// ssh_resize / ssh_disconnect, so the frontend treats it identically.
#[tauri::command]
pub async fn local_open_pty(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {}", e))?;

    let shell_field = resolve_shell(shell.as_deref());

    // Tokenize the shell field into program + args, honoring double quotes
    // so paths like `"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo` work.
    // Tilde is expanded against $HOME — portable_pty hands the path straight
    // to the OS exec, which doesn't do any shell expansion.
    let mut parts = split_shell_command(&shell_field).into_iter();
    let program_raw = parts.next().unwrap_or_default();
    let program = expand_tilde(program_raw);
    let args: Vec<String> = parts.map(expand_tilde).collect();

    let mut builder = CommandBuilder::new(&program);
    for arg in &args {
        builder.arg(arg);
    }
    if let Some(d) = cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        builder.cwd(expand_tilde(d));
    }
    // Forward TERM so colors etc. work like a normal terminal.
    builder.env("TERM", "xterm-256color");

    // GUI-launched apps inherit a stripped-down PATH that doesn't include
    // user bin dirs, so `screen.sh` style entries can't be resolved. Prepend
    // ~/.local/bin and ~/bin if they aren't already in PATH.
    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        let current = std::env::var("PATH").unwrap_or_default();
        let extras = [format!("{}/.local/bin", home), format!("{}/bin", home)];
        let missing: Vec<&str> = extras
            .iter()
            .map(String::as_str)
            .filter(|e| !current.split(':').any(|p| p == *e))
            .collect();
        if !missing.is_empty() {
            let mut new_path = missing.join(":");
            if !current.is_empty() {
                new_path.push(':');
                new_path.push_str(&current);
            }
            builder.env("PATH", new_path);
        }
    }

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn {}: {}", program, e))?;
    drop(pair.slave);

    let master = Arc::new(StdMutex::new(pair.master));
    let reader = master
        .lock()
        .unwrap()
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {}", e))?;
    let writer = master
        .lock()
        .unwrap()
        .take_writer()
        .map_err(|e| format!("take writer: {}", e))?;

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<Cmd>(64);
    let close_event = format!("ssh://close/{}", session_id);

    // Per-session logger — same scheme as SSH sessions, label is the shell's
    // basename so files like `20260501_..._powershell.exe.log` show up in
    // ~/Documents/BOOKSHELL/logs.
    let log_label = std::path::Path::new(&program)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "local".to_string());
    let log_handle = if load_general().session_logging_enabled {
        logger::start_logger(&log_label).await.ok()
    } else {
        None
    };
    let log_path = log_handle
        .as_ref()
        .map(|h| h.path.clone())
        .unwrap_or_default();
    let log_tx = log_handle.map(|h| h.tx);
    let (output_tx, output_task) =
        output_pipe::spawn_output_pipe(log_label.clone(), on_data, log_tx);

    // Reader: blocking read in a dedicated OS thread, pushing bytes into the
    // bounded output pump. If the UI cannot keep up, this blocks and lets the
    // OS PTY backpressure the child process.
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = buf[..n].to_vec();
                    if output_tx.blocking_send(bytes).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Writer + cmd handler. Writer is sync; PTY writes are tiny so we don't
    // bother spawn_blocking each one.
    let writer = Arc::new(StdMutex::new(writer));
    let writer_for_task = writer.clone();
    let master_for_task = master.clone();

    let app_for_close = app.clone();
    let session_id_clone = session_id.clone();
    let sessions_clone = state.sessions.clone();

    // We need `child` to be Send. portable-pty's Box<dyn Child + Send + Sync> is.
    let child_arc: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>> =
        Arc::new(Mutex::new(child as _));
    let child_for_task = child_arc.clone();

    tokio::spawn(async move {
        let close_reason = run_local(
            &mut cmd_rx,
            writer_for_task,
            master_for_task,
            child_for_task,
        )
        .await;
        let _ = output_task.await;
        sessions_clone.remove(&session_id_clone);
        let _ = app_for_close.emit(&close_event, close_reason);
    });

    // Watcher: when the child exits on its own (user typed `exit`, etc.),
    // tear the session down so the frontend learns about it.
    let cmd_tx_for_watcher = cmd_tx.clone();
    let child_for_watcher = child_arc.clone();
    std::thread::spawn(move || {
        // Acquiring the std::sync lock would be racy with the async task; use
        // a small poll loop on try_wait via tokio handle.
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            // Use try_lock; if busy, retry.
            if let Ok(mut g) = child_for_watcher.try_lock() {
                match g.try_wait() {
                    Ok(Some(_status)) => {
                        let _ = cmd_tx_for_watcher.try_send(Cmd::Close);
                        break;
                    }
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        }
    });
    // The watcher thread captures `child_arc.clone()`; drop our local
    // reference here so only the runtime tasks keep it alive.
    drop(child_arc);

    let handle = SessionHandle {
        tx: cmd_tx,
        log_path,
        session: None,
        is_primary: true,
    };
    state.sessions.insert(session_id.clone(), handle);

    // Master and writer kept alive via Arc captures inside tasks.
    let _ = master;
    let _ = writer;

    Ok(session_id)
}

async fn run_local(
    cmd_rx: &mut mpsc::Receiver<Cmd>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    master: Arc<StdMutex<Box<dyn portable_pty::MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> String {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            Cmd::Write(bytes) => {
                if let Ok(mut w) = writer.lock() {
                    if w.write_all(&bytes).is_err() {
                        return "write error".into();
                    }
                    let _ = w.flush();
                }
            }
            Cmd::Resize(cols, rows) => {
                if let Ok(m) = master.lock() {
                    let _ = m.resize(PtySize {
                        rows: rows as u16,
                        cols: cols as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
            Cmd::Close => {
                let mut g = child.lock().await;
                let _ = g.kill();
                return "closed by client".into();
            }
        }
    }
    "channel ended".into()
}
