import { createServer, type Server, type Socket, connect } from 'node:net';

/**
 * Isolates outages from shared Redis; assumes plain Redis without authentication on DB 0.
 */
export class RedisProxy {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Map<Socket, Socket | undefined>();
  private frozen = false;

  private constructor(
    readonly port: number,
    private readonly target: { host: string; port: number },
  ) {}

  /** Picks a free port and releases it, so another process could take it before `start()`. */
  static async reserve(targetUrl: string): Promise<RedisProxy> {
    const { hostname, port } = new URL(targetUrl);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    if (!address || typeof address === 'string') throw new Error('no port');
    return new RedisProxy(address.port, { host: hostname, port: Number(port || 6379) });
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((client) => {
      this.clients.set(client, undefined);
      client.on('close', () => this.clients.delete(client));
      if (this.frozen) {
        this.sockets.add(client);
        client.on('close', () => this.sockets.delete(client));
        client.on('error', () => client.destroy());
        client.resume(); // drain without answering, so the app's FIN is seen
        return;
      }
      const upstream = connect(this.target);
      this.clients.set(client, upstream);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
  }

  freeze(): void {
    this.frozen = true;
    for (const [client, upstream] of this.clients) {
      if (!upstream) continue;
      client.unpipe(upstream);
      upstream.unpipe(client);
      // Drain without forwarding, so the app's FIN is seen and the socket counted as closed.
      client.resume();
      upstream.resume();
    }
  }

  get openClients(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.frozen = false;
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await closed;
  }
}
