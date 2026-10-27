// C ABI layout adapted from router-for-me/CLIProxyAPI examples/plugin/simple/go/main.go.
// Adapted for this quota-only plugin; upstream MIT notices are preserved in licenses/CLIProxyAPI-LICENSE.
// See THIRD_PARTY_NOTICES.md.
package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct { uint32_t abi_version; void* host_ctx; cliproxy_host_call_fn call; cliproxy_host_free_fn free_buffer; } cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown; } cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"
import "unsafe"

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, api *C.cliproxy_plugin_api) C.int {
	if api == nil || host == nil || host.abi_version != 1 {
		return 1
	}
	api.abi_version = 1
	api.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	api.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	api.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}
func writeBuffer(out *C.cliproxy_buffer, b []byte) { out.ptr = C.CBytes(b); out.len = C.size_t(len(b)) }

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, size C.size_t, out *C.cliproxy_buffer) (result C.int) {
	if out == nil {
		return 1
	}
	out.ptr = nil
	out.len = 0
	defer func() {
		if recover() != nil {
			if out.ptr != nil {
				C.free(out.ptr)
			}
			writeBuffer(out, fail("plugin_error", "plugin request failed"))
			result = 1
		}
	}()
	if method == nil || size > 2*1024*1024 || size > 0 && request == nil {
		writeBuffer(out, fail("invalid_request", "invalid request"))
		return 1
	}
	var b []byte
	if size > 0 {
		b = C.GoBytes(unsafe.Pointer(request), C.int(size))
	}
	writeBuffer(out, runtimePlugin.handle(C.GoString(method), b))
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, size C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() { runtimePlugin.client.CloseIdleConnections() }
