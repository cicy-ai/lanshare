# lanshare-cli

Installed globally (`npm i -g lanshare-cli`) the commands are plain `lanshare` and `lannotebook`.

Zero-dependency LAN file sharing + shared notebook. Node >= 18.

```sh
npx lanshare-cli serve                                # share current directory on :8080, prints LAN URLs
npx lanshare-cli serve ~/Downloads                    # explicit directory
npx lanshare-cli serve ./dist -p 9000 -a admin:secret # custom port + HTTP Basic auth
npx lanshare-cli serve /data --daemon                 # background; lanshare status / stop
npx lanshare-cli ip                                   # LAN IPv4 addresses
npx lanshare-cli --help

npx lannotebook                                   # full-page shared textarea on :8081
npx lannotebook ~/notes/lan.md -a team:pass       # backed by a file, with auth
npx lannotebook --help
```

## serve

- Directory index (folders first, size, mtime), files streamed with MIME + Range (206)
- Read-only (GET/HEAD), paths confined to the shared root, `--no-hidden` hides dotfiles
- `-a user:pass` → HTTP Basic auth (401 otherwise)

## note / lannotebook

- One full-page `<textarea>`; autosaves 400 ms after typing stops (Ctrl+S too)
- `GET /api/note` / `PUT /api/note` (atomic write, 16 MB max); idle clients re-poll every 2 s
- Default file `~/cicy-ai/db/lanshare-note.txt`

## daemon

`--daemon` detaches and records pid/urls in `~/cicy-ai/db/lanshare.json` (`CICY_HOME` overrides `~/cicy-ai`). One `serve` and one `note` daemon per host; `lanshare status`, `lanshare stop [serve|note]`.

MIT
