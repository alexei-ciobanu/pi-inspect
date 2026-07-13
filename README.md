# pi-inspect

A small inspection extension for the Pi coding agent. It adds user-only slash commands and does not add model tools or modify the system prompt.

## Commands

```text
/inspect prompt [show|copy]  Inspect the current effective system prompt
/inspect result [show|copy]  Inspect the most recent finalized tool exchange
/inspect results             Select from recent finalized tool exchanges
/inspect tools               Inspect configured tool metadata and schemas
```

Aliases:

```text
/system-prompt [show|copy]
/tool-result [show|copy]
```

`show` opens Pi's multiline editor as a convenient scrollable viewer; any edits are discarded. `copy` uses the native clipboard command available on macOS, Windows, WSL, Linux, or Termux.

Tool exchanges are reconstructed from the active session branch. The report pairs the parsed tool call persisted in the assistant message with the finalized tool-result message after tool-result hooks and message-end replacements. It also shows the compact arguments JSON and the text-result string formed by joining text blocks with a newline, as Pi's standard provider serializers do. Tool `details` are shown separately because they are Pi metadata and are not sent to the model.

Pi stores parsed tool arguments rather than the provider's original lexical JSON stream. The report is therefore semantically exact, but inconsequential whitespace from the provider's raw JSON is not available. Provider serialization can additionally normalize IDs, sanitize invalid Unicode surrogates, and encode images differently; the persisted Pi message is shown so those distinctions remain explicit.

## Install from Git

Use a pinned commit:

```bash
pi install git:github.com/alexei-ciobanu/pi-inspect@COMMIT
```

Then run `/reload` in existing Pi sessions.

## Development

```bash
bun install
bun run check
pi --no-extensions -e .
```

This repository is intentionally private to package registries (`"private": true`); it is distributed directly from Git rather than npm.
