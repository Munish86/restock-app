import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getGoogle } from "../.server/clients";
import { SettingsForm } from "../components/restock/SettingsForm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { googleEmail: getGoogle().email };
};

export default function SettingsPage() {
  const { googleEmail } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Settings">
      <SettingsForm googleEmail={googleEmail} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
