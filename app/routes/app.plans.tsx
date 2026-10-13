// Plans: the current plan, how many variants it covers, and the plans on offer. Choosing or changing a plan
// happens on Shopify's own plan page (Managed Pricing); prices and the free trial are set in the Partner Dashboard.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { appHandle, syncPlan } from "../.server/shops";
import { PLANS, planByKey } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const planKey = await syncPlan(shop, (q) => admin.graphql(q));
  const [variants, locations] = await Promise.all([
    prisma.variant.count({ where: { shop, deletedAt: null, status: "ACTIVE", isBundle: false } }),
    prisma.location.count({ where: { shop, isActive: true } }),
  ]);
  const store = shop.replace(".myshopify.com", "");
  return {
    current: planKey,
    variants,
    locations,
    pricingUrl: `https://admin.shopify.com/store/${store}/charges/${appHandle()}/pricing_plans`,
  };
};

export default function PlansPage() {
  const d = useLoaderData<typeof loader>();
  const current = planByKey(d.current);
  const fits = PLANS.find((p) => (p.variants == null || p.variants >= d.variants) && (p.locations == null || p.locations >= Math.min(d.locations, 2)));

  return (
    <s-page heading="Plans">
      <s-section heading="Your plan">
        <s-stack direction="block" gap="small-200">
          <s-text>
            <strong>{current.name}</strong> ·{" "}
            {current.variants == null ? "no variant limit" : `forecasts for ${current.variants.toLocaleString()} variants`} · your store has{" "}
            {d.variants.toLocaleString()} active variants and {d.locations} location{d.locations === 1 ? "" : "s"}
          </s-text>
          {current.variants != null && d.variants > current.variants && (
            <s-text color="subdued">
              Your best-selling {current.variants.toLocaleString()} variants get suggestions; the rest are listed without one.
              {fits ? ` ${fits.name} covers your whole store.` : ""}
            </s-text>
          )}
          <div>
            <s-button variant="primary" href={d.pricingUrl} target="_top">
              {current.key === "free" ? "Upgrade" : "Change plan"}
            </s-button>
          </div>
        </s-stack>
      </s-section>
      <s-section heading="All plans">
        <s-grid gridTemplateColumns="repeat(auto-fill, minmax(210px, 1fr))" gap="base">
          {PLANS.map((p) => (
            <s-box key={p.key} padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>
                  {p.name}
                  {p.key === current.key ? " (your plan)" : ""}
                </s-heading>
                <s-text>{p.price}</s-text>
                <s-unordered-list>
                  {p.features.map((f) => (
                    <s-list-item key={f}>{f}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
        <s-text color="subdued">
          Every plan includes purchase orders, receiving, supplier import, bundles, dead stock and the weekly email. Prices and the free trial
          are confirmed on Shopify&apos;s plan page and charged on your Shopify bill.
        </s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
