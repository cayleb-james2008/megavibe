fn main() {
    #[cfg(target_os = "linux")]
    // Whisper's static GGML symbols must not interpose on the dynamic llama.cpp runtime.
    println!(
        "cargo:rustc-link-arg=-Wl,--exclude-libs,ALL,--disable-new-dtags,-rpath,$ORIGIN/voice-libs:$ORIGIN/../lib/Megavibe/voice-libs"
    );
    tauri_build::build()
}
