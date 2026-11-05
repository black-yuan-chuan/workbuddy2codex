# Third-Party Notices

This project is published under the MIT license (see `LICENSE`). This file lists
third-party work that the local proxy runtime borrows from or interoperates with,
and reproduces the license text that must travel with it.

---

## 1. dsh-workbuddy-connect (required)

- Project: <https://github.com/corrinehu/dsh-workbuddy-connect>
- Author: Corrine Hu
- License: MIT

Parts of `proxy/shared/atrest.mjs` and `proxy/proxy.mjs` were adapted from this
project: the WorkBuddy desktop at-rest credential format, the upstream endpoint
shape, the client User-Agent style and several upstream quirk workarounds
(stream-only upstream, `developer` to `system` rewriting, tool schema hardening).

No source file from that project is redistributed here. Its MIT notice is
reproduced below as required.

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

| Component | Included here | Notice required |
|---|---|---|
| Original code (`src/`, `media/`, `proxy/`) | yes | MIT, (c) 2026 Black Yuan |
| dsh-workbuddy-connect (adapted parts) | adapted only, no files | **yes** (MIT) |
| WorkBuddy desktop client | no | not applicable |
