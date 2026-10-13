# API Chat

A VS Code extension that runs the Claude CLI (`claude -p`) in an editor panel, billed to your own
Anthropic API key instead of a Claude subscription. Every permission request the CLI makes, from the
main agent or any subagent, is shown in the panel for you to allow or deny. Conversations are saved and
can be resumed; print-mode conversations the CLI saved for the open workspace folders are listed too.

## Requirements

- Desktop VS Code, Cursor or Antigravity IDE. The extension starts a local process and a localhost
  permission server, so it does not run in VS Code for the Web; in a remote window it runs where the
  workspace is.
- The Claude CLI: either the Claude Code extension (its bundled CLI is found automatically) or the
  `claude` CLI installed on its own (`~/.local/bin` or on PATH), or set `apiChat.claudePath`.
- An Anthropic API key.

## Install

Either package it and install the VSIX:

```
npx @vscode/vsce package
```

then run **Extensions: Install from VSIX...** and pick the `.vsix` file. Or copy this folder into the
editor's extensions folder (`~/.vscode/extensions`, `~/.cursor/extensions` or
`~/.antigravity-ide/extensions`) as `tunaria.api-chat-0.0.1` and reload the window.

## Commands

- **API Chat: Open** opens a chat panel (you can open more than one).
- **API Chat: Set API Key** stores or replaces the key.
- **API Chat: Clear API Key** removes it.

The key is kept in the editor's SecretStorage, never in settings or files, and is passed to the CLI as
`ANTHROPIC_API_KEY`. All usage is billed to that key; the panel shows the cost of each run and the
panel total. The key is redacted from anything the CLI prints.

## Permissions

- **Auto-allow reads** lets Read, Glob, Grep, LS and TodoWrite run without asking, but only inside the
  working folder and the extra folders. Reads elsewhere still ask.
- **auto-accept file edits** allows edits only inside those same folders.
- **Always allow** is offered for other tools for the rest of the conversation, but not for file
  writes/edits or web tools. Shell commands can be approved by their first two words (simple commands
  only). Active allows and saved prefixes are listed under the toolbar; click × to remove one.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiChat.claudePath` | `""` | Path to the `claude` executable, checked before anything else. |
| `apiChat.backgroundWaitCeilingMs` | `0` | How long a run waits for background tasks (subagents, long commands) before exiting. `0` waits however long they take. |

## License

MIT
