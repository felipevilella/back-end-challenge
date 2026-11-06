import 'reflect-metadata';
import dataSource from '../src/infra/database/typeorm/typeorm.config';
async function main() {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') throw new Error('Expected up or down');
  await dataSource.initialize();
  try {
    if (direction === 'up') await dataSource.runMigrations({ transaction: 'all' });
    else await dataSource.undoLastMigration({ transaction: 'all' });
  } finally { await dataSource.destroy(); }
}
main().catch(() => { console.error('Migration failed; check database configuration and migration state'); process.exitCode = 1; });
