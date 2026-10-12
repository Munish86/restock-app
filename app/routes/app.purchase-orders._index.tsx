import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PurchaseOrders } from "../components/restock/PurchaseOrders";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function PurchaseOrdersPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <s-page heading="Purchase orders">
      <PurchaseOrders go={(p) => navigate(p)} initialSupplier={params.get("supplier") ?? ""} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
