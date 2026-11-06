import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

async function main() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No port'));

        return;
      }

      server.close(() => resolve(address.port));
    });
  });
  const database = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), 'wager-pg-')),
    port,
    user: 'wager',
    password: 'test',
    persistent: false,
    autoRehydrateSymlinks: true,
    postgresFlags: ['-h', '127.0.0.1', '-k', tmpdir()],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await database.initialise();
    await database.start();
    await database.createDatabase('wager_test');
    const child = Bun.spawn([process.execPath, 'test', 'test/integration'], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://wager:test@127.0.0.1:${port}/wager_test`,
      },
    });
    process.exitCode = await child.exited;
  } finally {
    await database.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
