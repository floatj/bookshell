use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant};

const QUEUE_CHUNKS: usize = 256;
const FLUSH_BYTES: usize = 32 * 1024;
const FLUSH_AFTER: Duration = Duration::from_millis(2);

pub type OutputSender = mpsc::Sender<Vec<u8>>;

pub fn spawn_output_pipe(
    on_data: Channel<InvokeResponseBody>,
    log_tx: Option<mpsc::Sender<Vec<u8>>>,
) -> (OutputSender, JoinHandle<()>) {
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(QUEUE_CHUNKS);
    let handle = tokio::spawn(async move {
        let mut pending = Vec::with_capacity(FLUSH_BYTES);
        let mut deadline: Option<Instant> = None;

        loop {
            if pending.is_empty() {
                match rx.recv().await {
                    Some(bytes) => {
                        pending.extend_from_slice(&bytes);
                        deadline = Some(Instant::now() + FLUSH_AFTER);
                        if pending.len() >= FLUSH_BYTES {
                            flush(&on_data, &log_tx, &mut pending).await;
                            deadline = None;
                        }
                    }
                    None => break,
                }
                continue;
            }

            let sleep_until = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now));
            tokio::pin!(sleep_until);
            tokio::select! {
                maybe_bytes = rx.recv() => {
                    match maybe_bytes {
                        Some(bytes) => {
                            pending.extend_from_slice(&bytes);
                            if pending.len() >= FLUSH_BYTES {
                                flush(&on_data, &log_tx, &mut pending).await;
                                deadline = None;
                            }
                        }
                        None => break,
                    }
                }
                _ = &mut sleep_until => {
                    flush(&on_data, &log_tx, &mut pending).await;
                    deadline = None;
                }
            }
        }

        if !pending.is_empty() {
            flush(&on_data, &log_tx, &mut pending).await;
        }
    });

    (tx, handle)
}

async fn flush(
    on_data: &Channel<InvokeResponseBody>,
    log_tx: &Option<mpsc::Sender<Vec<u8>>>,
    pending: &mut Vec<u8>,
) {
    if pending.is_empty() {
        return;
    }
    let bytes = std::mem::take(pending);
    let _ = on_data.send(InvokeResponseBody::Raw(bytes.clone()));
    if let Some(tx) = log_tx {
        let _ = tx.send(bytes).await;
    }
}
