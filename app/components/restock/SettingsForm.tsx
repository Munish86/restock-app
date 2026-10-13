// Settings: forecast defaults, which locations count, purchase order details, and alert emails.
import { useEffect, useState } from "react";
import { DEFAULTS, LIMITS, type Settings } from "../../lib/settings";
import { Button, Checkbox, NumberField, Select, TextField } from "../polaris";
import { api, ApiError, post, toast, type SettingsData } from "./api";
import { ErrorBanner, dateText } from "./ui";
import styles from "./restock.module.css";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SettingsForm({ googleEmail }: { googleEmail: string }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [dirty, setDirty] = useState(false);

  const apply = (d: SettingsData) => {
    setData(d);
    setS(d.settings);
    setDirty(false);
  };
  useEffect(() => {
    api<SettingsData>("/app/api/settings")
      .then(apply)
      .catch((e) => setError(e.message));
  }, []);

  if (!data || !s) {
    return (
      <s-section>
        <ErrorBanner error={error} />
        {!error && <s-text color="subdued">Loading…</s-text>}
      </s-section>
    );
  }

  const f = s.forecast;
  const setF = (patch: Partial<Settings["forecast"]>) => {
    setS({ ...s, forecast: { ...f, ...patch } });
    setDirty(true);
  };
  const setPo = (patch: Partial<Settings["po"]>) => {
    setS({ ...s, po: { ...s.po, ...patch } });
    setDirty(true);
  };
  const setAl = (patch: Partial<Settings["alerts"]>) => {
    setS({ ...s, alerts: { ...s.alerts, ...patch } });
    setDirty(true);
  };
  const num = (v: number | "", d: number) => (v === "" ? d : v);
  const save = () => {
    setBusy("save");
    setError(null);
    setProblems([]);
    post<SettingsData>("/app/api/settings", { settings: s })
      .then((d) => {
        apply(d);
        toast("Settings saved");
      })
      .catch((e) => {
        setError(e.message);
        if (e instanceof ApiError && e.problems) setProblems(e.problems);
      })
      .finally(() => setBusy(""));
  };
  const action = (what: "test-email" | "send-weekly") => {
    setBusy(what);
    setError(null);
    post<SettingsData & { result: { status: string; error?: string; to?: string[] } }>("/app/api/settings", { action: what })
      .then((d) => {
        setData(d);
        const r = d.result;
        if (r.status === "failed") setError(r.error || "The email was not sent.");
        else if (r.status === "skipped" && !d.emailLive) toast("Logged only: email sending is not set up on this server");
        else if (r.status === "skipped") toast(r.error || "Nothing to send");
        else toast("Email sent");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };

  // Same order the server uses (oldest first), so the ticks shown match the stock counted
  const idNum = (id: string) => Number(id.split("/").pop()) || 0;
  const active = data.locations.filter((l) => l.isActive).sort((a, b) => idNum(a.id) - idNum(b.id));
  const limit = data.plan.locations;
  const chosen = s.locations.filter((id) => active.some((l) => l.id === id));
  const toggleLocation = (id: string, on: boolean) => {
    const next = on ? [...chosen, id] : chosen.filter((x) => x !== id);
    setS({ ...s, locations: limit != null ? next.slice(-limit) : next });
    setDirty(true);
  };
  const r = (k: keyof typeof LIMITS) => `${LIMITS[k][0]} to ${LIMITS[k][1]}`;

  return (
    <s-stack direction="block" gap="base">
      <ErrorBanner error={error} />
      {problems.length > 1 && (
        <s-banner tone="critical">
          <s-unordered-list>
            {problems.map((p) => (
              <s-list-item key={p}>{p}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      <s-section heading="Forecasts">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
            <NumberField label="Sales history to use (days)" value={f.lookbackDays} onChange={(v) => setF({ lookbackDays: num(v, DEFAULTS.forecast.lookbackDays) })} details={`${r("lookbackDays")}. Recent weeks always count more.`} />
            <NumberField label="Lead time (days)" value={f.leadTimeDays} onChange={(v) => setF({ leadTimeDays: num(v, DEFAULTS.forecast.leadTimeDays) })} details="Ordering to arrival, when the supplier has none" />
            <NumberField label="Days to cover" value={f.daysToCover} onChange={(v) => setF({ daysToCover: num(v, DEFAULTS.forecast.daysToCover) })} details="Each order should last this long after it arrives" />
            <NumberField label="Safety stock (days of sales)" value={f.safetyDays} onChange={(v) => setF({ safetyDays: num(v, DEFAULTS.forecast.safetyDays) })} details="Extra, for late deliveries or a busy week" />
            <NumberField label="Dead stock after (days without a sale)" value={f.deadStockDays} onChange={(v) => setF({ deadStockDays: num(v, DEFAULTS.forecast.deadStockDays) })} />
            <NumberField label="Overstock above (days of stock)" value={f.overstockDays} onChange={(v) => setF({ overstockDays: num(v, DEFAULTS.forecast.overstockDays) })} />
          </s-grid>
          <Checkbox
            label="Use last year's sales to raise or lower forecasts for the coming weeks (festivals, seasons)"
            details="Needs a year of history; part of the Pro plan."
            checked={f.seasonal}
            onChange={(v) => setF({ seasonal: v })}
          />
          <Checkbox label="Count stock incoming in Shopify (transfers) as already on order" checked={f.countIncoming} onChange={(v) => setF({ countIncoming: v })} />
          <Checkbox label="Count draft purchase orders as already on order" details="Off: only sent orders count." checked={f.countDrafts} onChange={(v) => setF({ countDrafts: v })} />
        </s-stack>
      </s-section>

      <s-section heading="Locations">
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">
            Stock at these locations is counted.{" "}
            {limit != null
              ? `Your ${data.plan.name} plan counts ${limit} location${limit === 1 ? "" : "s"}; Pro counts several.`
              : "None ticked = every active location."}
          </s-text>
          {active.map((l) => (
            <Checkbox
              key={l.id}
              label={l.name}
              checked={chosen.length ? chosen.includes(l.id) : limit == null || active.indexOf(l) < limit}
              onChange={(on) => toggleLocation(l.id, on)}
            />
          ))}
          {!active.length && <s-text color="subdued">Locations appear after the first sync.</s-text>}
        </s-stack>
      </s-section>

      <s-section heading="Purchase orders">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          <TextField label="Company name on orders" value={s.po.companyName} onChange={(v) => setPo({ companyName: v })} placeholder={data.shopName} />
          <TextField label="Suppliers reply to" value={s.po.replyTo} onChange={(v) => setPo({ replyTo: v })} placeholder={data.shopEmail} />
          <TextField label="Order number prefix" value={s.po.prefix} onChange={(v) => setPo({ prefix: v })} details={`Next looks like ${s.po.prefix}0001`} />
          <Select
            label="Receive stock at"
            value={s.po.receiveLocationId}
            onChange={(v) => setPo({ receiveLocationId: v })}
            options={[{ value: "", label: "First counted location" }, ...active.map((l) => ({ value: l.id, label: l.name }))]}
          />
        </s-grid>
        <div style={{ marginTop: 12 }}>
          <s-stack direction="block" gap="base">
            <TextField label="Company address (printed on orders)" value={s.po.companyAddress} onChange={(v) => setPo({ companyAddress: v })} />
            <TextField label="Terms printed at the bottom of every order" value={s.po.footer} onChange={(v) => setPo({ footer: v })} placeholder="Payment 30 days from delivery." />
            <Checkbox
              label={`When stock is received, set Shopify's "cost per item" to the order's cost (ticked by default on the receive form)`}
              checked={s.po.updateCostOnReceive}
              onChange={(v) => setPo({ updateCostOnReceive: v })}
            />
          </s-stack>
        </div>
      </s-section>

      <s-section heading="Emails">
        <s-stack direction="block" gap="base">
          <Checkbox label="Weekly email: what to order this week (only sent when something needs ordering)" checked={s.alerts.weekly} onChange={(v) => setAl({ weekly: v })} />
          <Checkbox label="Low-stock alert: a daily email when items newly need ordering (each item once)" checked={s.alerts.lowStock} onChange={(v) => setAl({ lowStock: v })} />
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
            <Select label="Weekly email on" value={String(s.alerts.weeklyDay)} onChange={(v) => setAl({ weeklyDay: Number(v) })} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} />
            <Select
              label={`At (${data.timezone})`}
              value={String(s.alerts.hour)}
              onChange={(v) => setAl({ hour: Number(v) })}
              options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))}
            />
            <TextField label="Send to" value={s.alerts.recipients} onChange={(v) => setAl({ recipients: v })} placeholder={data.shopEmail} details="Comma separated; empty = the store email" />
          </s-grid>
          <s-text color="subdued">No marketing emails, ever. Every email has a link to turn it off.</s-text>
          {!data.emailLive && <s-banner tone="warning">Email sending is not set up on this server yet, so emails are only logged.</s-banner>}
          <s-stack direction="inline" gap="small-200">
            <Button onClick={() => action("test-email")} loading={busy === "test-email"} disabled={dirty}>
              Send a test email
            </Button>
            <Button onClick={() => action("send-weekly")} loading={busy === "send-weekly"} disabled={dirty}>
              Send this week&apos;s email now
            </Button>
          </s-stack>
          {data.emails.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Sent</th>
                    <th>Email</th>
                    <th>To</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.emails.map((e, i) => (
                    <tr key={i}>
                      <td>{dateText(e.at)}</td>
                      <td>{e.subject}</td>
                      <td>{e.to}</td>
                      <td>
                        <s-badge tone={e.status === "sent" ? "success" : e.status === "failed" ? "critical" : "neutral"}>{e.status}</s-badge>
                        {e.error && <div className={`${styles.small} ${styles.muted}`}>{e.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-stack>
      </s-section>

      {googleEmail && (
        <s-section heading="Google Sheets">
          <s-text>
            To import from a private Google Sheet, share it (Viewer) with <strong>{googleEmail}</strong>.
          </s-text>
        </s-section>
      )}

      <div className={styles.sticky}>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">{dirty ? "Unsaved changes" : "All changes saved"}</s-text>
          <s-stack direction="inline" gap="small-200">
            {dirty && (
              <Button
                onClick={() => {
                  setS(data.settings);
                  setDirty(false);
                }}
              >
                Discard
              </Button>
            )}
            <Button variant="primary" onClick={save} loading={busy === "save"} disabled={!dirty}>
              Save
            </Button>
          </s-stack>
        </s-stack>
      </div>
    </s-stack>
  );
}
