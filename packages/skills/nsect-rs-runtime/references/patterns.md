# Patterns

## Best Practices

- Start with the launcher script so path resolution stays stable.
- Treat the bundled binary as the default runtime artifact.
- Match the user request to the narrowest valid command surface.
- Capture machine-checkable evidence before closing the task.
- Prefer `--output` for long extraction payloads that should survive the terminal session.
- Prefer explicit search engine order and explicit transcript method order when debugging quality.

## Anti-Patterns

- Do not invent alternate environment variable names.
- Do not describe unsupported flags or engines as available.
- Do not skip output validation after a nominally successful process exit.
- Do not report transcript success without checking whether a real transcript body was returned.
- Do not confuse `serve` behavior with `engine` CLI behavior; they are adjacent surfaces, not the same contract.

## Reporting Rules

- Mention the command surface used.
- Mention the output surface used.
- Mention the relevant artifact path when files were written.
- Mention blockers explicitly when the binary, environment, or requested route is unavailable.
