# deploy.py: expose what each validation error is about

**Target:** `yume02kki/foundry`, branch `studio/structured-errors` → `main`.
**Patch:** `0001-deploy.py-expose-what-each-validation-error-is-about.patch` (on top of `982b6c3`).

## Why

Foundry Studio imports `deploy.py` as a library so the UI and the CLI can never disagree on
what a valid pipeline is. To highlight the node or edge an error is about, it needs to know
which one each message names. Every message already starts with its "where"
(`Relation 'A -> B': …`, `Transformers.X: …`, `OutputSink.ConnectionSettings: …`), so this
adds `locate(message)` next to the messages, plus `ManifestError.issues` (each error with its
location).

## What doesn't change

- No message text, exit code or CLI output changes. Checked by running `validate` with the
  old and new `deploy.py` on valid and invalid manifests and comparing the output byte for byte.
- The manifest format, `render`, `check` and `deploy` are untouched.

Foundry Studio already works without this (it carries the same parser and prefers
`deploy.locate` when present), so merging it only moves the parser to where the messages live.
