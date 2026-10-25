import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `automation_flows` (the flow builder's graphs, CASCADE FK to sessions like automation_rules)
 * and `automation_flow_states` (where each chat is in a flow; provenance sessionId, like chat_states).
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres (and optional on
 * SQLite). The SQLite DDL is what TypeORM synchronize generates from the entities, FK name included,
 * so the migration-drift gate sees no difference.
 */
export class AddAutomationFlows1791500000000 implements MigrationInterface {
  name = 'AddAutomationFlows1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (!(await queryRunner.hasTable('automation_flows'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "automation_flows" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
            `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "enabled" boolean NOT NULL DEFAULT true, ` +
            `"definition" text NOT NULL, "timeoutMinutes" integer NOT NULL DEFAULT 60, ` +
            `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
            `CONSTRAINT "FK_29b5a4dd7b3ea20809f723ff231" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "automation_flows" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
            `"name" varchar(100) NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "definition" text NOT NULL, ` +
            `"timeoutMinutes" integer NOT NULL DEFAULT (60), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `CONSTRAINT "FK_29b5a4dd7b3ea20809f723ff231" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      }
      await queryRunner.query(`CREATE INDEX "IDX_automation_flows_sessionId" ON "automation_flows" ("sessionId") `);
    }

    if (!(await queryRunner.hasTable('automation_flow_states'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "automation_flow_states" ("sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, ` +
            `"flowId" varchar, "nodeId" varchar, "variables" text, "invalidCount" integer NOT NULL DEFAULT 0, ` +
            `"lastInvalidAt" bigint, "lastMessageAt" bigint, "startedAt" bigint, "handoffUntil" bigint, ` +
            `"updatedAt" TIMESTAMP NOT NULL DEFAULT now(), PRIMARY KEY ("sessionId", "chatId"))`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "automation_flow_states" ("sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, ` +
            `"flowId" varchar, "nodeId" varchar, "variables" text, "invalidCount" integer NOT NULL DEFAULT (0), ` +
            `"lastInvalidAt" bigint, "lastMessageAt" bigint, "startedAt" bigint, "handoffUntil" bigint, ` +
            `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), PRIMARY KEY ("sessionId", "chatId"))`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_flow_states"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automation_flows_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_flows"`);
  }
}
