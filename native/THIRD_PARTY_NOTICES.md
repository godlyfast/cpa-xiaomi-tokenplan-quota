# Native plugin third-party notices

- `abi.go` adapts the public C ABI declaration/export example from `router-for-me/CLIProxyAPI`, commit `1f917e77c4562623aa49e9804d999524151a2f96`, `examples/plugin/simple/go/main.go`. Modified for this quota-only plugin. The original MIT license and copyright statements are reproduced in `licenses/CLIProxyAPI-LICENSE`.
- `gopkg.in/yaml.v3 v3.0.1` is linked unmodified. Its MIT/Apache notices and NOTICE are preserved in `licenses/yaml-LICENSE` and `licenses/yaml-NOTICE`; the Apache 2.0 terms are in `licenses/Apache-2.0.txt`.
- The compiled artifact includes the Go runtime and standard library. Their BSD license is in `licenses/Go-LICENSE`. Go's vendored `golang.org/x/{crypto,net,sys,text}` BSD licenses and additional patent grants are preserved alongside it as `Go-*-LICENSE` and `Go-*-PATENTS`.

The plugin implementation itself is MIT licensed under the repository's `LICENSE`, shipped with release archives. The ABI adaptation does not redistribute the gateway or the management panel. Native release archives include this file and the licenses directory; do not separate them from binary redistribution.
