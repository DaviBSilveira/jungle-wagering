import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { ormConfig } from '../infrastructure/db/orm';

async function main() {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const orm = await MikroORM.init(ormConfig());
  if (direction === 'down') await orm.migrator.down();
  else await orm.migrator.up();
  await orm.close(true);
  console.log(direction === 'down' ? 'migration desfeita' : 'migration aplicada');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
