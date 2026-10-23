// Matching a SliQ record to a Tolra record. Two routes, in this order:
//   1. the legacy id. The importer gives every record it writes a stable id (legacyId(organisation, kind, identity)) and keeps it in
//      public.legacy_import_map; a snapshot that carries that table lets us follow the exact route the import took.
//   2. the document number, exactly as written (text; prefixes, leading zeros and case matter).
// A disagreement between the two is a BLOCKER, never quietly resolved. A number used twice on either side is reported and the
// records involved are not compared (which one is meant cannot be known).
import { legacyId, normNumber } from "../sliq-import/ids.mjs";

import { safeRef } from "./safe.mjs";

/**
 * @param ctx   { add, tgt, org }
 * @param spec  { area, label, sources: [{ key, ref, row }], targets: [rows], refOf(row), mapSource (legacy_import_map.source) | null, hashKind (legacyId kind) | null,
 *                identityOf(source) (string for legacyId; default source.key), openOf?(source) }
 * @returns { pairs: [{ s, t, via }], missingSource: [s], extraTarget: [t], skippedTargets: Set }
 */
export function matchDocuments(ctx, spec) {
  const { add, tgt, org } = ctx;
  const { label, sources, targets, refOf, mapSource, hashKind } = spec;
  const canMap = !!(org && mapSource && tgt.has("legacy_import_map"));
  const byRef = new Map();
  for (const t of targets) {
    const r = refOf(t);
    if (r === null || r === undefined || r === "") continue;
    const k = normNumber(r);
    if (!byRef.has(k)) byRef.set(k, []);
    byRef.get(k).push(t);
  }
  const byId = new Map(targets.map((t) => [t.id, t]));
  const dupTargets = new Set();
  for (const [k, list] of byRef) {
    if (list.length > 1) {
      for (const t of list) dupTargets.add(t.id);
      add({ area: "numbering", code: "tolra_duplicate_number", ids: { [label]: k }, field: `${label} number`, source: "", target: `${list.length} Tolra records`, severity: "BLOCKER", reason: `Tolra has ${list.length} ${label} records with the number ${safeRef(k)}: which one is meant cannot be known, so none of them is compared.` });
    }
  }
  const pairs = [];
  const missingSource = [];
  const claimed = new Set();
  for (const s of sources) {
    const k = s.key;
    const numberHits = byRef.get(k) ?? [];
    let legacyNew = null;
    let tLegacy = null;
    if (canMap) {
      legacyNew = tgt.map.get(`${mapSource}|${legacyId(org, hashKind, spec.identityOf ? spec.identityOf(s) : k)}`) ?? null;
      tLegacy = legacyNew ? byId.get(legacyNew) ?? null : null;
    }
    if (numberHits.length > 1) {
      missingSource.push({ ...s, reason: "duplicate", skip: true });
      continue;
    }
    const tNum = numberHits[0] ?? null;
    if (tLegacy && tNum && tLegacy.id === tNum.id) {
      pairs.push({ s, t: tNum, via: "legacy id" });
      claimed.add(tNum.id);
    } else if (tLegacy && tNum) {
      add({ area: "numbering", code: "identity_conflict", ids: { [label]: s.ref }, field: "identity", source: `legacy id -> ${safeRef(refOf(tLegacy) ?? "")}`, target: `number -> another Tolra record`, severity: "BLOCKER", reason: `The ${label} number ${s.ref} is held by one Tolra record, but the import's legacy id for this SliQ record points at a different one.` });
      missingSource.push({ ...s, reason: "conflict", skip: true });
    } else if (tLegacy) {
      add({ area: "numbering", code: "number_changed", ids: { [label]: s.ref }, field: `${label} number`, source: s.ref, target: safeRef(refOf(tLegacy) ?? "") || "(none)", severity: "BLOCKER", reason: `The legacy id of this SliQ ${label} points at a Tolra record that carries a different number.` });
      pairs.push({ s, t: tLegacy, via: "legacy id (number differs)" });
      claimed.add(tLegacy.id);
    } else if (tNum) {
      const tag = tgt.rev.get(tNum.id);
      if (canMap && tag && tag.source === mapSource) {
        add({ area: "numbering", code: "number_used_by_other_record", ids: { [label]: s.ref }, field: "identity", source: "this SliQ record", target: "a Tolra record imported as a different SliQ record", severity: "BLOCKER", reason: `The ${label} number ${s.ref} already belongs to a Tolra record that the import created from a different SliQ record (a numbering collision).` });
        missingSource.push({ ...s, reason: "collision", skip: true });
      } else {
        if (canMap) add({ area: "numbering", code: "matched_by_number_only", ids: { [label]: s.ref }, field: "identity", source: s.ref, target: tag ? `legacy source ${safeRef(tag.source)}` : "not in the legacy map", severity: "INFO", reason: `Matched by ${label} number: the legacy map has no entry for this record, so it was not created by the import (or the map is incomplete).` });
        pairs.push({ s, t: tNum, via: "document number" });
        claimed.add(tNum.id);
      }
    } else {
      missingSource.push({ ...s, reason: legacyNew ? "legacy map points at a record that is not in the snapshot" : "no such record" });
    }
  }
  const extraTarget = targets.filter((t) => !claimed.has(t.id) && !dupTargets.has(t.id));
  return { pairs, missingSource, extraTarget, canMap, dupTargets };
}

/** Reports what is only in Tolra: WARN when the legacy map says the import created it from SliQ (so SliQ should have it), else INFO. */
export function reportExtraTargets(ctx, spec, extraTarget, state) {
  const { add, tgt } = ctx;
  for (const t of extraTarget) {
    const tag = tgt.rev.get(t.id);
    const ref = spec.refOf(t) ?? `(no number)#${t.id}`;
    const open = spec.openOfTarget ? spec.openOfTarget(t) : false;
    if (tag && tag.source === spec.mapSource) {
      add({ area: spec.area, code: "tolra_only_imported", ids: { [spec.label]: ref }, field: "existence", source: "(not in this SliQ export)", target: "present", severity: open ? "BLOCKER" : "WARN", reason: `Tolra holds this ${spec.label}, created by the SliQ import (legacy map), but it is not in the SliQ export given to this run: the export is incomplete or the record was changed afterwards.` });
    } else if (state?.listNative !== false) {
      add({ area: spec.area, code: "tolra_only", ids: { [spec.label]: ref }, field: "existence", source: "(not in this SliQ export)", target: "present", severity: open ? "WARN" : "INFO", reason: `Only in Tolra: not in the SliQ export and not recorded as created by the SliQ import (created in Tolra, demo data, or imported another way).${open ? " It is open, so it counts towards what is owed or committed." : ""}` });
    }
  }
}
