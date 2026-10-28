#!/usr/bin/env python3
"""Exercise the actual C ABI library in a real, isolated CPA process.
CPA_BINARY=/path/to/CLIProxyAPI NATIVE_PLUGIN=/path/to/plugin.so python3 native/integration_test.py
Synthetic data only; no real config, auth directories, provider calls or Docker changes.
"""
import contextlib
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
fixture = {"schemaVersion": 1, "region": "sgp", "accountLabel": "Synthetic <account>", "planName": "Pro", "pools": [{"id": "plan", "label": "Plan", "unit": "credits", "used": "60", "limit": "100", "remaining": "40", "remainingPercent": "40.00"}], "fetchedAt": None, "expiresAt": "2099-11-27T12:00:00Z", "expired": False, "resetsAt": None, "stale": False, "error": None}
def stamp(minutes=0):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
# v0.3.0 collector additions; host label and command are synthetic.
def session(state='ok', rejected=None):
    # No Xiaomi attempt is scheduled while the file is missing or invalid.
    return {'state': state, 'updatedAt': stamp(-180), 'rejectedAt': rejected, 'lastAttemptAt': stamp(-1), 'nextAttemptAt': None if state in ('missing', 'invalid_file') else stamp(4)}
def renewal(result='not_needed', command=None):
    return {'checkedAt': stamp(-2), 'result': result, 'renewedAt': stamp(-180), 'host': 'synthetic-host', 'manualCommand': command}
class Collector(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == '/v1/quota'
        assert not self.headers.get('Cookie') and not self.headers.get('Authorization')
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(fixture).encode())
    def log_message(self, *_): pass

def run():
    binary = Path(os.environ['CPA_BINARY']).resolve()
    library = Path(os.environ['NATIVE_PLUGIN']).resolve()
    fixture['fetchedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    collector = ThreadingHTTPServer(('127.0.0.1', 0), Collector)
    threading.Thread(target=collector.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='xiaomi-native-proof-') as tmp:
        root = Path(tmp); (root/'auth').mkdir(); (root/'plugins').mkdir()
        shutil.copy(library, root/'plugins'/library.name)
        with socket.socket() as s: s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        def request(path, data=None, auth=True):
            headers = {'Authorization': 'Bearer synthetic-management'} if auth else {}
            if data is not None: headers['Content-Type'] = 'application/json'
            try:
                with urlopen(Request(base+path, headers=headers, data=None if data is None else json.dumps(data).encode()), timeout=6) as r:
                    return r.status, r.read(), dict(r.headers)
            except HTTPError as e: return e.code, e.read(), dict(e.headers)
        def config(index):
            return f'''config-version: 8
server:
  host: 127.0.0.1
  port: {port}
management:
  allow-remote: false
  secret-key: synthetic-management
  disable-control-panel: true
  disable-auto-update-panel: true
oauth:
  auth-dir: {root/'auth'}
access:
  api-keys: [synthetic-client]
api-keys:
  openai-compatibility:
    - name: XIAOMI
      base-url: https://xiaomi-test.invalid/v1
      keys:
        - api-key: synthetic-inference-never-used
      models:
        - name: synthetic-model
plugins:
  enabled: true
  dir: {root/'plugins'}
  configs:
    xiaomi-tokenplan-quota:
      enabled: true
      collector_url: http://127.0.0.1:{collector.server_port}/v1/quota
      auth_index: {index}
'''
        @contextlib.contextmanager
        def gateway(index):
            (root/'config.yaml').write_text(config(index))
            with (root/'gateway.log').open('ab') as log:
                proc = subprocess.Popen([str(binary), '--config', str(root/'config.yaml'), '--local-model'], cwd=root, stdout=log, stderr=log)
                try:
                    for _ in range(80):
                        if proc.poll() is not None: raise AssertionError((root/'gateway.log').read_text()[-5000:])
                        try:
                            if request('/healthz', auth=False)[0] == 200: break
                        except OSError: pass
                        time.sleep(.1)
                    else: raise AssertionError('isolated gateway startup timeout')
                    yield
                finally:
                    proc.terminate()
                    try: proc.wait(timeout=8)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        try:
            with gateway('unbound'):
                status, body, _ = request('/v8/management/config/api-keys/openai-compatibility')
                assert status == 200, (status, body)
                rows = json.loads(body)
                assert len(rows) == 1 and rows[0]['name'] == 'XIAOMI', rows
                index = rows[0]['keys'][0]['auth_index']
            with gateway(index):
                status, body, _ = request('/v8/management/plugins')
                plugins = json.loads(body); assert status == 200 and plugins['plugins_enabled'], (status, plugins)
                assert len(plugins['plugins']) == 1, plugins
                entry = plugins['plugins'][0]
                assert entry['id'] == 'xiaomi-tokenplan-quota' and entry['registered'] and entry['effective_enabled'] and entry['supports_quota'], entry
                status, body, headers = request('/v0/resource/plugins/xiaomi-tokenplan-quota/quota', auth=False)
                assert status == 200 and b'CPA management key' in body and b'Synthetic' not in body
                assert 'no-store' in headers.get('Cache-Control', '')
                route = '/v0/management/plugins/xiaomi-tokenplan-quota/snapshot'
                assert request(route, auth=False)[0] == 401
                status, body, _ = request(route)
                assert status == 200 and json.loads(body)['pools'][0]['remaining'] == '40', (status, body)
                assert request(route+'?token=ignored')[0] == 400
                assert request('/v0/resource/plugins/xiaomi-tokenplan-quota/snapshot', auth=False)[0] == 404
                status, body, _ = request('/v0/management/quota/fetch', {'auth_index': index})
                data = json.loads(body)
                assert status == 200 and data['groups'][0]['buckets'][0]['remainingFraction'] == .4, (status, data)
                assert data['subscription']['plan'] == 'Pro' and data['summary'][0]['unit'] == 'Credits', data
                fixture['stale'] = True; fixture['error'] = 'auth_required'
                assert request('/v0/management/quota/fetch', {'auth_index': index})[0] == 502
                assert json.loads(request(route)[1])['error'] == 'auth_required'
                fixture['stale'] = False; fixture['error'] = None
                assert request('/v0/management/quota/fetch', {'auth_index': index})[0] == 200
                # Fresh v0.3.0 shape: session/renewal pass through and native quota stays available.
                fixture['session'] = session(); fixture['renewal'] = renewal()
                status, body, _ = request(route); data = json.loads(body)
                assert status == 200 and data['session'] == fixture['session'] and data['renewal'] == fixture['renewal'], (status, data)
                assert request('/v0/management/quota/fetch', {'auth_index': index})[0] == 200
                # Expired session with a renewal report: verbose, bounded guidance through the real host.
                command = 'bun refresher/refresh-session.ts --label "<synthetic>"'
                fixture.update(stale=True, error='auth_required', session=session('expired', stamp(-30)), renewal=renewal('signin_required', command))
                status, body, _ = request(route); data = json.loads(body)
                assert status == 200 and data['session']['state'] == 'expired' and data['renewal']['manualCommand'] == command, (status, data)
                status, body, _ = request('/v0/management/quota/fetch', {'auth_index': index})
                assert status == 502, (status, body)
                text = json.loads(body)['error']
                for want in ('Xiaomi rejected the collector session', 'Renewal agent on synthetic-host', 'not signed in', f'Run on synthetic-host: `{command}`', 'Details: Plugins'):
                    assert want in text, (want, text)
                assert len(text.encode()) <= 400 + len('failed to fetch quota: '), text
                # Account mismatch (refresher refused another Xiaomi account) on a missing file with no scheduled attempt.
                fixture.update(session=session('missing', stamp(-30)), renewal=renewal('account_mismatch', command))
                status, body, _ = request(route); data = json.loads(body)
                assert status == 200 and data['session']['nextAttemptAt'] is None and data['renewal']['result'] == 'account_mismatch', (status, data)
                status, body, _ = request('/v0/management/quota/fetch', {'auth_index': index})
                text = json.loads(body)['error']
                for want in ('session file is missing', 'cannot compare accounts with a missing or unusable session file', '--rebind', 'Details: Plugins'):
                    assert status == 502 and want in text, (want, status, text)
                assert len(text.encode()) <= 400 + len('failed to fetch quota: '), text
                # Invalid renewal data fails closed for the whole snapshot.
                fixture['renewal'] = dict(renewal(), host='.bad host')
                assert request(route)[0] == 503 and request('/v0/management/quota/fetch', {'auth_index': index})[0] == 502
                # Older collector shape: no session/renewal keys anywhere, native quota still works.
                for key in ('session', 'renewal'): fixture.pop(key)
                fixture.update(stale=False, error=None)
                status, body, _ = request(route); data = json.loads(body)
                assert status == 200 and 'session' not in data and 'renewal' not in data, data
                assert request('/v0/management/quota/fetch', {'auth_index': index})[0] == 200
            print(json.dumps({'realCABI': True, 'registeredAndLoaded': True, 'publicShellOnly': True, 'unauthenticatedSnapshot': 401, 'quotaFraction': .4, 'authFailureRecovery': True, 'sessionRenewalPassThrough': True, 'expiredSessionGuidance': True, 'accountMismatchGuidance': True, 'invalidRenewalFailsClosed': True, 'oldCollectorShape': True, 'syntheticOnly': True}))
        finally:
            collector.shutdown(); collector.server_close()

if __name__ == '__main__': run()
