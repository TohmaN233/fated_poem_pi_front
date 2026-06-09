import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';

let seq = 0;

export class PiRpcClient extends EventEmitter {
  constructor({ cwd, env, sessionFile, bridgePort, gameExtension = './extensions/extension.ts', bridgeExtension = './extensions/web-bridge.ts', sessionDir = './sessions' }) {
    super();
    this.cwd = cwd;
    this.env = env;
    this.sessionFile = sessionFile;
    this.bridgePort = bridgePort;
    this.gameExtension = gameExtension;
    this.bridgeExtension = bridgeExtension;
    this.sessionDir = sessionDir;
    this.proc = null;
    this.pending = new Map();
    this.ready = false;
    this.stderrTail = [];
  }

  start() {
    if (this.proc) return;
    const args = [
      '--mode', 'rpc',
      '--no-context-files',
      '-e', this.gameExtension,
      '-e', this.bridgeExtension,
      '--session-dir', this.sessionDir,
    ];
    if (this.sessionFile) args.push('--session', this.sessionFile);

    this.proc = spawn('pi', args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        DEST_POET_WEB_BRIDGE_PORT: String(this.bridgePort),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('exit', (code, signal) => {
      this.ready = false;
      const error = new Error(`pi rpc exited: code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
    this.proc.on('error', (error) => this.emit('error', error));
    this.#attachJsonlReader(this.proc.stdout, (line) => this.#handleLine(line));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrTail.push(text);
      if (this.stderrTail.join('').length > 20_000) this.stderrTail = [this.stderrTail.join('').slice(-20_000)];
      this.emit('stderr', text);
    });
  }

  #attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    });
    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer.trim()) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    });
  }

  #handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (error) {
      this.emit('protocol_error', { line, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (msg.type === 'response' && msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.success === false) pending.reject(new Error(msg.error || `RPC ${msg.command || ''} failed`));
      else pending.resolve(msg.data ?? msg);
    }

    this.emit('event', msg);
  }

  request(command, { timeoutMs = 120_000 } = {}) {
    if (!this.proc || !this.proc.stdin.writable) return Promise.reject(new Error('pi rpc is not running'));
    const id = `web-${Date.now().toString(36)}-${++seq}`;
    const payload = { id, ...command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  send(command) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('pi rpc is not running');
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async stop() {
    if (!this.proc) return;
    try { await this.request({ type: 'abort' }, { timeoutMs: 5000 }); } catch {}
    this.proc.kill('SIGTERM');
    this.proc = null;
  }

  stderr() {
    return this.stderrTail.join('');
  }
}
