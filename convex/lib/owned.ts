import type {
  DocumentByName,
  GenericDatabaseReader,
  GenericDataModel,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";

// Tables whose documents carry the owning account's `userId`.
export type OwnedTableNames<DataModel extends GenericDataModel> = {
  [T in TableNamesInDataModel<DataModel>]: DocumentByName<DataModel, T> extends {
    userId: GenericId<"users">;
  }
    ? T
    : never;
}[TableNamesInDataModel<DataModel>];

// component-backend-foundation §Ownership checks: returns null both when the
// document does not exist and when another account owns it, so callers answer
// not-found for either (req-accounts-and-connections AC-1.1).
export async function getOwned<
  DataModel extends GenericDataModel,
  TableName extends OwnedTableNames<DataModel>,
>(
  ctx: { db: GenericDatabaseReader<DataModel> },
  table: TableName,
  id: GenericId<TableName>,
  userId: GenericId<"users">,
): Promise<DocumentByName<DataModel, TableName> | null> {
  const doc = await ctx.db.get(table, id);
  return doc !== null && doc.userId === userId ? doc : null;
}
