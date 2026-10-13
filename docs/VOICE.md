# Local voice

Megavibe's Linux desktop voice planner runs on the device. The Rust app includes microphone capture and native inference libraries; it does not require an account, API key, hosted planner, or speech service. Audio is held in memory for the active recording (up to 60 seconds), transcribed locally, then discarded. The planner receives the active workspace name plus board notes, checklists, and kanban items. It never receives terminal output. It can suggest notes, checklists, and kanban tasks; the user reviews and approves each board update.

The voice page downloads speech-recognition and planner weights only after the user requests setup. Downloads are pinned to immutable repository revisions and checked against SHA-256 before Megavibe uses them. Model files stay under Megavibe's private app-data directory. Spoken replies use a built-in 16 kHz US-English voice and need no separate model download. Once setup is complete, transcription, planning, and spoken replies work offline. No downloaded model weights are included in the source repository.

## Open-source components and models

| Feature | Component/model | License | Approximate download |
| --- | --- | --- | ---: |
| Speech recognition | `whisper-rs` / whisper.cpp; multilingual Whisper base | MIT | 148 MB |
| Local planner | `llama-cpp-2` / llama.cpp; Qwen3-4B Q4_K_M | MIT / Apache-2.0 | 2.50 GB |
| Spoken response | `flite-rs` with its built-in `kal16` US-English voice | Apache-2.0 code; CMU attribution license for bundled speech data | Included in the app |

The built-in `kal16` voice is a compact, lower-fidelity diphone voice compared with neural TTS. It speaks US English and is bundled in the application, so spoken replies remain available offline without a separate voice download. The Flite crate's Apache license, required CMU speech-data attribution, and the Whisper.cpp and llama.cpp MIT notices are preserved in `src-tauri/licenses/` and added to the Linux package resources. Model pages: [Whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) and [Qwen3 GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF). Engine sources: [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [llama.cpp](https://github.com/ggml-org/llama.cpp), and [flite-rs](https://github.com/GabrielVicini/flite-rs).

The planner is a smaller local model than the hosted system described by Hypervibe, and may produce less capable or less consistent plans. Speech input is multilingual through Whisper; the selected spoken-response voice is US English. No packaged Hypervibe desktop app or private account was available for a direct feature comparison. See [`RESEARCH.md`](RESEARCH.md) for the public-scope comparison and verification boundary.
