import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Suppliers } from "../components/restock/Suppliers";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await prisma.shop.findUnique({ where: { shop: session.shop }, select: { currency: true } });
  return { currency: s?.currency ?? "USD" };
};

export default function SuppliersPage() {
  const { currency } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Suppliers">
      <Suppliers currency={currency} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
