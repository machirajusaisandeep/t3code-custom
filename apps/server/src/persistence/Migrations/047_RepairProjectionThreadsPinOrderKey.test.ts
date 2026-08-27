import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_RepairProjectionThreadsPinOrderKey", (it) => {
  it.effect("repairs databases where the custom v38 migration masked pin order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN additional_folders_json TEXT NOT NULL DEFAULT '[]'
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (38, 'ProjectionProjectsAdditionalFolders')
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(columns.filter((column) => column.name === "pin_order_key").length, 1);
    }),
  );
});
