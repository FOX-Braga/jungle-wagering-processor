import type { MikroORM } from "@mikro-orm/postgresql";

export async function checkPostgres(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute("select 1");
}
