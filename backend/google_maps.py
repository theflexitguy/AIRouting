"""
Google Maps API Client
======================
Handles all Google Maps platform calls for RouteIQ:

  - Geocoding API        → address → (lat, lng)
  - Roads API            → snap coordinates to nearest road
  - Routes API           → accurate drive time + distance per leg (with traffic)
  - Distance Matrix API  → batch drive time estimates (fallback)

All functions are safe to call without an API key — they return None/empty
gracefully so the routing engine falls back to OSRM/haversine.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

import requests

LOGGER = logging.getLogger("google_maps")

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")

# ── Geocoding ──────────────────────────────────────────────────────────────────

def geocode_address(address: str, api_key: str = "") -> Optional[tuple[float, float]]:
    """
    Convert a street address to (lat, lng).
    Returns None if geocoding fails or key is missing.
    """
    key = api_key or GOOGLE_MAPS_API_KEY
    if not key or not address:
        return None

    url = "https://maps.googleapis.com/maps/api/geocode/json"
    try:
        resp = requests.get(
            url,
            params={"address": address, "key": key},
            timeout=10,
        )
        data = resp.json()
        if data.get("status") == "OK":
            loc = data["results"][0]["geometry"]["location"]
            return float(loc["lat"]), float(loc["lng"])
        LOGGER.warning("Geocoding failed for %r: %s", address, data.get("status"))
    except Exception as exc:
        LOGGER.warning("Geocoding error for %r: %s", address, exc)
    return None


def geocode_batch(
    jobs: list[dict],
    api_key: str = "",
    lat_key: str = "lat",
    lng_key: str = "lng",
    address_key: str = "address",
) -> list[dict]:
    """
    Geocode all jobs that are missing lat/lng in place.
    Returns the same list with lat/lng filled in where possible.
    Adds 'geocoded': True flag to any job that was geocoded.
    """
    key = api_key or GOOGLE_MAPS_API_KEY
    if not key:
        return jobs

    missing = [j for j in jobs if not j.get(lat_key) or not j.get(lng_key)]
    if not missing:
        return jobs

    LOGGER.info("Geocoding %d jobs missing coordinates...", len(missing))
    success = 0

    for job in missing:
        address = str(job.get(address_key) or "").strip()
        if not address:
            LOGGER.warning("Job %s has no address to geocode", job.get("id", "?"))
            continue

        result = geocode_address(address, key)
        if result:
            job[lat_key] = result[0]
            job[lng_key] = result[1]
            job["geocoded"] = True
            success += 1
        else:
            LOGGER.warning("Could not geocode job %s: %r", job.get("id", "?"), address)

        # Respect Google's rate limit (50 req/s max, stay conservative)
        time.sleep(0.02)

    LOGGER.info("Geocoded %d/%d jobs successfully", success, len(missing))
    return jobs


# ── Roads API ─────────────────────────────────────────────────────────────────

def snap_to_roads(
    points: list[tuple[float, float]],
    api_key: str = "",
    interpolate: bool = False,
) -> list[tuple[float, float]]:
    """
    Snap a list of (lat, lng) points to the nearest road.
    Returns the original list unchanged if the API call fails.

    Note: Roads API accepts max 100 points per request.
    """
    key = api_key or GOOGLE_MAPS_API_KEY
    if not key or not points:
        return points

    url = "https://roads.googleapis.com/v1/snapToRoads"
    snapped = list(points)

    # Process in chunks of 100
    for i in range(0, len(points), 100):
        chunk = points[i : i + 100]
        path_str = "|".join(f"{lat},{lng}" for lat, lng in chunk)
        try:
            resp = requests.get(
                url,
                params={
                    "path": path_str,
                    "interpolate": str(interpolate).lower(),
                    "key": key,
                },
                timeout=15,
            )
            data = resp.json()
            for sp in data.get("snappedPoints", []):
                orig_idx = sp.get("originalIndex")
                if orig_idx is not None:
                    loc = sp["location"]
                    snapped[i + orig_idx] = (loc["latitude"], loc["longitude"])
        except Exception as exc:
            LOGGER.warning("Roads snap failed for chunk %d: %s", i, exc)

    return snapped


# ── Routes API ────────────────────────────────────────────────────────────────

def compute_route(
    origin: tuple[float, float],
    destination: tuple[float, float],
    waypoints: list[tuple[float, float]] | None = None,
    api_key: str = "",
    departure_time: str = "now",
) -> dict | None:
    """
    Compute a single route with traffic-aware drive time using the Routes API.

    Returns a dict with:
      - duration_seconds: int
      - distance_meters: int
      - legs: list of per-leg duration/distance
    Returns None on failure.
    """
    key = api_key or GOOGLE_MAPS_API_KEY
    if not key:
        return None

    url = "https://routes.googleapis.com/directions/v2:computeRoutes"

    def _latlong(pt: tuple[float, float]) -> dict:
        return {"location": {"latLng": {"latitude": pt[0], "longitude": pt[1]}}}

    body: dict = {
        "origin": _latlong(origin),
        "destination": _latlong(destination),
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "computeAlternativeRoutes": False,
        "routeModifiers": {"avoidTolls": False},
    }

    if waypoints:
        body["intermediates"] = [_latlong(wp) for wp in waypoints]

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.legs",
    }

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=15)
        data = resp.json()
        routes = data.get("routes", [])
        if not routes:
            LOGGER.warning("Routes API returned no routes: %s", data.get("error", ""))
            return None

        route = routes[0]
        legs = route.get("legs", [])

        return {
            "duration_seconds": _parse_duration(route.get("duration", "0s")),
            "distance_meters": int(route.get("distanceMeters", 0)),
            "legs": [
                {
                    "duration_seconds": _parse_duration(leg.get("duration", "0s")),
                    "distance_meters": int(leg.get("distanceMeters", 0)),
                }
                for leg in legs
            ],
        }
    except Exception as exc:
        LOGGER.warning("Routes API error: %s", exc)
        return None


def compute_route_legs_for_stops(
    stops: list[tuple[float, float]],
    api_key: str = "",
) -> list[dict]:
    """
    Given an ordered list of (lat, lng) stop coordinates, compute the drive
    time and distance for each consecutive leg using the Routes API.

    Returns a list of dicts: [{duration_seconds, distance_meters}, ...]
    Length = len(stops) - 1.
    Falls back to empty list on failure.
    """
    key = api_key or GOOGLE_MAPS_API_KEY
    if not key or len(stops) < 2:
        return []

    # Routes API accepts up to 25 waypoints per request (origin + 23 intermediates + destination)
    results = []
    chunk_size = 25

    for i in range(0, len(stops) - 1, chunk_size - 1):
        chunk = stops[i : i + chunk_size]
        if len(chunk) < 2:
            break

        origin = chunk[0]
        destination = chunk[-1]
        intermediates = chunk[1:-1] if len(chunk) > 2 else None

        route = compute_route(origin, destination, intermediates, key)
        if route and route.get("legs"):
            results.extend(route["legs"])
        else:
            # Fallback: add empty legs so indices stay aligned
            results.extend([{"duration_seconds": None, "distance_meters": None}] * (len(chunk) - 1))

    return results


# ── Distance Matrix API ───────────────────────────────────────────────────────

def distance_matrix(
    origins: list[tuple[float, float]],
    destinations: list[tuple[float, float]],
    api_key: str = "",
    mode: str = "driving",
    departure_time: str = "now",
) -> list[list[dict]] | None:
    """
    Compute a drive time/distance matrix using the Distance Matrix API.
    Returns a 2D list of {duration_seconds, distance_meters} or None on failure.

    Note: max 25 origins × 25 destinations per request.
    """
    key = api_key or GOOGLE_MAPS_API_KEY
    if not key or not origins or not destinations:
        return None

    url = "https://maps.googleapis.com/maps/api/distancematrix/json"

    def _fmt(pts: list[tuple[float, float]]) -> str:
        return "|".join(f"{lat},{lng}" for lat, lng in pts)

    try:
        resp = requests.get(
            url,
            params={
                "origins": _fmt(origins),
                "destinations": _fmt(destinations),
                "mode": mode,
                "departure_time": departure_time,
                "key": key,
            },
            timeout=15,
        )
        data = resp.json()
        if data.get("status") != "OK":
            LOGGER.warning("Distance Matrix API error: %s", data.get("status"))
            return None

        matrix = []
        for row in data.get("rows", []):
            row_data = []
            for elem in row.get("elements", []):
                if elem.get("status") == "OK":
                    row_data.append({
                        "duration_seconds": elem["duration"]["value"],
                        "distance_meters": elem["distance"]["value"],
                    })
                else:
                    row_data.append({"duration_seconds": None, "distance_meters": None})
            matrix.append(row_data)
        return matrix
    except Exception as exc:
        LOGGER.warning("Distance Matrix API error: %s", exc)
        return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_duration(duration_str: str) -> int:
    """Parse Google's duration string like '1234s' → 1234."""
    try:
        return int(str(duration_str).rstrip("s"))
    except (ValueError, TypeError):
        return 0
