"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { useRouter } from "next/navigation";

type TransportMode = "public_transport" | "car" | "bike" | "walk";
type ConditionTolerance = "move_in_ready" | "light_cosmetic" | "full_renovation";
type ParkingRequired = "required" | "flexible" | "not_required";

type Preferences = {
  user_id: string;

  budget_max: number;
  budget_flex: number;
  notes_budget: string | null;

  min_bedrooms: number;
  min_bathrooms: number | null;

  property_type_rank: string[];
  property_type_reject_below_index: number;
  notes_property_type: string | null;

  tenure_rank: string[];
  tenure_reject_below_index: number;
  min_lease_years: number | null;
  notes_tenure: string | null;

  work_postcode: string;
  transport_mode: TransportMode;
  max_commute_minutes_total: number | null;
  max_walk_minutes: number | null;
  car_owner: boolean;
  bike_owner: boolean;
  transport_convenience_weight: number;
  notes_commute: string | null;

  religion_required: boolean;
  school_priority: boolean;
  gym_priority: boolean;
  has_children: boolean;
  quiet_area_priority: boolean;
  green_space_priority: boolean;
  safety_weight: number;
  cleanliness_weight: number;
  notes_lifestyle: string | null;

  max_service_charge: number | null;
  max_ground_rent: number | null;
  notes_running_costs: string | null;

  parking_required: ParkingRequired | null;
  parking_type_rank: string[] | null;
  parking_reject_below_index: number | null;
  storage_required: boolean;
  notes_parking: string | null;

  condition_tolerance: ConditionTolerance | null;
  notes_condition: string | null;

  affordability_weight: number;
  notes_value: string | null;
};

type SectionKey =
  | "budget"
  | "requirements"
  | "tenure"
  | "commute"
  | "lifestyle"
  | "running_costs"
  | "parking"
  | "condition"
  | "value";

type SectionStatus = "missing" | "partial" | "complete";

const SECTION_ORDER: { key: SectionKey; title: string }[] = [
  { key: "budget", title: "Budget" },
  { key: "requirements", title: "Property requirements" },
  { key: "tenure", title: "Tenure & lease" },
  { key: "commute", title: "Commute" },
  { key: "lifestyle", title: "Lifestyle" },
  { key: "running_costs", title: "Running costs" },
  { key: "parking", title: "Parking & storage" },
  { key: "condition", title: "Condition" },
  { key: "value", title: "Value & affordability" },
];

const UK_PROPERTY_TYPES = [
  "detached",
  "semi_detached",
  "terraced",
  "end_of_terrace",
  "flat",
  "maisonette",
  "bungalow",
  "studio",
  "other",
] as const;

const TENURE_TYPES = ["freehold", "share_of_freehold", "leasehold", "commonhold", "other"] as const;

const PARKING_TYPES = ["driveway", "garage", "allocated", "permit", "street", "none"] as const;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function labelize(x: string) {
  return x.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function reorder<T>(arr: T[], from: number, to: number): T[] {
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function normalizeRankList(current: string[] | null | undefined, allowed: readonly string[]) {
  const cur = Array.isArray(current) ? current : [];
  const allowedSet = new Set(allowed);
  const kept = cur.filter((x) => allowedSet.has(x));
  const missing = allowed.filter((x) => !kept.includes(x));
  return [...kept, ...missing];
}

/**
 * Completion rules:
 * - Minimum (yellow) = essentials set
 * - Full (green) = all “useful” non-boolean fields (excluding notes) filled
 */
function computeCompletion(p: Preferences) {
  const minimumOk =
    (p.work_postcode?.trim() ?? "").length > 0 &&
    p.budget_max > 0 &&
    p.min_bedrooms > 0 &&
    Array.isArray(p.property_type_rank) &&
    p.property_type_rank.length > 0;

  // Full completeness (exclude booleans + exclude notes_* fields)
  // Treat nullable numeric fields as required for "full" only if they’re part of scoring usefulness.
  const fullMissing: { key: string; section: SectionKey }[] = [];

  const needText = (v: string | null | undefined) => (v ?? "").trim().length > 0;
  const needNum = (v: number | null | undefined) => typeof v === "number" && Number.isFinite(v);
  const needNumPos = (v: number | null | undefined) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const needArr = (v: any[] | null | undefined) => Array.isArray(v) && v.length > 0;

  // Budget
  if (!needNumPos(p.budget_max)) fullMissing.push({ key: "budget_max", section: "budget" });
  if (!needNum(p.budget_flex)) fullMissing.push({ key: "budget_flex", section: "budget" });

  // Requirements
  if (!needNumPos(p.min_bedrooms)) fullMissing.push({ key: "min_bedrooms", section: "requirements" });
  if (p.min_bathrooms === null) fullMissing.push({ key: "min_bathrooms", section: "requirements" });
  if (!needArr(p.property_type_rank)) fullMissing.push({ key: "property_type_rank", section: "requirements" });
  if (!needNum(p.property_type_reject_below_index)) fullMissing.push({ key: "property_type_reject_below_index", section: "requirements" });

  // Tenure
  if (!needArr(p.tenure_rank)) fullMissing.push({ key: "tenure_rank", section: "tenure" });
  if (!needNum(p.tenure_reject_below_index)) fullMissing.push({ key: "tenure_reject_below_index", section: "tenure" });
  if (p.min_lease_years === null) fullMissing.push({ key: "min_lease_years", section: "tenure" });

  // Commute
  if (!needText(p.work_postcode)) fullMissing.push({ key: "work_postcode", section: "commute" });
  if (!needText(p.transport_mode)) fullMissing.push({ key: "transport_mode", section: "commute" });
  if (p.max_commute_minutes_total === null) fullMissing.push({ key: "max_commute_minutes_total", section: "commute" });
  if (p.max_walk_minutes === null) fullMissing.push({ key: "max_walk_minutes", section: "commute" });
  if (!needNum(p.transport_convenience_weight)) fullMissing.push({ key: "transport_convenience_weight", section: "commute" });

  // Lifestyle (weights required; booleans ignored)
  if (!needNum(p.safety_weight)) fullMissing.push({ key: "safety_weight", section: "lifestyle" });
  if (!needNum(p.cleanliness_weight)) fullMissing.push({ key: "cleanliness_weight", section: "lifestyle" });

  // Running costs
  if (p.max_service_charge === null) fullMissing.push({ key: "max_service_charge", section: "running_costs" });
  if (p.max_ground_rent === null) fullMissing.push({ key: "max_ground_rent", section: "running_costs" });

  // Parking (booleans ignored)
  if (!p.parking_required) fullMissing.push({ key: "parking_required", section: "parking" });
  if (!needArr(p.parking_type_rank ?? [])) fullMissing.push({ key: "parking_type_rank", section: "parking" });
  if (p.parking_reject_below_index === null) fullMissing.push({ key: "parking_reject_below_index", section: "parking" });

  // Condition
  if (!p.condition_tolerance) fullMissing.push({ key: "condition_tolerance", section: "condition" });

  // Value
  if (!needNum(p.affordability_weight)) fullMissing.push({ key: "affordability_weight", section: "value" });

  const fullOk = fullMissing.length === 0;

  // Section completeness: complete if none missing for that section. partial if some missing. missing if most missing.
  const missingBySection = new Map<SectionKey, number>();
  for (const m of fullMissing) missingBySection.set(m.section, (missingBySection.get(m.section) ?? 0) + 1);

  const sectionStatus: Record<SectionKey, SectionStatus> = {} as any;
  for (const s of SECTION_ORDER) {
    const miss = missingBySection.get(s.key) ?? 0;
    if (miss === 0) sectionStatus[s.key] = "complete";
    else {
      // treat essentials sections as partial if minimumOk includes some of it
      sectionStatus[s.key] = miss >= 3 ? "missing" : "partial";
    }
  }

  return { minimumOk, fullOk, fullMissing, sectionStatus };
}

function StatusPill({ minimumOk, fullOk }: { minimumOk: boolean; fullOk: boolean }) {
  const { bg, border, text, label } = (() => {
    if (fullOk) return { bg: "#f3fff7", border: "#b3ffcc", text: "#0a7a22", label: "✅ Fully complete" };
    if (minimumOk) return { bg: "#fff8e1", border: "#ffe08a", text: "#7a5a00", label: "🟡 Minimum complete" };
    return { bg: "#fff5f5", border: "#ffcccc", text: "#b00020", label: "🔴 Needs essentials" };
  })();

  return (
    <span
      style={{
        borderRadius: 999,
        padding: "6px 10px",
        border: `1px solid ${border}`,
        background: bg,
        color: text,
        fontWeight: 800,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function NavBadge({ status }: { status: SectionStatus }) {
  const style = (() => {
    if (status === "complete") return { bg: "#f3fff7", border: "#b3ffcc", text: "#0a7a22", label: "✓" };
    if (status === "partial") return { bg: "#fff8e1", border: "#ffe08a", text: "#7a5a00", label: "!" };
    return { bg: "#fff5f5", border: "#ffcccc", text: "#b00020", label: "×" };
  })();

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: 8,
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.text,
        fontWeight: 900,
        fontSize: 12,
      }}
      title={status}
    >
      {style.label}
    </span>
  );
}

function ChipToggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const { label, value, onChange } = props;
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      style={{
        padding: "10px 12px",
        borderRadius: 999,
        border: "1px solid " + (value ? "#b3ffcc" : "#e6e6e6"),
        background: value ? "#f3fff7" : "#fff",
        cursor: "pointer",
        fontWeight: 700,
      }}
    >
      {value ? "✅ " : "⬜️ "}
      {label}
    </button>
  );
}

function WeightSlider(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ fontSize: 13, fontWeight: 900 }}>
        {props.label}: <span style={{ color: "#444" }}>{props.value}/10</span>
      </label>
      <input
        type="range"
        min={1}
        max={10}
        value={clamp(props.value, 1, 10)}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: "100%", marginTop: 8 }}
      />
    </div>
  );
}

function DndRankList(props: {
  title: string;
  subtitle?: string;
  items: string[];
  cutoffIndex: number;
  onChangeItems: (items: string[]) => void;
  onChangeCutoff: (cutoff: number) => void;
}) {
  const { title, subtitle, items, cutoffIndex, onChangeItems, onChangeCutoff } = props;
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  return (
    <div style={{ border: "1px solid #e6e6e6", borderRadius: 14, padding: 12, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
        <div>
          <div style={{ fontWeight: 900 }}>{title}</div>
          {subtitle ? <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>{subtitle}</div> : null}
        </div>
        <span style={{ fontSize: 12, border: "1px solid #eee", borderRadius: 999, padding: "4px 8px", color: "#444" }}>
          drag & drop
        </span>
      </div>

      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {items.map((it, idx) => {
          const rejected = idx > cutoffIndex && cutoffIndex > 0;
          return (
            <div
              key={it + idx}
              draggable
              onDragStart={() => setDragIndex(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex === null) return;
                onChangeItems(reorder(items, dragIndex, idx));
                setDragIndex(null);
              }}
              style={{
                padding: "10px 10px",
                borderRadius: 12,
                border: "1px solid #eee",
                background: rejected ? "#fff5f5" : "#fafafa",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                cursor: "grab",
              }}
              title="Drag me"
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 8,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid #eee",
                    background: "#fff",
                    fontSize: 12,
                    color: "#666",
                  }}
                >
                  {idx + 1}
                </span>
                <span style={{ fontWeight: 700 }}>{labelize(it)}</span>
              </div>

              <span style={{ fontSize: 12, color: rejected ? "#b00020" : "#666" }}>
                {rejected ? "Rejected" : "OK"}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #eee" }}>
        <label style={{ fontSize: 13, fontWeight: 900 }}>
          Reject everything below:{" "}
          <span style={{ fontWeight: 800, color: "#444" }}>{cutoffIndex === 0 ? "Off" : cutoffIndex + 1}</span>
        </label>
        <input
          type="range"
          min={0}
          max={Math.max(0, items.length - 1)}
          value={clamp(cutoffIndex, 0, Math.max(0, items.length - 1))}
          onChange={(e) => onChangeCutoff(Number(e.target.value))}
          style={{ width: "100%", marginTop: 8 }}
        />
        <div style={{ color: "#666", fontSize: 13, marginTop: 6 }}>
          Tip: set to <b>0</b> to disable rejection.
        </div>
      </div>
    </div>
  );
}

export default function PreferencesPage() {
  // ✅ All hooks at top (avoids hook-order changes)
  const router = useRouter();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [status, setStatus] = useState<string>("Loading…");
  const [saving, setSaving] = useState(false);

  // Derived state (safe: no hooks inside conditionals)
  const completion = useMemo(() => {
    if (!prefs) {
      return {
        minimumOk: false,
        fullOk: false,
        fullMissing: [] as { key: string; section: SectionKey }[],
        sectionStatus: Object.fromEntries(SECTION_ORDER.map((s) => [s.key, "missing"])) as Record<SectionKey, SectionStatus>,
      };
    }
    return computeCompletion(prefs);
  }, [prefs]);

  async function getToken() {
    const { data } = await supabaseBrowser.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Not logged in");
    return token;
  }

  async function load() {
    setStatus("Loading your preferences…");
    try {
      const token = await getToken();
      const res = await fetch("/api/preferences", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to load");

      const p: Preferences = json.preferences;

      // Normalize the ranking lists to UK property types
      p.property_type_rank = normalizeRankList(p.property_type_rank, UK_PROPERTY_TYPES);
      p.tenure_rank = normalizeRankList(p.tenure_rank, TENURE_TYPES);
      p.parking_type_rank = normalizeRankList(p.parking_type_rank ?? [], PARKING_TYPES);

      // Ensure cutoffs are in range
      p.property_type_reject_below_index = clamp(p.property_type_reject_below_index ?? 0, 0, p.property_type_rank.length - 1);
      p.tenure_reject_below_index = clamp(p.tenure_reject_below_index ?? 0, 0, p.tenure_rank.length - 1);
      p.parking_reject_below_index = clamp(p.parking_reject_below_index ?? 0, 0, (p.parking_type_rank?.length ?? 1) - 1);

      setPrefs(p);
      setStatus("Ready");
    } catch (e: any) {
      setStatus("Error: " + (e?.message || String(e)));
    }
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      if (!data.session) router.push("/login");
      else load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!prefs) return;
    setSaving(true);
    setStatus("Saving…");
    try {
      const token = await getToken();
      const res = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(prefs),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to save");

      const p: Preferences = json.preferences;
      p.property_type_rank = normalizeRankList(p.property_type_rank, UK_PROPERTY_TYPES);
      p.tenure_rank = normalizeRankList(p.tenure_rank, TENURE_TYPES);
      p.parking_type_rank = normalizeRankList(p.parking_type_rank ?? [], PARKING_TYPES);

      setPrefs(p);
      setStatus("✅ Saved");
    } catch (e: any) {
      setStatus("❌ " + (e?.message || String(e)));
    } finally {
      setSaving(false);
    }
  }

  // Render skeleton without changing hook order
  if (!prefs) {
    return (
      <main style={{ maxWidth: 1150, margin: "24px auto", fontFamily: "system-ui", padding: "0 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ margin: 0 }}>Preferences</h1>
          <div style={{ color: "#666" }}>{status}</div>
        </div>
      </main>
    );
  }

  const leftNavHeight = "calc(100vh - 32px)";

  return (
    <main style={{ maxWidth: 1150, margin: "24px auto", fontFamily: "system-ui", padding: "0 12px" }}>
      {/* Header (kept minimal; status not only at top anymore) */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0 }}>Your Preferences</h1>
          <div style={{ color: "#666", marginTop: 6 }}>Playful + quick now. Wizard later.</div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <StatusPill minimumOk={completion.minimumOk} fullOk={completion.fullOk} />
          <button onClick={save} disabled={saving} style={{ padding: "10px 14px", borderRadius: 12, cursor: "pointer" }}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => router.push("/properties")} style={{ padding: "10px 14px", borderRadius: 12, cursor: "pointer" }}>
            Back
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>{status}</div>

      {/* 3-column layout: Left nav (small), Main, Right checklist */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "220px 1fr 320px", gap: 12 }}>
        {/* LEFT: Jump to section (small + scrollable + sticky) */}
        <aside
          style={{
            position: "sticky",
            top: 16,
            height: leftNavHeight,
            overflow: "auto",
            border: "1px solid #e6e6e6",
            borderRadius: 16,
            padding: 12,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Jump to section</div>

          <div style={{ display: "grid", gap: 8 }}>
            {SECTION_ORDER.map((s) => (
              <a
                key={s.key}
                href={`#sec-${s.key}`}
                style={{
                  textDecoration: "none",
                  color: "#111",
                  padding: "10px 10px",
                  borderRadius: 12,
                  border: "1px solid #eee",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span style={{ fontWeight: 800, fontSize: 13 }}>{s.title}</span>
                <NavBadge status={completion.sectionStatus[s.key]} />
              </a>
            ))}
          </div>

          <div style={{ height: 1, background: "#eee", margin: "12px 0" }} />

          <div style={{ fontSize: 12, color: "#666", lineHeight: 1.4 }}>
            <div style={{ fontWeight: 900, color: "#111", marginBottom: 6 }}>Legend</div>
            <div>× missing</div>
            <div>! partial</div>
            <div>✓ complete</div>
          </div>
        </aside>

        {/* MAIN */}
        <div style={{ display: "grid", gap: 12 }}>
          {/* Budget */}
          <section id="sec-budget" style={card()}>
            <Header title="1) Budget" tone="Critical" />
            <TwoCol>
              <FieldNumber label="Maximum budget (£)" value={prefs.budget_max} onChange={(v) => setPrefs({ ...prefs, budget_max: v })} />
              <FieldSelect
                label="Flexibility (± £)"
                value={String(prefs.budget_flex)}
                options={[
                  ["0", "No flexibility"],
                  ["10000", "±10,000"],
                  ["20000", "±20,000"],
                  ["50000", "±50,000"],
                  ["100000", "±100,000"],
                ]}
                onChange={(v) => setPrefs({ ...prefs, budget_flex: Number(v) })}
              />
            </TwoCol>
            <FieldTextarea
              label="Budget notes (optional)"
              value={prefs.notes_budget ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_budget: v || null })}
              placeholder="e.g. I can stretch slightly for a perfect location."
            />
          </section>

          {/* Requirements */}
          <section id="sec-requirements" style={card()}>
            <Header title="2) Property requirements" tone="Critical" />
            <TwoCol>
              <FieldNumber label="Minimum bedrooms" value={prefs.min_bedrooms} onChange={(v) => setPrefs({ ...prefs, min_bedrooms: v })} />
              <FieldNumberNullable
                label="Minimum bathrooms (optional but needed for full)"
                value={prefs.min_bathrooms}
                onChange={(v) => setPrefs({ ...prefs, min_bathrooms: v })}
              />
            </TwoCol>

            <div style={{ marginTop: 10 }}>
              <DndRankList
                title="Property type preference order (UK style)"
                subtitle="Drag to reorder. Use cutoff to reject lower-ranked types."
                items={prefs.property_type_rank}
                cutoffIndex={prefs.property_type_reject_below_index}
                onChangeItems={(items) => setPrefs({ ...prefs, property_type_rank: items })}
                onChangeCutoff={(c) => setPrefs({ ...prefs, property_type_reject_below_index: c })}
              />
            </div>

            <FieldTextarea
              label="Property type notes (optional)"
              value={prefs.notes_property_type ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_property_type: v || null })}
              placeholder="e.g. Detached preferred; flats okay only if spacious."
            />
          </section>

          {/* Tenure */}
          <section id="sec-tenure" style={card()}>
            <Header title="3) Tenure & lease" tone="Important" />
            <div style={{ marginTop: 10 }}>
              <DndRankList
                title="Tenure preference order"
                subtitle="Drag to reorder. Use cutoff to reject weaker tenure types."
                items={prefs.tenure_rank}
                cutoffIndex={prefs.tenure_reject_below_index}
                onChangeItems={(items) => setPrefs({ ...prefs, tenure_rank: items })}
                onChangeCutoff={(c) => setPrefs({ ...prefs, tenure_reject_below_index: c })}
              />
            </div>

            <TwoCol>
              <FieldNumberNullable
                label="Minimum lease years remaining (optional but needed for full)"
                value={prefs.min_lease_years}
                onChange={(v) => setPrefs({ ...prefs, min_lease_years: v })}
              />
              <div />
            </TwoCol>

            <FieldTextarea
              label="Tenure notes (optional)"
              value={prefs.notes_tenure ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_tenure: v || null })}
              placeholder="e.g. Avoid short leases; share of freehold is great."
            />
          </section>

          {/* Commute */}
          <section id="sec-commute" style={card()}>
            <Header title="4) Commute" tone="Critical" />
            <TwoCol>
              <FieldText
                label="Work postcode"
                value={prefs.work_postcode}
                onChange={(v) => setPrefs({ ...prefs, work_postcode: v })}
                placeholder="e.g. EC2A 4BX"
              />
              <FieldSelect
                label="Transport mode"
                value={prefs.transport_mode}
                options={[
                  ["public_transport", "Public transport"],
                  ["car", "Car"],
                  ["bike", "Bike"],
                  ["walk", "Walk"],
                ]}
                onChange={(v) => setPrefs({ ...prefs, transport_mode: v as TransportMode })}
              />
            </TwoCol>

            <TwoCol>
              <FieldNumberNullable
                label="Max commute minutes (total) (needed for full)"
                value={prefs.max_commute_minutes_total}
                onChange={(v) => setPrefs({ ...prefs, max_commute_minutes_total: v })}
              />
              <FieldNumberNullable
                label="Max walking minutes (needed for full)"
                value={prefs.max_walk_minutes}
                onChange={(v) => setPrefs({ ...prefs, max_walk_minutes: v })}
              />
            </TwoCol>

            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <ChipToggle label="I own a car" value={prefs.car_owner} onChange={(v) => setPrefs({ ...prefs, car_owner: v })} />
              <ChipToggle label="I own a bike" value={prefs.bike_owner} onChange={(v) => setPrefs({ ...prefs, bike_owner: v })} />
            </div>

            <WeightSlider
              label="Transport convenience importance"
              value={prefs.transport_convenience_weight}
              onChange={(v) => setPrefs({ ...prefs, transport_convenience_weight: v })}
            />

            <FieldTextarea
              label="Commute notes (optional)"
              value={prefs.notes_commute ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_commute: v || null })}
              placeholder="e.g. I prefer one train and a short walk."
            />
          </section>

          {/* Lifestyle */}
          <section id="sec-lifestyle" style={card()}>
            <Header title="5) Lifestyle" tone="Playful" />
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <ChipToggle label="Near gyms" value={prefs.gym_priority} onChange={(v) => setPrefs({ ...prefs, gym_priority: v })} />
              <ChipToggle label="Good schools" value={prefs.school_priority} onChange={(v) => setPrefs({ ...prefs, school_priority: v })} />
              <ChipToggle label="Green space" value={prefs.green_space_priority} onChange={(v) => setPrefs({ ...prefs, green_space_priority: v })} />
              <ChipToggle label="Quiet area" value={prefs.quiet_area_priority} onChange={(v) => setPrefs({ ...prefs, quiet_area_priority: v })} />
              <ChipToggle label="Children in plan" value={prefs.has_children} onChange={(v) => setPrefs({ ...prefs, has_children: v })} />
              <ChipToggle label="Religion nearby required" value={prefs.religion_required} onChange={(v) => setPrefs({ ...prefs, religion_required: v })} />
            </div>

            <WeightSlider label="Safety importance" value={prefs.safety_weight} onChange={(v) => setPrefs({ ...prefs, safety_weight: v })} />
            <WeightSlider
              label="Cleanliness importance"
              value={prefs.cleanliness_weight}
              onChange={(v) => setPrefs({ ...prefs, cleanliness_weight: v })}
            />

            <FieldTextarea
              label="Lifestyle notes (optional)"
              value={prefs.notes_lifestyle ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_lifestyle: v || null })}
              placeholder="e.g. I’m noise-sensitive; I like parks and calm streets."
            />
          </section>

          {/* Running costs */}
          <section id="sec-running_costs" style={card()}>
            <Header title="6) Running costs" tone="Optional" />
            <TwoCol>
              <FieldNumberNullable
                label="Max service charge (annual £) (needed for full)"
                value={prefs.max_service_charge}
                onChange={(v) => setPrefs({ ...prefs, max_service_charge: v })}
              />
              <FieldNumberNullable
                label="Max ground rent (annual £) (needed for full)"
                value={prefs.max_ground_rent}
                onChange={(v) => setPrefs({ ...prefs, max_ground_rent: v })}
              />
            </TwoCol>

            <FieldTextarea
              label="Running costs notes (optional)"
              value={prefs.notes_running_costs ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_running_costs: v || null })}
              placeholder="e.g. I’m cautious about high service charges."
            />
          </section>

          {/* Parking */}
          <section id="sec-parking" style={card()}>
            <Header title="7) Parking & storage" tone="Optional" />
            <TwoCol>
              <FieldSelect
                label="Parking"
                value={prefs.parking_required ?? "not_required"}
                options={[
                  ["required", "Required"],
                  ["flexible", "Flexible"],
                  ["not_required", "Not required"],
                ]}
                onChange={(v) => setPrefs({ ...prefs, parking_required: v as ParkingRequired })}
              />
              <div style={{ display: "flex", alignItems: "end" }}>
                <ChipToggle
                  label="Storage required"
                  value={prefs.storage_required}
                  onChange={(v) => setPrefs({ ...prefs, storage_required: v })}
                />
              </div>
            </TwoCol>

            <div style={{ marginTop: 10 }}>
              <DndRankList
                title="Parking type order"
                subtitle="Drag + cutoff. (Needed for full.)"
                items={prefs.parking_type_rank ?? normalizeRankList([], PARKING_TYPES)}
                cutoffIndex={prefs.parking_reject_below_index ?? 0}
                onChangeItems={(items) => setPrefs({ ...prefs, parking_type_rank: items })}
                onChangeCutoff={(c) => setPrefs({ ...prefs, parking_reject_below_index: c })}
              />
            </div>

            <FieldTextarea
              label="Parking notes (optional)"
              value={prefs.notes_parking ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_parking: v || null })}
              placeholder="e.g. Prefer allocated parking; permits are okay."
            />
          </section>

          {/* Condition */}
          <section id="sec-condition" style={card()}>
            <Header title="8) Condition tolerance" tone="Optional" />
            <TwoCol>
              <FieldSelect
                label="How much work are you okay with? (needed for full)"
                value={prefs.condition_tolerance ?? "light_cosmetic"}
                options={[
                  ["move_in_ready", "Move-in ready"],
                  ["light_cosmetic", "Light cosmetic"],
                  ["full_renovation", "Full renovation"],
                ]}
                onChange={(v) => setPrefs({ ...prefs, condition_tolerance: v as ConditionTolerance })}
              />
              <div />
            </TwoCol>

            <FieldTextarea
              label="Condition notes (optional)"
              value={prefs.notes_condition ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_condition: v || null })}
              placeholder="e.g. I’m happy to repaint, but not redo plumbing."
            />
          </section>

          {/* Value */}
          <section id="sec-value" style={card()}>
            <Header title="9) Value & affordability" tone="Optional" />
            <WeightSlider
              label="Affordability importance"
              value={prefs.affordability_weight}
              onChange={(v) => setPrefs({ ...prefs, affordability_weight: v })}
            />
            <FieldTextarea
              label="Value notes (optional)"
              value={prefs.notes_value ?? ""}
              onChange={(v) => setPrefs({ ...prefs, notes_value: v || null })}
              placeholder="e.g. I’ll pay more if the commute is amazing."
            />
          </section>
        </div>

        {/* RIGHT: Mini checklist (sticky; independent from left nav; always visible) */}
        <aside
          style={{
            position: "sticky",
            top: 16,
            height: leftNavHeight,
            overflow: "auto",
            border: "1px solid #e6e6e6",
            borderRadius: 16,
            padding: 12,
            background: "#fff",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div style={{ fontWeight: 900 }}>Mini checklist</div>
            <StatusPill minimumOk={completion.minimumOk} fullOk={completion.fullOk} />
          </div>

          <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
            {completion.fullOk
              ? "Everything useful is filled. Nice."
              : completion.minimumOk
              ? "Minimum is done. Fill the missing bits for a better score."
              : "Add the essentials to start scoring properly."}
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <ChecklistItem ok={(prefs.work_postcode ?? "").trim().length > 0} label="Work postcode set" mode={completion.fullOk ? "green" : completion.minimumOk ? "yellow" : "red"} />
            <ChecklistItem ok={prefs.budget_max > 0} label="Budget max set" mode={completion.fullOk ? "green" : completion.minimumOk ? "yellow" : "red"} />
            <ChecklistItem ok={prefs.min_bedrooms > 0} label="Minimum bedrooms set" mode={completion.fullOk ? "green" : completion.minimumOk ? "yellow" : "red"} />
            <ChecklistItem ok={prefs.property_type_rank.length > 0} label="Property type ranked" mode={completion.fullOk ? "green" : completion.minimumOk ? "yellow" : "red"} />
          </div>

          <div style={{ height: 1, background: "#eee", margin: "12px 0" }} />

          <div style={{ fontWeight: 900, marginBottom: 8 }}>What’s missing for full green?</div>

          <div style={{ display: "grid", gap: 8 }}>
            {SECTION_ORDER.map((s) => {
              const st = completion.sectionStatus[s.key];
              return (
                <a
                  key={s.key}
                  href={`#sec-${s.key}`}
                  style={{
                    textDecoration: "none",
                    color: "#111",
                    padding: "10px 10px",
                    borderRadius: 12,
                    border: "1px solid #eee",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    background: st === "complete" ? "#f3fff7" : st === "partial" ? "#fff8e1" : "#fff5f5",
                  }}
                >
                  <span style={{ fontWeight: 800, fontSize: 13 }}>{s.title}</span>
                  <NavBadge status={st} />
                </a>
              );
            })}
          </div>

          <div style={{ height: 1, background: "#eee", margin: "12px 0" }} />

          <div style={{ color: "#666", fontSize: 12, lineHeight: 1.4 }}>
            Full green = all useful non-boolean fields filled (notes are optional).
          </div>
        </aside>
      </div>
    </main>
  );
}

function card() {
  return { border: "1px solid #e6e6e6", borderRadius: 16, padding: 14, background: "#fff" } as const;
}

function Header({ title, tone }: { title: string; tone: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
      <span style={{ fontSize: 12, border: "1px solid #eee", borderRadius: 999, padding: "4px 8px" }}>{tone}</span>
    </div>
  );
}

function TwoCol({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>;
}

function ChecklistItem({ ok, label, mode }: { ok: boolean; label: string; mode: "green" | "yellow" | "red" }) {
  const style = (() => {
    if (mode === "green") return { bg: "#f3fff7", border: "#b3ffcc", text: "#0a7a22" };
    if (mode === "yellow") return { bg: "#fff8e1", border: "#ffe08a", text: "#7a5a00" };
    return { bg: "#fff5f5", border: "#ffcccc", text: "#b00020" };
  })();

  return (
    <div
      style={{
        padding: "10px 10px",
        borderRadius: 12,
        border: `1px solid ${style.border}`,
        background: style.bg,
        display: "flex",
        justifyContent: "space-between",
        fontWeight: 900,
      }}
    >
      <span>{label}</span>
      <span style={{ color: style.text }}>{ok ? "✓" : "…"}</span>
    </div>
  );
}

function FieldText(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label style={{ fontSize: 13, fontWeight: 900 }}>{props.label}</label>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid #e6e6e6" }}
      />
    </div>
  );
}

function FieldNumber(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label style={{ fontSize: 13, fontWeight: 900 }}>{props.label}</label>
      <input
        type="number"
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid #e6e6e6" }}
      />
    </div>
  );
}

function FieldNumberNullable(props: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div>
      <label style={{ fontSize: 13, fontWeight: 900 }}>{props.label}</label>
      <input
        type="number"
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? null : Number(e.target.value))}
        style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid #e6e6e6" }}
      />
    </div>
  );
}

function FieldSelect(props: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ fontSize: 13, fontWeight: 900 }}>{props.label}</label>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid #e6e6e6", background: "#fff" }}
      >
        {props.options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

function FieldTextarea(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ fontSize: 13, fontWeight: 900 }}>{props.label}</label>
      <textarea
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        style={{
          width: "100%",
          marginTop: 6,
          padding: 10,
          borderRadius: 12,
          border: "1px solid #e6e6e6",
          minHeight: 90,
          resize: "vertical",
        }}
      />
    </div>
  );
}
