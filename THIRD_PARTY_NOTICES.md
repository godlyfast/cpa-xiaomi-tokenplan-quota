# Third-party notices

The dashboard patch derives from [router-for-me/Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center), v1.26.7, commit `714de0760a3ce86094b178fb46f834d34bc4a2a5`. Its original MIT notice follows unchanged. The backend is not vendored or modified. Built dashboards retain their upstream runtime dependencies; the build generates `panel-third-party-licenses.txt` from the exact locked dependency installation (including development dependencies) and ships it with the artifact. Preserve that file and `UPSTREAM-PANEL-LICENSE` on redistribution.

The collector/parser implementation is original. Community implementations informed feasibility research only; no opencode-statusline or quota-sentinel source was copied. No GPL quota-sentinel code is included.

## Original panel license

MIT License

Copyright (c) 2026 Router-For.ME

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
