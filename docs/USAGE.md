# Usage analytics support

Megavibe follows the public [Hypervibe usage feature](https://www.hypervibe.so/features/usage): show a per-CLI usage check and local token totals by day and agent. Log parsing is local, read-only, and does not upload transcripts, prompts, project paths, or parsed totals.

## On-demand CLI status checks

The Usage page can launch these installed executables with a fixed interactive slash command:

| CLI | Command sent | Result parsing |
| --- | --- | --- |
| Claude Code (`claude`) | `/usage` | Finds labeled usage/limit/session/weekly percentages. |
| Codex (`codex`) | `/status` | Finds labeled session, rate-limit, or weekly percentages. |
| Gemini CLI (`gemini`) | `/stats model` | Finds labeled usage/limit/session percentages. |

Checks are user-triggered, run for at most eight seconds, and capture at most 32 KiB of terminal output in memory. The UI receives only recognized period labels and percentages; raw output is discarded. The child gets `PATH`, locale, standard XDG/CLI home settings, and basic terminal dimensions; arbitrary environment variables (including API-key variables) are not inherited. The CLI can read its local sign-in state from the selected home and may contact its provider to show account usage. This depends on CLI version, sign-in, and network availability. A CLI with a different screen layout may return no recognized percentages. No prompt or project path is supplied to the CLI.

## Local session logs

The scanner reads only these conventional locations under the current home and the selected Megavibe profile homes. It follows no symlinks and ignores unknown JSON fields, including message text and prompt content.

| CLI | File selection | Metadata used |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Assistant records with `message.id`, `timestamp`, and `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). Repeated records for one message ID are deduplicated by component-wise maximum. |
| Codex | `$CODEX_HOME/sessions/**/rollout-*.jsonl`, or `~/.codex/sessions/**/rollout-*.jsonl` | `token_usage_record` payload response IDs and usage counts are preferred and deduplicated. If there are no response records in a file, cumulative `event_msg` token snapshots are converted to deltas. Cached input is already part of input and is not added again. |
| Gemini CLI | `~/.gemini/tmp/**/session-*.json` and `session-*.jsonl` | Legacy session `messages[]` and record-per-line messages with `type: "gemini"`, `timestamp`, and `tokens`. Uses `total` when present; otherwise adds input, output, thoughts, and tool counts. Cached input is treated as a subset. |

Charts cover 7, 30, or 90 UTC calendar days and group tokens by CLI plus profile. Token counts are session-log totals, not a billing or provider-accounting source. Claude records may be partial; Codex and Gemini schemas can change without notice. The Gemini transcript format and Claude/Codex local session internals are not stable public contracts, so unsupported variants are omitted rather than guessed. This implementation does not read CLI hooks, provider APIs, invoice data, or logs for other tools.

The scan is bounded to 1,500 files, 32 MiB per file, 512 MiB total input, directory depth 16, 100 profile IDs, and one million parsed records/messages per request. Skipped files/records are disclosed in the Usage page. Missing, malformed, old, or unsupported records can make totals incomplete. The scan does not modify files or persist token analytics.

## Public behavior references

- [Hypervibe Usage](https://www.hypervibe.so/features/usage)
- [Claude Code CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Codex TUI slash commands](https://github.com/openai/codex/blob/main/codex-rs/tui/src/slash_command.rs)
- [Codex token usage protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- [Gemini CLI getting started and `/stats`](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md)
