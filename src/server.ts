import * as http from 'http';
import { decode } from '@msgpack/msgpack';

export interface PathData {
    path_lengths: number[];
    coords: Uint8Array;
    travel_path_lengths?: number[];
    travel_coords?: Uint8Array;
}

export type DataCallback = (data: PathData) => void;

/** Node attaches this to listen()/connect() failures. */
function errorCode(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException | undefined)?.code;
}

export class PreviewServer {
    private server: http.Server;
    private port: number;

    /**
     * `onRelease` fires when another VS Code window claims the port. Every
     * window activates this extension and races for the same port, so the
     * holder has to be able to hand it over — otherwise previews triggered in
     * one window are rendered by whichever window happened to boot first.
     */
    constructor(port: number, onData: DataCallback, onRelease: () => void) {
        this.port = port;
        this.server = http.createServer((req, res) => {
            // CORS headers so that future tooling can also call from browser contexts
            res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');

            if (req.method === 'POST' && req.url === '/preview') {
                const chunks: Buffer[] = [];
                req.on('data', (chunk: Buffer) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const buffer = Buffer.concat(chunks);
                        const decoded = decode(buffer) as PathData;
                        onData(decoded);
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        res.end('OK');
                    } catch (e) {
                        console.error('[gcoordinator] Failed to decode MessagePack data:', e);
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Bad Request');
                    }
                });
            } else if (req.method === 'POST' && req.url === '/release') {
                req.resume(); // drain, there is no body to read
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                // Answer before closing down, so the claimant knows the handover
                // was accepted rather than seeing the socket drop.
                res.end('OK', () => onRelease());
            } else {
                res.writeHead(404);
                res.end();
            }
        });
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onError = (err: Error) => {
                this.server.removeListener('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                this.server.removeListener('error', onError);
                resolve();
            };
            // once(), not on(): start() is retried during a takeover and stale
            // listeners would settle a later attempt with an earlier error.
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(this.port, '127.0.0.1');
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server.listening) { resolve(); return; }
            this.server.close(() => resolve());
            // close() alone waits for keep-alive sockets to go idle on their
            // own, which would stall the handover past the claimant's retries.
            // Absent before Node 18.2, hence the optional call.
            this.server.closeIdleConnections?.();
        });
    }
}

/**
 * Ask whoever owns `port` to give it up. Resolves true only when another
 * gcoordinator window answered — a foreign process on the port replies 404 or
 * nothing at all, and must not be treated as a handover.
 */
export function requestRelease(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.request(
            {
                host: '127.0.0.1', port, path: '/release', method: 'POST', timeout: 500,
                // The default global agent pools keep-alive sockets, which would
                // hold the old owner's listener open past our retry window.
                agent: false,
                headers: { Connection: 'close' },
            },
            (res) => {
                res.resume(); // drain so the socket can close
                res.on('end', () => resolve(res.statusCode === 200));
            },
        );
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

const TAKEOVER_RETRIES = 5;
const TAKEOVER_RETRY_DELAY_MS = 100;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bind `port`, taking it from another gcoordinator window if necessary. The
 * retry loop covers the gap between the previous owner answering /release and
 * its listening socket actually being closed.
 */
export async function startWithTakeover(server: PreviewServer, port: number): Promise<void> {
    try {
        await server.start();
        return;
    } catch (err) {
        if (errorCode(err) !== 'EADDRINUSE') { throw err; }
    }

    if (!await requestRelease(port)) {
        throw new Error(`Port ${port} is held by another process.`);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < TAKEOVER_RETRIES; attempt++) {
        await delay(TAKEOVER_RETRY_DELAY_MS);
        try {
            await server.start();
            return;
        } catch (err) {
            lastErr = err;
            if (errorCode(err) !== 'EADDRINUSE') { throw err; }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Could not bind port ${port}.`);
}
