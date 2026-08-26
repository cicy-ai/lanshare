# lannotebook

Shared LAN notebook — one full-page textarea, autosaved to a file, everyone on the LAN sees the same text.

```sh
npx lannotebook                          # :8081, file ~/cicy-ai/db/lanshare-note.txt
npx lannotebook ~/notes/lan.md -p 9001   # custom file + port
npx lannotebook -a team:pass             # HTTP Basic auth
npx lannotebook --daemon && npx lannotebook status && npx lannotebook stop
npx lannotebook --help
```

Wrapper around [`lanshare-cli`](https://www.npmjs.com/package/lanshare-cli) (`lanshare note ...`). MIT
