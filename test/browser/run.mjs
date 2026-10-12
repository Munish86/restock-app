// Browser test: npm run test:browser (needs Chrome or Edge installed, and internet for Polaris from Shopify's CDN).
// Set CHROME_PATH if the browser is somewhere else. Drives every Restock page in Chrome with a fake API: checks that
// what is shown is right and that clicks and typing send the right requests. Prints PASS / FAIL lines and saves
// screenshots in test/browser/.out/.
import fs from "node:fs";
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
if (!executablePath) {
  console.error("No Chrome or Edge found. Set CHROME_PATH.");
  process.exit(1);
}
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const shot = (name) => page.screenshot({ path: path.join(here, ".out", `${name}.png`), fullPage: true });
const calls = () => page.evaluate(() => window.__calls);
const lastPost = async (url) => (await calls()).filter((c) => c.url === url && c.method === "POST").at(-1)?.body;
const open = async (name) => {
  await page.goto("file:///" + path.join(here, "index.html").replace(/\\/g, "/") + `?page=${name}`);
  await page.waitForFunction(() => customElements.get("s-select") && document.querySelector("s-section"), null, { timeout: 30000 });
  await page.waitForTimeout(900);
};
const button = (text) => page.locator("s-button", { hasText: text }).first();
const field = (tag, label) => page.locator(`${tag}[label="${label}"]`).first();

// ---- Reorder list ----
await open("reorder");
await shot("1-reorder");
const bodyRows = () => page.locator("table tbody tr").count();
check("needs-ordering view lists the urgent items", (await bodyRows()) === 3, String(await bodyRows()));
check("tiles show totals", await page.getByText("Need ordering", { exact: true }).isVisible());
check("plan banner not shown under the limit", (await page.getByText("covers 50 of").count()) === 0);
check("out-of-stock item says Now", await page.locator("td", { hasText: /^Now$/ }).first().isVisible());
check("on order shown", await page.getByText("+20 on order").isVisible());

// The white mug: its sales include bundle sales
await page.locator("tr", { hasText: "White" }).getByText("Why?").click();
await page.waitForTimeout(300);
check("why panel opens", await page.getByText("Why these numbers").isVisible());
check("why explains the bundle sales", await page.getByText("units sold inside bundles").isVisible());
await shot("2-why");
// Save the item's own settings
await field("s-number-field", "Days to cover").locator("input").fill("45");
await page.waitForTimeout(100);
await button("Save settings").click();
await page.waitForTimeout(500);
const plan = await lastPost("/app/api/variants");
check("item settings saved", plan?.action === "plan" && plan?.variantIds?.[0]?.endsWith("/1") && plan?.patch?.daysToCover === 45 && plan?.patch?.rateOverride === "", JSON.stringify(plan));
await page.getByText("Close").first().click();

// Change a quantity: the row gets ticked, the bar appears
const qty = page.locator('input[aria-label="Quantity to order of Oslo Mug - White"]');
await qty.fill("200");
await page.waitForTimeout(200);
check("editing a quantity selects the row", await page.getByText("1 selected").isVisible());
await button("Select all that need ordering").click();
await page.waitForTimeout(200);
const selectedText = await page.locator("strong", { hasText: "selected" }).first().textContent();
check("select all that need ordering", /^[23] selected$/.test(selectedText || ""), selectedText);
check("warns about items without a supplier", await page.getByText("without a supplier").isVisible());
await shot("3-selected");
await button("Create purchase orders").click();
await page.waitForTimeout(600);
const created = await lastPost("/app/api/purchase-orders");
check("purchase orders request uses the edited quantity", created?.items?.find((i) => i.variantId.endsWith("/1"))?.quantity === 200, JSON.stringify(created));
check("success banner links the new order", (await page.locator('s-link[href="/app/purchase-orders/po9"]').count()) === 1);

await page.locator("s-button", { hasText: /^All 6$/ }).click();
await page.waitForTimeout(200);
check("all view lists everything", (await bodyRows()) === 6, String(await bodyRows()));
check("bundle row has no checkbox", (await page.locator('input[aria-label="Select Tea Set"]').count()) === 0);
await field("s-text-field", "Search").locator("input").fill("saucer");
await page.waitForTimeout(300);
check("search narrows the list", (await bodyRows()) === 1);
await shot("4-search");

// ---- Purchase orders list ----
await open("po");
check("order listed", await page.locator('s-link[href="/app/purchase-orders/po1"]').isVisible());
check("late order flagged", await page.getByText("late", { exact: true }).isVisible());
await shot("5-po-list");

// ---- Purchase order ----
await open("po-edit");
check("lines shown", (await page.locator("table").first().locator("tbody tr").count()) === 2);
check("minimum order warning", await page.getByText("minimum order is").isVisible());
await page.locator('input[aria-label="Quantity of Oslo Mug - White"]').fill("60");
await page.waitForTimeout(200);
check("unsaved changes noticed", await page.getByText("You have unsaved changes").isVisible());
await button("Save").click();
await page.waitForTimeout(500);
const saved = await lastPost("/app/api/purchase-orders/po1");
check("save sends the lines", saved?.action === "save" && saved?.lines?.[0]?.quantity === 60, JSON.stringify(saved?.lines?.[0]));
await button("Receive stock").click();
await page.waitForTimeout(300);
await page.locator('input[aria-label="Arrived now: Oslo Mug - Black"]').fill("10");
await shot("6-receive");
await page.locator("s-button", { hasText: /^Add \d+ units to stock$/ }).click();
await page.waitForTimeout(500);
const recv = await lastPost("/app/api/purchase-orders/po1");
check("receive sends what arrived", recv?.action === "receive" && recv.lines.find((l) => l.lineId === "l2")?.quantity === 10 && recv.lines.find((l) => l.lineId === "l1")?.quantity === 60, JSON.stringify(recv));
check("receipt listed with undo", await button("Undo").isVisible());
await button("Undo").click();
await page.waitForTimeout(500);
check("undo sent", (await lastPost("/app/api/purchase-orders/po1"))?.action === "undo-receipt");
check("receipt shows as undone", await page.getByText("Undone", { exact: true }).isVisible());
await button("Send again").click();
await page.waitForTimeout(300);
check("send form has the supplier email", (await field("s-text-field", "To").evaluate((el) => el.value)) === "orders@acme.test");
await page.locator("s-button", { hasText: /^Send$/ }).click();
await page.waitForTimeout(500);
check("send request", (await lastPost("/app/api/purchase-orders/po1"))?.to === "orders@acme.test");
await shot("7-po");

// ---- Suppliers ----
await open("suppliers");
// s-banner renders its heading twice in the DOM
check("unassigned banner", await page.getByText("4 items have no supplier yet").first().isVisible());
await button("Create suppliers from vendors").click();
await page.waitForTimeout(400);
check("from vendors request", (await lastPost("/app/api/suppliers"))?.action === "from-vendors");
await button("Add supplier").click();
await page.waitForTimeout(200);
await field("s-text-field", "Name").locator("input").fill("Lumen");
await field("s-text-field", "Email for orders").locator("input").fill("sales@lumen.test");
await field("s-number-field", "Lead time (days)").locator("input").fill("21");
await page.waitForTimeout(150);
await page.locator("s-button", { hasText: /^Save$/ }).first().click();
await page.waitForTimeout(400);
const sup = await lastPost("/app/api/suppliers");
check("new supplier sent", sup?.action === "create" && sup.supplier.name === "Lumen" && sup.supplier.leadTimeDays === 21, JSON.stringify(sup));
// Import from a Google Sheet
await page.locator("s-button", { hasText: "Google Sheet" }).first().click();
await page.waitForTimeout(200);
await field("s-text-field", "Google Sheet link").locator("input").fill("https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuv/edit");
await page.waitForTimeout(150);
await button("Read sheet").click();
await page.waitForTimeout(600);
check("columns filled from their names", (await field("s-select", "Supplier SKU").evaluate((el) => el.value)) === "Supplier code");
await button("Preview import").click();
await page.waitForSelector("text=Preview: nothing is saved yet", { timeout: 15000 });
const plan1 = (await calls()).filter((c) => c.url === "/app/api/jobs" && c.method === "POST").at(-1)?.body;
check("preview job options", plan1?.command === "import-plan" && plan1.options.columns.sku === "Variant SKU" && plan1.options.source === "google", JSON.stringify(plan1));
check("preview report rows", await page.getByText('No item in Shopify has SKU "NOPE".').isVisible());
await shot("8-import-preview");
await page.locator("s-button", { hasText: /^Import 1 change$/ }).click();
await page.waitForSelector("text=Imported", { timeout: 15000 });
check("import job started", (await calls()).filter((c) => c.url === "/app/api/jobs" && c.method === "POST").at(-1)?.body?.command === "import");

// ---- Dead stock ----
await open("dead");
check("dead stock value", await page.getByText("$360").first().isVisible());
await shot("9-dead");

// ---- Settings ----
await open("settings");
await field("s-number-field", "Days to cover").locator("input").fill("60");
await page.waitForTimeout(150);
check("unsaved settings noticed", await page.getByText("Unsaved changes").isVisible());
await page.locator("s-button", { hasText: /^Save$/ }).click();
await page.waitForTimeout(500);
check("settings saved", (await page.evaluate(() => window.__settings))?.forecast?.daysToCover === 60);
await page.locator('s-checkbox[label="Shop front"]').locator("input").check();
await page.waitForTimeout(150);
await page.locator("s-button", { hasText: /^Save$/ }).click();
await page.waitForTimeout(500);
const locs = (await page.evaluate(() => window.__settings))?.locations;
check("one-location plan keeps one location", JSON.stringify(locs) === JSON.stringify(["gid://shopify/Location/2"]), JSON.stringify(locs));
check("google email shown", await page.getByText("restock@project.iam.gserviceaccount.com").isVisible());
await shot("10-settings");

check("no page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
