import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get("companyId");
  const routeId = searchParams.get("routeId");
  const format = searchParams.get("format") || "html";

  if (!companyId || !routeId) {
    return NextResponse.json({ error: "companyId and routeId required" }, { status: 400 });
  }

  try {
    const db = adminDb();
    const routeDoc = await db.doc(`companies/${companyId}/routes/${routeId}`).get();
    if (!routeDoc.exists) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    const route = { id: routeDoc.id, ...routeDoc.data() };
    const stopSequence: string[] = (route as Record<string, unknown>).stopSequence as string[] || [];

    // Fetch jobs for this route
    const jobs: Array<Record<string, unknown>> = [];
    for (const jobId of stopSequence) {
      const jobDoc = await db.doc(`companies/${companyId}/jobs/${jobId}`).get();
      if (jobDoc.exists) {
        jobs.push({ id: jobDoc.id, ...jobDoc.data() });
      }
    }

    // Fetch technician
    const techId = (route as Record<string, unknown>).techId as string;
    let techName = techId;
    if (techId) {
      const techDoc = await db.doc(`companies/${companyId}/technicians/${techId}`).get();
      if (techDoc.exists) {
        techName = (techDoc.data() as Record<string, unknown>).name as string || techId;
      }
    }

    const routeData = route as Record<string, unknown>;

    if (format === "json") {
      return NextResponse.json({ route: routeData, jobs, techName });
    }

    // Generate printable HTML
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Route - ${techName} - ${routeData.date}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; padding: 32px; max-width: 800px; margin: 0 auto; }
    .header { border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; font-weight: 700; color: #2563eb; }
    .header .meta { display: flex; gap: 24px; margin-top: 8px; color: #6b7280; font-size: 14px; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat { background: #f9fafb; border-radius: 8px; padding: 12px; }
    .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; }
    .stat .value { font-size: 20px; font-weight: 700; color: #1a1a1a; margin-top: 2px; }
    .stops { margin-top: 8px; }
    .stop { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
    .stop:last-child { border-bottom: none; }
    .stop-num { width: 28px; height: 28px; border-radius: 50%; background: #2563eb; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
    .stop-details { flex: 1; }
    .stop-name { font-weight: 600; font-size: 14px; }
    .stop-address { color: #6b7280; font-size: 13px; margin-top: 2px; }
    .stop-meta { color: #9ca3af; font-size: 12px; margin-top: 4px; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 11px; text-align: center; }
    @media print { body { padding: 16px; } .stat { border: 1px solid #e5e7eb; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>RouteIQ</h1>
    <div class="meta">
      <span><strong>Technician:</strong> ${techName}</span>
      <span><strong>Date:</strong> ${routeData.date}</span>
      <span><strong>Status:</strong> ${routeData.approved ? "Approved" : "Pending"}</span>
    </div>
  </div>
  <div class="stats">
    <div class="stat">
      <div class="label">Total Stops</div>
      <div class="value">${routeData.totalStops || jobs.length}</div>
    </div>
    <div class="stat">
      <div class="label">Drive Time</div>
      <div class="value">${Math.round((routeData.totalDriveTimeMinutes as number) / 60)}h ${(routeData.totalDriveTimeMinutes as number) % 60}m</div>
    </div>
    <div class="stat">
      <div class="label">Confidence</div>
      <div class="value">${Math.round((routeData.confidence as number || 0) * 100)}%</div>
    </div>
  </div>
  <div class="stops">
    <h2 style="font-size:16px; font-weight:600; margin-bottom:8px;">Stop Sequence</h2>
    ${jobs.map((job, i) => `
    <div class="stop">
      <div class="stop-num">${i + 1}</div>
      <div class="stop-details">
        <div class="stop-name">${job.customerName || "Unknown"}</div>
        <div class="stop-address">${job.address || "No address"}</div>
        <div class="stop-meta">${job.serviceType || ""} ${job.duration ? `· ${job.duration} min` : ""}</div>
      </div>
    </div>`).join("")}
  </div>
  <div class="footer">Generated by RouteIQ · ${new Date().toLocaleDateString()}</div>
</body>
</html>`;

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html",
        "Content-Disposition": `inline; filename="route-${techName}-${routeData.date}.html"`,
      },
    });
  } catch (error) {
    console.error("Export route error:", error);
    return NextResponse.json({ error: "Failed to export route" }, { status: 500 });
  }
}
