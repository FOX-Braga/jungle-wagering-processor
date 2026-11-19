import type { MikroORM } from "@mikro-orm/postgresql";
import { barrier } from "./application-fixtures";
import { waitFor } from "./wait-for";

export async function withWalletLock<T>(
  orm: MikroORM,
  walletId: string,
  work: () => Promise<T>,
): Promise<T> {
  const locked = barrier();
  const release = barrier();
  const holder = orm.em.fork().transactional(async (em) => {
    await em.execute("select id from wagering.wallets where id = ? for update", [walletId]);
    locked.release();
    await release.reached;
  });
  try {
    await Promise.race([locked.reached, holder]);
    return await work();
  } finally {
    release.release();
    await holder;
  }
}

export async function waitForWalletWaiters(
  orm: MikroORM,
  n: number,
  instanceIds: string[],
): Promise<void> {
  const placeholders = instanceIds.map(() => "?").join(", ");
  await waitFor(
    async () => {
      const [row] = await orm.em.getConnection().execute<{ instances: number }[]>(
        `
      select count(distinct application_name)::int as instances
      from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query ilike '%for update%' and application_name in (${placeholders})
    `,
        instanceIds,
      );
      return row && row.instances >= n ? true : undefined;
    },
    `${n} APIs awaiting the wallet lock`,
    2_000,
  );
}
