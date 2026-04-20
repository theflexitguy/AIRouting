export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL = process.env.BACKEND_URL || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId, routeId, originalRoute, modifiedRoute, modifiedBy } = body;

    if (!companyId || !routeId || !originalRoute || !modifiedRoute) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const db = adminDb();
    const now = new Date().toISOString();

    // Compute delta: which stops moved, were added, or removed
    const oldSeq: string[] = originalRoute.stopSequence || [];
    const newSeq: string[] = modifiedRoute.stopSequence || [];

    const moved: Array<{ jobId: string; fromIndex: number; toIndex: number }> = [];
    const added: string[] = [];
    const removed: string[] = [];

    const oldSet = new Set(oldSeq);
    const newSet = new Set(newSeq);

    // Find removed stops
    for (const id of oldSeq) {
      if (!newSet.has(id)) removed.push(id);
    }
    // Find added stops
    for (const id of newSeq) {
      if (!oldSet.has(id)) added.push(id);
    }
    // Find moved stops (same stop, different position)
    for (const id of newSeq) {
      if (oldSet.has(id)) {
        const fromIndex = oldSeq.indexOf(id);
        const toIndex = newSeq.indexOf(id);
        if (fromIndex !== toIndex) {
          moved.push({ jobId: id, fromIndex, toIndex });
        }
      }
    }

    // Write to routeHistory collection
    await db.collection(`companies/${companyId}/routeHistory`).add({
      companyId,
      routeId,
      originalRoute,
      modifiedRoute,
      modifiedBy: modifiedBy || "unknown",
      modifiedAt: now,
      deltaStops: { moved, added, removed },
      feedbackProcessed: false,
    });

    // Update the actual route document with the new stop sequence
    const routeRef = db.doc(`companies/${companyId}/routes/${routeId}`);
    await routeRef.update({
      stopSequence: newSeq,
      generatedBy: "human",
      updatedAt: now,
    });

    // Check if we should auto-retrain (every 10 unprocessed feedback records)
    if (BACKEND_URL) {
      try {
        const unprocessedSnap = await db
          .collection(`companies/${companyId}/routeHistory`)
          .where("feedbackProcessed", "==", false)
          .count()
          .get();
        const count = unprocessedSnap.data().count;

        if (count >= 10) {
          // Fire-and-forget training call
          fetch(`${BACKEND_URL}/routeiq/train`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companyId }),
          }).catch(() => {}); // Don't block on training

          // Mark records as processed
          const toProcess = await db
            .collection(`companies/${companyId}/routeHistory`)
            .where("feedbackProcessed", "==", false)
            .limit(50)
            .get();
          const batch = db.batch();
          toProcess.docs.forEach((doc) => {
            batch.update(doc.ref, { feedbackProcessed: true });
          });
          await batch.commit();
        }
      } catch {
        // Training trigger is best-effort
      }
    }

    return NextResponse.json({
      success: true,
      delta: { moved: moved.length, added: added.length, removed: removed.length },
    });
  } catch (error) {
    console.error("Record feedback API error:", error);
    return NextResponse.json({ error: "Failed to record feedback" }, { status: 500 });
  }
}
