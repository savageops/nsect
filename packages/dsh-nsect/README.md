# dsh-nsect

Keyless search provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It registers a `WebSearchProvider` into DSH's `ctx.web` seam so the
model-facing `web_search` tool runs on the local nsect CLI — stealth-browser,
multi-engine search — instead of a keyed remote API. **No API key, no account.**

Part of the nsect repo (`packages/`), published to npm as `dsh-nsect`.
Engine dependency: [`@nsect/cli`](https://www.npmjs.com/package/@nsect/cli).

## Install

```sh
dsh plugin --profile web add dsh-nsect
```

Then mount it — either list it as a bundle in the profile's `package.json`
(`dsh.profile.bundles`) so its own `cordis.patch.yml` applies, or add three
rows to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: web-search-nsect
      name: dsh-nsect
- id: web
  config:
    searchProvider: nsect
- id: web-search-nsect
  disabled: false
```

Patch-file edits **hot-recompose the running tree** — DSH installs a patch
watcher at boot (creating the HMR plugin on demand), so search starts working
within seconds. No restart needed. (Changes to the plugin's *code* do require
a restart of the host unit, plus a browser refresh for client bundles.)

Upgrading from the older `dsh-web-search-nsect`: swap the insert row's `name`
to `dsh-nsect`. The loader entry id (`web-search-nsect`) and the provider
registry id (`nsect`) are unchanged, so every existing patch row — including
`plugin-toggle` managed blocks — keeps addressing it.

## How it works

```
web_search tool → ctx.web seam (searchProvider: nsect, resolved strictly)
              → dsh-nsect provider → nsect CLI (--format json)
              → stealth-browser multi-engine search → {url, title, snippet}[]
```

The seam resolves `web.searchProvider` **strictly, with no fallback chain**:
an id that is not registered fails every `web_search` call with
`WEB_PROVIDER_CONFIGURED_MISSING`; a registered provider whose binary is
missing fails with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. `available()` here
checks the exact binary-resolution order used at search time, so the error
always names the real obstacle.

### Binary resolution order

1. Settings `nsect.bin` (absolute path)
2. `$DSH_NSECT_BIN`
3. Legacy `~/.dsh/tools/nsect` install
4. This package's bundled `@nsect/cli` dependency ← **installing the plugin alone is sufficient**

## Configuration

Settings namespace `nsect` (GUI settings page or `settings.yaml`; hot-applied):

| Key             | Default | Meaning                                          |
| --------------- | ------- | ------------------------------------------------ |
| `bin`           | `""`    | Absolute launcher path; wins over resolution     |
| `timeoutSeconds`| `45`    | Engine budget (`--timeout`)                      |
| `maxResults`    | `10`    | Result cap (`--max-results`)                     |
| `searchEngines` | `""`    | Engine fallback CSV (`--search-engines`); empty = CLI default |
| `delayMs`       | `1000`  | Pre-engine delay floor (`--delay`)               |
| `headless`      | `true`  | `false` passes `--no-headless` (debugging)       |

## Troubleshooting (each entry is a real incident)

**"configured web provider *nsect* is not registered"**
The provider row is not mounted *or is disabled*. First check:

```sh
dsh --profile web --dump-config 2>&1 | tail -20
```

`dsh-plugin-toggle` keeps **no state file** — its toggles live as
`# managed:plugin-toggle` blocks appended to the profile's `cordis.patch.yml`,
and *later rows win*. A managed `disabled: true` at the end of the file
overrides every earlier enable of the same id. Delete the stale managed block
(or toggle the plugin back on in the GUI); the tree recomposes live.

**"registered but unavailable" / "nsect engine not found"**
No binary candidate exists. Install `@nsect/cli`, set `nsect.bin`, or export
`DSH_NSECT_BIN` (see resolution order above).

**"nsect exited N"**
The engine ran and failed; the message carries the first 400 bytes of the
CLI's stderr (engine bugs, browser launch failures, proxy errors).

**Search broke after editing settings.yaml**
Sections of `settings.yaml` whose owner plugin is uninstalled are dead config
— silently ignored. The `nsect` section stays live because this plugin owns
it; if you removed the plugin, the section is inert, not broken.

**Patch edit did nothing**
Patch rows recompose live; plugin *code* changes do not. Restart the host
unit (`systemctl restart <your-dsh-unit>`) after changing `src/index.js`.

## License

MIT — see [LICENSE](./LICENSE).
