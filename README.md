<p align="center">
  <img src="icon.svg" alt="dsh-mermaid icon" width="72" height="72">
</p>

<h1 align="center">dsh-mermaid</h1>

<p align="center">
  Mermaid diagrams in DeepSeek Harness chat and Markdown previews.<br>
  Rendered locally, themed with the shell, expandable to full size.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="DeepSeek Harness 0.2.1-rc.3" src="https://img.shields.io/badge/DSH-0.2.1--rc.3-4B5563">
  <img alt="Mermaid 11" src="https://img.shields.io/badge/mermaid-11-ff3670">
</p>

![Mermaid cards in chat and in a Markdown preview](demo/screen-main.png)

`dsh-mermaid` is a plugin bundle for **DeepSeek Harness (DSH)**. Every closed
<code>```mermaid</code> or <code>```mmd</code> fence becomes a real, interactive
diagram in two places:

- **Chat** — a diagram card appears under the assistant's answer that contains
  the fence.
- **Markdown preview** — open any `.md` file and Mermaid fences render inline,
  between the ordinary Markdown blocks.

Everything is bundled into the plugin: no CDN, no rendering service, no network
round trip. Diagrams follow the shell's light and dark theme, use the interface
font, and can be expanded into a resizable full-window view.

> **Status: 0.1.0 prototype.** Built and tested against DeepSeek Harness
> `0.2.1-rc.3`. The extension points it uses are not yet a stable public API, so
> expect small changes across harness releases.

## Features

- **Two surfaces, one runtime.** Chat and document preview share the same
  Mermaid renderer, theme tokens, and card UI.
- **Self-healing renders.** Successful SVGs are cached by source and theme;
  identical in-flight requests share one promise. A parse/render attempt that
  exceeds 15 seconds fails that card instead of blocking every later card.
- **Cards that stay out of the way.** Each card has **Expand**, **Source /
  Diagram**, and **Copy** controls. **Source** shows the original fence; **Copy**
  puts it on the clipboard.
- **Expandable view.** **Expand** opens a centered modal with a dimmed backdrop,
  a corner resize handle, and a **Maximize / Default size** toggle. The panel
  opens at 1120×780, resizes down to 420×300, remembers your preferred size in
  `localStorage`, and re-clamps itself when the window changes.
- **Theme-aware.** Colors are sampled from the shell's `--dsw-alias-*` tokens
  and passed to Mermaid's `base` theme; diagrams re-render on `theme/change`.
- **No second viewer.** The built-in **Markdown** preview keeps its dropdown
  entry — the plugin only replaces its body, so headings, code highlighting,
  tables, footnotes, and sanitization stay exactly as shipped.
- **Offline by design.** `mermaid`, `marked`, and `DOMPurify` are compiled into
  a single client artifact.
- **Bundled agent skill.** The Host half registers a `dsh-mermaid` skill, so the
  model can load the exact fence contract on demand. The skill is also
  user-invocable as `/dsh-mermaid`.
- **Graceful failures.** A broken diagram shows the parser error above its
  source instead of disappearing; an empty fence says so. A rendering exception
  is contained by a card-level boundary, so one bad card cannot retire the whole
  chat slot.

## Screenshots

![Expanded diagram modal over the chat](demo/screen-expand.png)

*The same diagram expanded: resizable panel, maximize toggle, Escape or a
backdrop click to close.*

## Requirements

- **DeepSeek Harness 0.2.1-rc.3** or a compatible build. The plugin targets the
  client extension points of that version.

There is no build step for users: the browser bundle ships prebuilt and all
diagram rendering happens inside the plugin.

## Install

The plugin is published on GitHub and installed straight from the repository —
no npm package, no local checkout, no build step:

```text
https://github.com/denistv/dsh-mermaid
```

DSH reads the repository, installs it as a profile bundle, and pins the commit
it installed.

### In the desktop app

1. Open **Plugins** in the sidebar.
2. Click **Add plugin**.
3. Paste the repository URL and press **Enter**:

   ```text
   https://github.com/denistv/dsh-mermaid
   ```

4. Click **Install** and wait for the result screen. The Host reads the
   repository and installs the bundle into the current profile.
5. Click **Enable now**. If the dialog is already closed, open the
   **dsh-mermaid** card under **Installed plugins** and switch it on.
6. Restart DSH if the page asks for it; otherwise reload the window. The client
   bundle is fetched on page load, so the plugin does not appear before that.

That is the whole setup — no configuration follows. The plugin applies to every
session in the profile and activates immediately when the bundle is on.

### From a DSH session

You can also ask the agent to install it from the same URL:

> Install the plugin from https://github.com/denistv/dsh-mermaid

The agent calls `plugin_manager` with `action: install_bundle` and the
repository URL, which performs the same package installation and bundle
selection as the dialog. The call needs Full access or an approval.

### Check that it works

Open `demo/mermaid-demo.md` in the sidebar: its Mermaid fences render as
diagram cards. Or ask for a diagram in chat and look for the card under the
answer.

### Update or remove

- **Update:** the installed bundle is pinned to a commit. Open its card under
  **Installed plugins**, choose **Uninstall**, then add the same URL again to
  install the latest commit.
- **Remove:** **Uninstall** on the card; confirming removes the dependency and
  the bundle entry.

Disabling or removing the bundle unregisters both surfaces, removes every style
rule the plugin added, and removes the bundled skill provider.

## Usage

### In chat

Ask the assistant for a diagram. The bundled `dsh-mermaid` skill teaches it the
exact output contract, and after the turn completes the fence is rendered as a
card below the answer:

````markdown
```mermaid
flowchart LR
  A[Question] --> B{Answer}
  B --> C[Diagram card]
```
````

Both `mermaid` and `mmd` info strings are claimed. Other languages stay plain
code blocks. Only **closed** fences render — while a message is still streaming,
an unfinished fence remains a normal code block.

The chat surface reads diagrams from **assistant turns**. A fence that you paste
into your own message is shown as an ordinary code block, not as a card; ask the
assistant to put the diagram in its answer instead.

Chat cards are read from the turn's durable assistant steps, not scraped from
the DOM, so streaming, virtualized re-renders, pagination, and session switches
cannot desynchronize them.

### In Markdown previews

Open a `.md` / `.markdown` file in the sidebar. Mermaid fences become diagram
cards inline; the rest of the document goes through the harness's own
`MarkdownText`, so typography, syntax highlighting, and sanitization match the
built-in preview.

`demo/mermaid-demo.md` is a ready-made fixture with flowchart, sequence, class,
state, Gantt, and pie diagrams, plus a non-Mermaid fence and unsafe HTML that is
stripped.

### Controls

| Control | Where | What it does |
| --- | --- | --- |
| **Expand** | Card | Opens the diagram in the modal view. |
| **Source / Diagram** | Card | Toggles between the rendered SVG and the original fence. |
| **Copy** | Card | Copies the diagram source to the clipboard. |
| **Maximize / Default size** | Modal header | Fills the available frame or returns to the saved size. |
| **Close** | Modal header | Closes the modal; Escape and a backdrop click do the same. |

The expanded view is registered in the root `shell.overlay` layer rather than
inside the transcript, because the transcript clips its overflow and may
animate with transforms — either would trap a fixed-position child. Focus moves
into the dialog on open and returns to the trigger on close.

## How it works

```mermaid
flowchart LR
  turn[Assistant turn] -->|all assistant text blocks| card[Chat card]
  file[.md document] -->|Markdown body override| preview[Preview cards]
  card --> render[Mermaid render]
  preview --> render
  render --> svg[(SVG)]
  card -. Expand .-> modal[Full-window modal]
```

| Surface | Extension point | Notes |
| --- | --- | --- |
| Chat | `conversation.chat.turnTail` (order 35) | One cell per turn; reads every assistant text step and de-duplicates identical sources. |
| Document | `sidebar.right.tab.document` | Shadows the shipped Markdown body at priority `-1` under its own key, so the viewer dropdown keeps a single **Markdown** entry. |
| Modal | `shell.overlay` | Click-through layer; the overlay root opts back into pointer events. |
| Skill | `ctx.skills` provider | The Host half registers the bundled `dsh-mermaid` skill from `assets/skills/dsh-mermaid/SKILL.md`; it is model- and user-invocable. |

The whole client is one bundle: `mermaid`, `marked`, and `DOMPurify` are
compiled into it, and only React stays external because the harness supplies it.
Nothing is fetched at runtime, so diagrams render offline.

The Host half is small but no longer empty: it keeps the Loader row and registers
a bundled skill provider. The skill body ships as
`assets/skills/dsh-mermaid/SKILL.md` and is re-read on every load, so editing the
instructions does not require a client rebuild.

Chat extraction scans every assistant text step of the Turn, not just the
closing message, and renders each distinct diagram source once. The shared
render engine runs `mermaid.parse` before `mermaid.render` with
`suppressErrorRendering: true`, so syntax errors reject cleanly instead of
leaving Mermaid's temporary error SVG in the document. Renders stay serialized
because Mermaid mutates shared layout state, but a timeout and an LRU cache keep
one slow or repeated diagram from wedging the transcript.

If the harness ever stops exposing `MarkdownText`, the document body falls back
to the bundled `marked` + `DOMPurify` renderer instead of going blank. If a
future harness adds a public code-fence renderer registry, the body override
should be replaced by it.

Every registration lives under an effect, including the stylesheet, so
disabling the plugin removes its cards, its overlay, and every rule it added.

## Compatibility and limitations

- **Chat cards are appended, not substituted.** This harness version has no
  public fence renderer, so the original code block stays visible above the
  diagram. Replacing the whole assistant step would shadow the shipped message
  UI.
- **Closed fences only.** An unfinished fence stays a code block until its
  closing line arrives.
- **The preview override is version-sensitive.** It targets the shipped
  Markdown body id. If a future harness renames that id or changes the body
  contract, the override becomes inert and the untouched built-in viewer
  returns.
- **Frontmatter** is shown verbatim in a small block instead of the built-in
  field list.
- **Splitting at fence boundaries** can break reference-style link or footnote
  definitions that live on the opposite side of a diagram.
- **Expanded view** fits the diagram to the panel: no pan and no incremental
  zoom yet. The resize handle is pointer-only; the header's **Maximize** button
  is the keyboard-friendly path.
- **Very large diagrams** can take a moment to lay out, because renders are
  serialized to protect Mermaid's shared layout state. Each attempt has a
  15-second budget; when it expires the card shows the error and the queue moves
  on. The underlying Mermaid call cannot be cancelled, so a pathological diagram
  may still keep the library busy until the window is reloaded.
- **Chat extraction is source-based.** A diagram is read from assistant text
  blocks only; fences in reasoning blocks or tool results are ignored. Identical
  sources are rendered once per Turn.
- **Coexistence.** Another chat plugin that appends diagram cards (for example
  `@baconbao/dsh-mermaid-image-preview`) will add a second card for the same
  fence. Keep one of them enabled. On the document side there is no second
  viewer entry to collide with.

## License

[MIT](LICENSE) © dsh-mermaid contributors.
