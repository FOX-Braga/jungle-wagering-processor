import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000000 extends Migration {
  override up(): void {
    this.addSql('create schema "wagering";');
  }

  override down(): void {
    this.addSql('drop schema "wagering";');
  }
}
