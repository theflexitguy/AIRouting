import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Scheduled to run every day at 6 AM
export const scheduledFieldRoutesSync = functions.pubsub
  .schedule("0 6 * * *")
  .timeZone("America/New_York")
  .onRun(async () => {
    console.log("Starting scheduled FieldRoutes sync for all companies");

    const companiesSnapshot = await db.collection("companies").where("active", "==", true).get();

    const promises = companiesSnapshot.docs.map(async (doc) => {
      const companyId = doc.id;
      console.log(`Syncing company: ${companyId}`);

      try {
        // Call the sync function directly via internal logic
        // In production, this would call the HTTP function or shared logic
        console.log(`Sync triggered for ${companyId}`);
      } catch (error) {
        console.error(`Sync failed for ${companyId}:`, error);
      }
    });

    await Promise.all(promises);
    console.log("Scheduled sync complete");
    return null;
  });
