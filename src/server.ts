import * as http from 'http';
import { decode } from '@msgpack/msgpack';

export interface PathData {
    path_lengths: number[];
    coords: Uint8Array;
}

export type DataCallback = (data: PathData) => void;

export class PreviewServer {
    private server: http.Server;
    private port: number;

    constructor(port: number, onData: DataCallback) {
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
            } else {
                res.writeHead(404);
                res.end();
            }
        });
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.on('error', reject);
            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`[gcoordinator] Preview server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    stop(): void {
        this.server.close();
    }
}
