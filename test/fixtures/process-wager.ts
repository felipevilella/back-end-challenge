import 'reflect-metadata';
import { persistenceEntities } from '../../src/infra/entities';
import { DataSource } from 'typeorm';
import { FinancialRepository } from '../../src/infra/repositories/financial.repository';
import { ProcessWagerService } from '../../src/module/wagering/services/process-wager.service';
import type { WagerCommand } from '../../src/module/domains/wager-transaction';

async function main() {
  const database = new DataSource({
    type: 'postgres',
    url: process.env.TEST_DATABASE_URL,
    entities: persistenceEntities,
  });
  await database.initialize();
  try {
    const service = new ProcessWagerService(new FinancialRepository(database));
    const commands: WagerCommand[] = JSON.parse(process.env.COMMANDS ?? '[]');
    const result = await Promise.all(
      commands.map((command) => service.execute(command, { correlationId: 'process-test' })),
    );
    console.log(JSON.stringify(result));
  } finally {
    await database.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
