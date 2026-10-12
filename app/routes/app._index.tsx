// Home: the reorder list. The loader records the store, reads its plan from Shopify, checks permissions and
// starts the first sync if the store has never been synced.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { setPlanFromSubscriptions } from "../.server/shops";
import { startFirstSync } from "../.server/first-sync";
import { ReorderList } from "../components/restock/ReorderList";

// Permissions the app needs. write_inventory includes reading stock.
const NEEDED_SCOPES = ["read_products", "write_inventory", "read_locations", "read_orders"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const response = await admin.graphql(
    `#graphql
    query restockHome {
      shop { name }
      currentAppInstallation { accessScopes { handle } activeSubscriptions { name status test } }
    }`,
  );
  const { data } = await response.json();
  const granted: string[] = data?.currentAppInstallation?.accessScopes.map((s: { handle: string }) => s.handle) ?? [];
  await prisma.shop.upsert({
    where: { shop },
    create: { shop, name: data?.shop?.name ?? "" },
    update: { name: data?.shop?.name ?? "", uninstalledAt: null },
  });
  await setPlanFromSubscriptions(shop, data?.currentAppInstallation?.activeSubscriptions ?? []);
  const missingScopes = NEEDED_SCOPES.filter((s) => !granted.includes(s) && !(s.startsWith("read_") && granted.includes(s.replace("read_", "write_"))));
  if (!missingScopes.length) await startFirstSync(shop);
  return { shopName: data?.shop?.name || shop, missingScopes };
};

export default function Index() {
  const d = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  return (
    <s-page heading="Reorder">
      {d.missingScopes.length > 0 && (
        <s-banner tone="critical" heading="Permissions missing">
          The app is missing these permissions: {d.missingScopes.join(", ")}. Open the app again from Shopify Admin to approve them.
        </s-banner>
      )}
      <ReorderList go={(p) => navigate(p)} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
