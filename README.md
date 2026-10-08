# pi-tool-groups

A [pi](https://github.com/earendil-works/pi) extension that draws tool calls the way Claude Code 2.1.293 does in fullscreen mode.

Runs of reads, searches, listings, shell commands, and the thinking between them fold into one line.

```
  Thought for 12s, searched for 2 patterns, read 3 files, ran 4 shell commands (ctrl+o to expand)
```

While a group runs, a dim marker blinks, its verbs switch to the present tense, the elapsed time shows after two seconds, and a second line shows what the latest call or thought is about.

```
⏺ Reading 1 file, running 2 shell commands · 5s… (ctrl+o to expand)
  ⎿  $ make test (5s · 12 lines)
```

Every other call keeps its own row with a green or red marker and a short result.

```
⏺ Update(src/index.ts)
  ⎿  Added 2 lines, removed 1 line
      …diff…
```

## What folds

- `read`, `grep`, `find`, and `ls` count as reads, searches, and listings.
- Every `bash` call folds. A command that only searches, reads, or lists counts as that, and anything else counts as a shell command. `cd` and `echo` do not change what a command counts as.
- A turn that only thought opens a group or joins the one it sits in. Its time runs from the request to the end of the turn, capped at ten minutes, as Claude Code counts it.
- Only your messages and commands, the model's answers, and calls that keep their own row end a group. Anything else between two folded calls, whichever extension added it, folds in where it stands.

## Opening

Click a group or a row to open just that one. Click a group's line again to close it, or a row's output, as with any Pi row. Pi's tool output toggle (`ctrl+o` by default) opens or closes them all. Opened, each call is Pi's own row. A click stops a fullscreen view from following new output, so the clicked line stays put.

The extension changes only how the chat is laid out. It does not touch tool definitions, thinking display, or key bindings.

## Install

```bash
pi install git:github.com/YanzuoLu/pi-tool-groups
```

## Development

```bash
npm install
npm run check
```
