# pi-tool-groups

A [pi](https://github.com/earendil-works/pi) extension that draws tool calls the way Claude Code 2.1.293 does in fullscreen mode.

Runs of reads, searches, listings, shell commands, and the thinking between them fold into one line.

```
  Thought for 12s, searched for 2 patterns, read 3 files, ran 4 shell commands
```

While a group runs, or the agent is still at work right after it, a dim marker blinks, its verbs switch to the present tense, the elapsed time shows after two seconds, and a second line shows what the latest call or thought is about.

```
⏺ Reading 1 file, running 2 shell commands · 5s…
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

As in Claude Code's fullscreen view, a click opens a group, or a row whose short result leaves something out, and clicks on blank cells do nothing. The opened item shows every call and thought exactly as Pi draws it, so a click on a call's output or on a thought opens and closes that one the way it does in Pi. A "show less" line below closes the item again. A click that opens or closes an item stops the view from following new output, so the clicked line stays put.

Pi's tool output toggle (`ctrl+o` by default) does not open or close anything here. It only changes how Pi draws the calls inside an opened item.

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
