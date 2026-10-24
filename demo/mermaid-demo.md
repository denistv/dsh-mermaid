---
title: Mermaid document preview demo
owner: dsh-mermaid
---

# Mermaid in Markdown previews

This file is a fixture for the document preview renderer. Every Mermaid fence
below should appear as an inline diagram, while the rest stays ordinary
Markdown.

## Flowchart

```mermaid
flowchart LR
  user([User]) --> chat[Chat]
  chat --> turnTail{turnTail}
  turnTail -->|mermaid fence| render[Mermaid render]
  file[.md file] --> preview[Document preview]
  preview --> render
  render --> svg[(SVG)]
```

## Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant D as DSH Client
  participant M as Mermaid
  U->>D: open README.md
  D->>D: split fences
  D->>M: render flowchart
  M-->>D: SVG
  D-->>U: Markdown + diagram
```

## Class

```mermaid
classDiagram
  class Bundle {
    +string name
    +apply(ctx)
  }
  class ChatSeat {
    +TurnLocation turn
    +render()
  }
  class DocumentSeat {
    +DocumentContent content
    +render()
  }
  Bundle --> ChatSeat
  Bundle --> DocumentSeat
```

## State

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Loading: fence closed
  Loading --> Ready: render ok
  Loading --> Failed: parse error
  Ready --> Idle: theme change
  Failed --> Loading: retry
```

## Gantt

```mermaid
gantt
  title Plugin milestones
  dateFormat YYYY-MM-DD
  section Research
  Inspect slots and services :done, a1, 2026-10-20, 1d
  Choose render pipeline    :done, a2, after a1, 1d
  section Prototype
  Host and client scaffold  :done, b1, 2026-10-22, 1d
  Diagram cards             :active, b2, 2026-10-23, 2d
  Document preview          :b3, 2026-10-25, 2d
```

## Pie

```mermaid
pie title Where diagrams appear
  "Chat" : 55
  "Markdown preview" : 45
```

## Non-Mermaid fences stay code

```js
const bundle = {
  name: 'dsh-mermaid',
  surfaces: ['chat', 'markdown-preview'],
};
```

> Blockquotes, **bold**, _italic_, `inline code`, tables, and lists all go
> through `marked` + `DOMPurify`.

| Surface | Extension point | Loading mode |
| --- | --- | --- |
| Chat | `conversation.chat.turnTail` | durable turn data |
| Markdown | `documentPreviews` + `sidebar.right.tab.document` | `text-pages` |

Unsafe HTML is removed:

<script>alert('never runs')</script>
