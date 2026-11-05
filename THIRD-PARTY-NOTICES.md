# Third-Party Notices

This project is published under the MIT license (see `LICENSE`). This file lists
third-party work whose **ideas or formats** were studied, and reproduces the
license text that must travel with redistributions.

**Nothing listed here is a runtime dependency.** WorkBuddy2Codex ships every
file it needs; it has no npm dependencies, no `extensionDependencies` and does
not download, launch or import any third-party project. The entries below are
attribution only - they must stay in this file, they do not have to be
installed for the extension to work.

---

## 1. dsh-workbuddy-connect (attribution only - not a runtime dependency)

- Project: <https://github.com/corrinehu/dsh-workbuddy-connect>
- Author: Corrine Hu
- License: MIT

The approach used in `proxy/shared/atrest.mjs` (decrypting the WorkBuddy desktop
at-rest credential envelope), the upstream endpoint shape, the client
User-Agent style and several upstream quirk workarounds (stream-only upstream,
`developer` to `system` rewriting, tool schema hardening) were **studied from**
this project and reimplemented here against the live upstream.

What that means in practice:

- No source file, package, binary or data file from that project is
  redistributed, vendored or downloaded.
- That project does **not** have to be installed, cloned or run. Deleting it
  from your machine changes nothing about this extension.
- Only the MIT attribution below must be kept, because the reimplementation
  is derived from reading its code.

```
MIT License

Copyright (c) 2026 Corrine Hu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. WorkBuddy desktop client

- Rights holder: Tencent Technology (Shenzhen) Company Limited
- License: proprietary commercial software

The client is the **upstream service** this project talks to. No file, binary,
credential or dataset from it is redistributed here. Users install and sign in
to the client themselves.

Access goes through undocumented endpoints and may conflict with the client's
terms of service; evaluate that yourself before use.

---

## 3. Runtime environment

- **Node.js** — no npm runtime dependency. The extension and the proxy only use
  Node built-in modules plus the `vscode` API.
- **Codex** — the client application that consumes this proxy. Shipped separately.

---

## Summary

| Component | Included here | Needed to run | Notice required |
|---|---|---|---|
| Original code (`src/`, `media/`, `proxy/`) | yes | yes | MIT, (c) 2026 Black Yuan |
| dsh-workbuddy-connect | no files, approach only | **no** | yes (MIT) |
| WorkBuddy desktop client | no | yes (upstream service, user installs it) | not applicable |
