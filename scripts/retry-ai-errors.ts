import { MongoClient } from "mongodb";

const [importId] = process.argv.slice(2);
if (!importId) throw new Error("Use: bun run scripts/retry-ai-errors.ts <importId>");

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB ?? "camping";
const client = new MongoClient(uri);
await client.connect();

try {
  const db = client.db(dbName);
  for (const collection of ["participants"]) {
    const before = await db.collection(collection).countDocuments({ importId, aiReviewStatus: "error" });
    const res = await db.collection(collection).updateMany(
      { importId, aiReviewStatus: "error" },
      { $set: { aiReviewStatus: "pending", aiReviewError: "", aiReviewStartedAt: null, aiReviewAttempts: 0, aiReviewNextRetryAt: null, updatedAt: new Date() } },
    );
    console.log(`${collection}: ${before} in error, ${res.modifiedCount} reset to pending`);
  }
} finally {
  await client.close();
}
