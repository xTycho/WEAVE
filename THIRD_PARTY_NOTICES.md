# Third-party notices

The pre-built map in `src/ui/dist` bundles the following.

## thinking-orbs (engine only)

Used for the small animated activity orbs. Installed from npm as `thinking-orbs`; only its `engine` entry is bundled.

```
MIT License

Copyright (c) 2026 Jakub Antalik

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

## Righteous and Space Grotesk fonts

Bundled through `@fontsource/righteous` and `@fontsource/space-grotesk`, under the SIL Open Font License 1.1.

```
Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Name "Righteous"

This Font Software is licensed under the SIL Open Font License, Version 1.1.

Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)
```

Full license text: https://openfontlicense.org

## xterm.js

Bundled in the map page through `@xterm/xterm` and `@xterm/addon-fit` to show the embedded chat, under the MIT License. See the packages' LICENSE files for the copyright holders.

## node-pty

The embedded chat runs Claude Code on a pseudo-terminal through `@lydell/node-pty` (a prebuilt distribution of Microsoft's node-pty), under the MIT License.

## thinking-orbs (Claude Code mod)

`mods/weave-panel/hooks/orbs.ts` holds frames baked from the thinking-orbs engine (MIT License, Copyright (c) 2026 Jakub Antalik) by `scripts/gen-orbs.mjs`, so the Claude Code panel draws the same dots as the map.
