"""Authenticated, temporary model loader for the llm-tiny RunPod run."""
import hmac
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ['TINY_TOKEN']
DEADLINE = int(os.environ['TINY_DEADLINE'])
MODELS = json.loads(os.environ['TINY_MODELS'])
MODEL_PROCESS = None
MODEL = None
LOCK = threading.Lock()
LOG = '/tmp/llm-tiny-vllm.log'


def stop_model():
    global MODEL_PROCESS
    if MODEL_PROCESS and MODEL_PROCESS.poll() is None:
        os.killpg(MODEL_PROCESS.pid, signal.SIGTERM)
        try:
            MODEL_PROCESS.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(MODEL_PROCESS.pid, signal.SIGKILL)
            MODEL_PROCESS.wait(timeout=15)
    MODEL_PROCESS = None


def watchdog():
    time.sleep(max(0, DEADLINE - time.time()))
    while True:
        try:
            req = urllib.request.Request(
                'https://rest.runpod.io/v1/pods/' + os.environ['RUNPOD_POD_ID'],
                headers={'Authorization': 'Bearer ' + os.environ['TINY_RUNPOD_KEY']}, method='DELETE')
            with urllib.request.urlopen(req, timeout=20):
                return
        except Exception:
            # Stop the workload immediately while retrying resource cleanup.
            with LOCK:
                stop_model()
            time.sleep(15)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def reply(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {'error': 'Unauthorized'})
        if self.path == '/logs':
            try:
                with open(LOG, 'rb') as stream:
                    stream.seek(max(0, os.path.getsize(LOG) - 14000))
                    data = stream.read().decode(errors='replace')
            except FileNotFoundError:
                data = ''
            return self.reply(200, {'log': data})
        if self.path != '/status':
            return self.reply(404, {'error': 'Unknown route'})
        ready = False
        try:
            req = urllib.request.Request('http://127.0.0.1:8000/v1/models', headers={'Authorization': 'Bearer ' + TOKEN})
            with urllib.request.urlopen(req, timeout=3) as r:
                ready = bool(json.load(r).get('data'))
        except Exception:
            pass
        gpu = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.used', '--format=csv,noheader'], capture_output=True, text=True, timeout=10)
        self.reply(200, {'model': MODEL, 'ready': ready, 'exitCode': MODEL_PROCESS.poll() if MODEL_PROCESS else None, 'gpu': gpu.stdout.strip(), 'deadline': DEADLINE})

    def do_POST(self):
        global MODEL_PROCESS, MODEL
        if not self.authorized():
            return self.reply(401, {'error': 'Unauthorized'})
        if self.path != '/model':
            return self.reply(404, {'error': 'Unknown route'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length < 4096:
                raise ValueError('Invalid request size')
            data = json.loads(self.rfile.read(length))
            name = data['model']
            if name not in MODELS:
                raise ValueError('Model is not allow-listed')
            with LOCK:
                stop_model()
                MODEL = name
                args = ['vllm', 'serve', name, '--revision', MODELS[name], '--dtype', 'bfloat16', '--host', '0.0.0.0', '--port', '8000', '--api-key', TOKEN,
                        '--max-model-len', '16384', '--max-num-seqs', '1', '--gpu-memory-utilization', '0.90', '--enforce-eager', '--tensor-parallel-size', os.environ['TINY_GPUS']]
                if 'compass' in name:
                    args += ['--enable-auto-tool-choice', '--tool-call-parser', 'hermes']
                else:
                    args += ['--limit-mm-per-prompt', '{"image":3}']
                with open(LOG, 'w') as stream:
                    MODEL_PROCESS = subprocess.Popen(args, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            self.reply(200, {'model': name, 'revision': MODELS[name], 'pid': MODEL_PROCESS.pid})
        except Exception as error:
            self.reply(400, {'error': str(error)})


threading.Thread(target=watchdog, daemon=True).start()
ThreadingHTTPServer(('0.0.0.0', 8001), Handler).serve_forever()
