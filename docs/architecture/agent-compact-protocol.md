# ACP: Agent Compact Protocol

ACP is Hivo's compact, line-oriented transport envelope for narrow agent-to-agent messages. It reduces repeated prose while keeping durable JSON artifacts, reviewed patches, command results, and run state as the source of truth.

ACP is a protocol, not a programming language and not a replacement for structured output schemas.

## Canonical Packet

```txt
M|FROM>TO|SESSION|TYPE|PRIORITY
G:goal
CTX:stored-context-ref
E:evidence refs
R:rules
O:expected output
```

The compact header omits the leading `M|`:

```txt
P>C|S42|patch|H
G:login returns 500
E:api/auth.ts@20-61
R:no-db; keep-api
O:diff-ref+test-result
```

Writers should emit fields in canonical order. Readers accept either header form.

## Fixed Dictionary

| Key | Meaning |
| --- | --- |
| `G` | Goal |
| `C` | Inline context |
| `CTX` | Durable context reference |
| `E` | Evidence and file references |
| `R` | Rules and constraints |
| `I` | Input reference |
| `O` | Expected output |
| `S` | Status |
| `CHG` | Changed file references |
| `T` | Test or validation reference |
| `B` | Blocker |
| `Q` | Question requiring a decision |

Priorities are `L`, `M`, `H`, and `C` for low, medium, high, and critical.

## Transport Boundary

- Use ACP for dispatch, handoff, status, verification requests, and compact result summaries.
- Put large context, patches, logs, and structured worker results in durable artifacts; ACP carries their references.
- Do not integrate an ACP message until it passes the strict parser and the referenced artifact passes its own schema and review gates.
- Do not infer missing rules from abbreviations. Unknown or repeated fields are invalid.
- Do not put secrets or untrusted command authority in ACP fields.

## Version 1 Grammar

```txt
packet       = header newline field *(newline field)
header       = ["M|"] endpoint ">" endpoint "|" session "|" type "|" priority
field        = field-key ":" non-empty-single-line-value
priority     = "L" | "M" | "H" | "C"
```

Version 1 values are opaque single-line strings. Delimiters such as `;`, `,`, and `+` are conventions understood by the sending and receiving work order, not nested ACP syntax.

## Implementation

`@hivo/protocol` exports:

- `parseAcpPacket`
- `serializeAcpPacket`
- `validateAcpPacket`
- `serializeAcpDictionary`
- the version, dictionary, limits, and TypeScript packet types

The serializer produces deterministic field order. The parser accepts full and compact headers, rejects malformed routing, unknown fields, duplicate fields, multiline values, and oversized packets.

## Adoption Path

1. Measure ACP against current prompts using real tokenizer and task-success metrics.
2. Use ACP first for low-risk dispatch and status messages while retaining JSON artifacts.
3. Add artifact-reference resolution and role-specific required-field policies at the orchestration boundary.
4. Expand usage only when trials show lower token use without worse repair rate, ambiguity, or task success.
