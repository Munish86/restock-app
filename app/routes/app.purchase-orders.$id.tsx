import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useNavigate, useParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PurchaseOrderEditor } from "../components/restock/PurchaseOrderEditor";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function PurchaseOrderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <s-page heading="Purchase order">
      <s-link slot="breadcrumb-actions" href="/app/purchase-orders">
        Purchase orders
      </s-link>
      <PurchaseOrderEditor key={id} id={id!} go={(p) => navigate(p)} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
