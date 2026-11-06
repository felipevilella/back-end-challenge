import { createApplication } from './bootstrap';
import { EnvironmentConfigService } from './infra/database/config/environment-config.service';

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  await app.listen(app.get(EnvironmentConfigService).port);
}

bootstrap().catch(() => {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed' }));
  process.exitCode = 1;
});
