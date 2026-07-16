#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        std::process::exit(codex_nn_lib::run_mcp());
    }
    codex_nn_lib::run();
}
