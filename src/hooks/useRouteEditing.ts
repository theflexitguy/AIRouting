"use client";

import { useRef, useState, useCallback } from "react";
import { DragStartEvent, DragOverEvent, DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { doc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Job, Route } from "@/types";
import { toast } from "sonner";

interface TechRoute {
  route: Route;
  tech: { id: string; name: string };
  jobs: Job[];
  color: string;
  expanded: boolean;
}

interface UseRouteEditingOptions {
  allRoutes: TechRoute[];
  setAllRoutes: (routes: TechRoute[]) => void;
  allJobs: Record<string, Job>;
  companyId: string | undefined;
  userEmail: string | undefined;
}

export function useRouteEditing({
  allRoutes,
  setAllRoutes,
  allJobs,
  companyId,
  userEmail,
}: UseRouteEditingOptions) {
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [activeSourceRouteId, setActiveSourceRouteId] = useState<string | null>(null);
  const preEditSnapshot = useRef<TechRoute[] | null>(null);
  const editTimestamp = useRef<number>(0);

  /** Suppress onSnapshot updates briefly after local edits */
  const shouldSuppressSnapshot = useCallback(() => {
    return Date.now() - editTimestamp.current < 2000;
  }, []);

  const findRouteByStopId = useCallback((stopId: string): TechRoute | undefined => {
    return allRoutes.find(tr => tr.route.stopSequence.includes(stopId));
  }, [allRoutes]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const stopId = String(event.active.id);
    setActiveStopId(stopId);
    const sourceRoute = findRouteByStopId(stopId);
    setActiveSourceRouteId(sourceRoute?.route.id ?? null);
    // Snapshot for cancel/revert
    preEditSnapshot.current = allRoutes.map(tr => ({
      ...tr,
      route: { ...tr.route, stopSequence: [...tr.route.stopSequence] },
    }));
  }, [allRoutes, findRouteByStopId]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Find which routes contain active and over items
    const sourceRoute = findRouteByStopId(activeId);
    if (!sourceRoute) return;

    // The over target could be a stop in another route, or a route container
    let targetRoute: TechRoute | undefined;
    targetRoute = findRouteByStopId(overId);

    // If over target is a route ID (droppable container), find that route
    if (!targetRoute) {
      targetRoute = allRoutes.find(tr => tr.route.id === overId);
    }
    if (!targetRoute || sourceRoute.route.id === targetRoute.route.id) return;

    // Move the stop from source to target (optimistic)
    const sourceSeq = [...sourceRoute.route.stopSequence];
    const targetSeq = [...targetRoute.route.stopSequence];

    const activeIdx = sourceSeq.indexOf(activeId);
    if (activeIdx === -1) return;

    // Remove from source
    sourceSeq.splice(activeIdx, 1);

    // Insert into target at the position of the over item
    const overIdx = targetSeq.indexOf(overId);
    if (overIdx >= 0) {
      targetSeq.splice(overIdx, 0, activeId);
    } else {
      targetSeq.push(activeId);
    }

    const updated = allRoutes.map(tr => {
      if (tr.route.id === sourceRoute.route.id) {
        return { ...tr, route: { ...tr.route, stopSequence: sourceSeq, totalStops: sourceSeq.length } };
      }
      if (tr.route.id === targetRoute!.route.id) {
        return { ...tr, route: { ...tr.route, stopSequence: targetSeq, totalStops: targetSeq.length } };
      }
      return tr;
    });

    setAllRoutes(updated);
  }, [allRoutes, setAllRoutes, findRouteByStopId]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveStopId(null);
    setActiveSourceRouteId(null);

    if (!over || !companyId) {
      // Cancelled or invalid — revert
      if (preEditSnapshot.current) {
        setAllRoutes(preEditSnapshot.current);
      }
      preEditSnapshot.current = null;
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);

    // Find the current route of the active item (after handleDragOver may have moved it)
    const currentRoute = findRouteByStopId(activeId);
    if (!currentRoute) {
      if (preEditSnapshot.current) setAllRoutes(preEditSnapshot.current);
      preEditSnapshot.current = null;
      return;
    }

    // Check if this was a same-route reorder
    const originalRoute = preEditSnapshot.current?.find(tr =>
      tr.route.stopSequence.includes(activeId)
    );

    if (originalRoute && originalRoute.route.id === currentRoute.route.id) {
      // Same route — just reorder
      const oldSeq = currentRoute.route.stopSequence;
      const oldIdx = oldSeq.indexOf(activeId);
      const newIdx = oldSeq.indexOf(overId);
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        const newSeq = arrayMove(oldSeq, oldIdx, newIdx);
        const updated = allRoutes.map(tr =>
          tr.route.id === currentRoute.route.id
            ? { ...tr, route: { ...tr.route, stopSequence: newSeq, generatedBy: "human" as const } }
            : tr
        );
        setAllRoutes(updated);
        editTimestamp.current = Date.now();

        // Record feedback
        try {
          await fetch("/api/record-feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyId,
              routeId: currentRoute.route.id,
              originalRoute: originalRoute.route,
              modifiedRoute: { ...currentRoute.route, stopSequence: newSeq },
              modifiedBy: userEmail,
            }),
          });
        } catch { /* fire and forget */ }
      }
    } else if (originalRoute && originalRoute.route.id !== currentRoute.route.id) {
      // Cross-route move — persist to Firestore
      editTimestamp.current = Date.now();
      const sourceRouteId = originalRoute.route.id;
      const targetRouteId = currentRoute.route.id;

      try {
        const batch = writeBatch(db);

        // Update source route
        const sourceRouteNow = allRoutes.find(tr => tr.route.id === sourceRouteId);
        if (sourceRouteNow) {
          batch.update(doc(db, `companies/${companyId}/routes`, sourceRouteId), {
            stopSequence: sourceRouteNow.route.stopSequence,
            totalStops: sourceRouteNow.route.stopSequence.length,
            generatedBy: "human",
            updatedAt: new Date().toISOString(),
          });
        }

        // Update target route
        batch.update(doc(db, `companies/${companyId}/routes`, targetRouteId), {
          stopSequence: currentRoute.route.stopSequence,
          totalStops: currentRoute.route.stopSequence.length,
          generatedBy: "human",
          updatedAt: new Date().toISOString(),
        });

        // Update the job's assigned tech
        const targetTechId = currentRoute.tech.id;
        batch.update(doc(db, `companies/${companyId}/jobs`, activeId), {
          assignedTechId: targetTechId,
          updatedAt: new Date().toISOString(),
        });

        await batch.commit();

        const job = allJobs[activeId];
        toast.success(`Moved ${job?.customerName || "stop"} to ${currentRoute.tech.name}`);

        // Record feedback for both routes
        fetch("/api/record-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId,
            routeId: sourceRouteId,
            originalRoute: originalRoute.route,
            modifiedRoute: sourceRouteNow?.route,
            modifiedBy: userEmail,
          }),
        }).catch(() => {});

        fetch("/api/record-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId,
            routeId: targetRouteId,
            originalRoute: preEditSnapshot.current?.find(tr => tr.route.id === targetRouteId)?.route,
            modifiedRoute: currentRoute.route,
            modifiedBy: userEmail,
          }),
        }).catch(() => {});

      } catch (e) {
        console.error("Cross-route move error:", e);
        toast.error("Failed to move stop");
        if (preEditSnapshot.current) setAllRoutes(preEditSnapshot.current);
      }
    }

    preEditSnapshot.current = null;
  }, [allRoutes, setAllRoutes, allJobs, companyId, userEmail, findRouteByStopId]);

  const handleDragCancel = useCallback(() => {
    setActiveStopId(null);
    setActiveSourceRouteId(null);
    if (preEditSnapshot.current) {
      setAllRoutes(preEditSnapshot.current);
      preEditSnapshot.current = null;
    }
  }, [setAllRoutes]);

  return {
    activeStopId,
    activeSourceRouteId,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    shouldSuppressSnapshot,
  };
}
