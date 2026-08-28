import { asArray, compact, productCopy, toneColor } from "./format";

export function zoneClass(zone) {
  return compact(
    zone?.class || zone?.zoneClass || zone?.risk || "C",
  ).toUpperCase();
}

export function zoneName(zone, index) {
  return compact(
    zone?.label || zone?.zoneKey || zone?.id || `zone-${index + 1}`,
  );
}

export function displayZoneName(zone, index) {
  return productCopy(zoneName(zone, index), `Scope ${index + 1}`);
}

export function zonePaths(zone) {
  return asArray(zone?.paths || zone?.route || zone?.allowedPaths);
}

export function pathPatternSegments(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

export function remainingPatternCanBeEmpty(segments, start) {
  return segments.slice(start).every((segment) => segment === "**");
}

export function globSegmentRegex(segment) {
  const escaped = String(segment).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
}

export function pathSegmentsMayOverlap(left, right) {
  if (left === right) return true;
  const leftGlob = /[*?]/.test(left);
  const rightGlob = /[*?]/.test(right);
  if (leftGlob && !rightGlob) return globSegmentRegex(left).test(right);
  if (rightGlob && !leftGlob) return globSegmentRegex(right).test(left);
  return leftGlob && rightGlob;
}

export function pathPatternsMayOverlap(
  leftSegments,
  rightSegments,
  leftIndex = 0,
  rightIndex = 0,
  seen = new Set(),
) {
  const key = `${leftIndex}:${rightIndex}`;
  if (seen.has(key)) return false;
  seen.add(key);

  if (leftIndex >= leftSegments.length && rightIndex >= rightSegments.length)
    return true;
  if (leftIndex >= leftSegments.length)
    return remainingPatternCanBeEmpty(rightSegments, rightIndex);
  if (rightIndex >= rightSegments.length)
    return remainingPatternCanBeEmpty(leftSegments, leftIndex);

  const left = leftSegments[leftIndex];
  const right = rightSegments[rightIndex];
  if (left === "**") {
    return (
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex + 1,
        rightIndex,
        new Set(seen),
      ) ||
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex,
        rightIndex + 1,
        new Set(seen),
      )
    );
  }
  if (right === "**") {
    return (
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex,
        rightIndex + 1,
        new Set(seen),
      ) ||
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex + 1,
        rightIndex,
        new Set(seen),
      )
    );
  }
  return (
    pathSegmentsMayOverlap(left, right) &&
    pathPatternsMayOverlap(
      leftSegments,
      rightSegments,
      leftIndex + 1,
      rightIndex + 1,
      new Set(seen),
    )
  );
}

export function pathsLikelyOverlap(left, right) {
  const leftSegments = pathPatternSegments(left);
  const rightSegments = pathPatternSegments(right);
  if (!leftSegments.length || !rightSegments.length) return false;
  return pathPatternsMayOverlap(leftSegments, rightSegments);
}

export function normalizedZoneToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function zoneHasFlight(zone, flight) {
  const paths = zonePaths(zone);
  const route = asArray(flight?.route);
  return (
    paths.length > 0 &&
    route.some((path) =>
      paths.some((zonePath) => pathsLikelyOverlap(path, zonePath)),
    )
  );
}

export function riskTouchesZone(risk, zone) {
  const riskPaths = [
    risk?.conflictZone,
    risk?.path,
    risk?.zoneKey,
    ...asArray(risk?.affectedZones),
  ].filter(Boolean);
  const paths = zonePaths(zone);
  const zoneTokens = new Set(
    [zone?.zoneKey, zone?.key, zone?.id, zoneName(zone, 0)]
      .map(normalizedZoneToken)
      .filter(Boolean),
  );
  return (
    riskPaths.some((riskPath) =>
      paths.some((zonePath) => pathsLikelyOverlap(riskPath, zonePath)),
    ) ||
    riskPaths.some((riskPath) => zoneTokens.has(normalizedZoneToken(riskPath)))
  );
}

export function riskTouchesFlight(risk, flight) {
  const riskPaths = [
    risk?.conflictZone,
    risk?.path,
    risk?.zoneKey,
    ...asArray(risk?.affectedZones),
  ].filter(Boolean);
  return asArray(flight?.route).some((routePath) =>
    riskPaths.some((riskPath) => pathsLikelyOverlap(routePath, riskPath)),
  );
}

export function statusColor(status, riskLevel = null) {
  return toneColor(status, riskLevel);
}

export function replayTailFromNewestFirst(events) {
  return events.slice(0, 7).reverse();
}

export function zoneTierLabel(zone = {}) {
  const risk = String(zone.risk || "").toLowerCase();
  if (["critical", "high"].includes(risk)) return "Protected path";
  if (["medium", "warning"].includes(risk)) return "Shared contract";
  if (["low", "clear", "none"].includes(risk)) return "Routine path";
  return `Policy tier ${zoneClass(zone)}`;
}

export function graphNodeStyle(tone = "idle", depth = "surface") {
  const color = statusColor(tone);
  return {
    borderColor: `color-mix(in srgb, ${color} 34%, var(--border-subtle))`,
    background:
      depth === "raised"
        ? `linear-gradient(180deg, color-mix(in srgb, ${color} 11%, var(--bg-elevated)), color-mix(in srgb, var(--bg-surface) 92%, var(--bg-editor) 8%))`
        : `linear-gradient(180deg, color-mix(in srgb, ${color} 8%, var(--bg-surface)), color-mix(in srgb, var(--bg-surface) 94%, var(--bg-editor) 6%))`,
    boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 18%, transparent)`,
  };
}
