import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db = admin.firestore();

export const recordRouteFeedback = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { companyId, routeId, originalRoute, modifiedRoute, modifiedBy } = req.body;

  if (!companyId || !routeId || !originalRoute || !modifiedRoute) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    // Calculate delta
    const origSeq: string[] = originalRoute.stopSequence || [];
    const modSeq: string[] = modifiedRoute.stopSequence || [];

    const moved: Array<{ jobId: string; fromIndex: number; toIndex: number }> = [];
    const added: string[] = modSeq.filter((id: string) => !origSeq.includes(id));
    const removed: string[] = origSeq.filter((id: string) => !modSeq.includes(id));

    for (const jobId of origSeq) {
      const origIdx = origSeq.indexOf(jobId);
      const newIdx = modSeq.indexOf(jobId);
      if (newIdx !== -1 && origIdx !== newIdx) {
        moved.push({ jobId, fromIndex: origIdx, toIndex: newIdx });
      }
    }

    const historyRef = db.collection(`companies/${companyId}/routeHistory`).doc();
    await historyRef.set({
      originalRoute,
      modifiedRoute,
      modifiedBy: modifiedBy || "unknown",
      modifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      deltaStops: { moved, added, removed },
      feedbackProcessed: false,
      routeId,
    });

    // Update the route in Firestore
    await db.doc(`companies/${companyId}/routes/${routeId}`).update({
      stopSequence: modSeq,
      generatedBy: "human",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, historyId: historyRef.id });
  } catch (error) {
    console.error("Feedback recording error:", error);
    res.status(500).json({ error: "Failed to record feedback", details: String(error) });
  }
});
