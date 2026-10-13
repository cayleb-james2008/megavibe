#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tauri_dir="$(cd -- "$script_dir/.." && pwd)"
target_dir="$tauri_dir/target/release"
llama_library="$(find "$target_dir/build" -type f -path '*/llama-cpp-sys-*/out/lib/libllama.so.*' -print -quit)"
if [[ -z "$llama_library" ]]; then
  printf '%s\n' "Could not find the dynamically linked llama.cpp libraries under $target_dir/build" >&2
  exit 1
fi
library_dir="${llama_library%/*}"
resource_destination="$tauri_dir/resources/voice-libs"
runtime_destination="$target_dir/voice-libs"
mkdir -p "$resource_destination" "$runtime_destination"

copy_if_changed() {
  local source="$1"
  local directory="$2"
  local destination="$directory/${source##*/}"
  if [[ -L "$source" && -L "$destination" ]] && \
    [[ "$(readlink -- "$source")" == "$(readlink -- "$destination")" ]]; then
    return
  fi
  if [[ -f "$source" && -f "$destination" && ! -L "$destination" ]] && \
    cmp -s -- "$source" "$destination"; then
    return
  fi
  cp -a -- "$source" "$directory/"
}

for library in "$library_dir"/libllama.so* "$library_dir"/libggml.so* \
  "$library_dir"/libggml-base.so* "$library_dir"/libggml-cpu.so*; do
  if [[ -e "$library" ]]; then
    copy_if_changed "$library" "$resource_destination"
    copy_if_changed "$library" "$runtime_destination"
  fi
done

for library in libllama.so.0 libggml.so.0 libggml-base.so.0 libggml-cpu.so.0; do
  [[ -e "$resource_destination/$library" ]] || {
    printf 'Missing runtime library: %s\n' "$resource_destination/$library" >&2
    exit 1
  }
  [[ -e "$runtime_destination/$library" ]] || {
    printf 'Missing runtime library: %s\n' "$runtime_destination/$library" >&2
    exit 1
  }
done
