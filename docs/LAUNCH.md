# Reorder Desk: live karne ke steps (owner ke liye)

App ka naam ab **Reorder Desk** hai: "Restock" App Store pe pehle se le liya gaya tha. Code folder, GitHub repo aur
Railway service ka naam `restock-app` hi rahega; merchants ko yeh kahin nahi dikhta.
Steps isi order mein karein. Har step ke baad kuch atke to Claude ko screenshot bhejein.

## 1. Naya naam Shopify tak pahunchao (5 min)

1. Railway > `restock-app` (web) > Variables: `APP_HANDLE` = `reorder-desk`. `restock-app-worker` pe bhi yahi.
2. Is folder mein terminal (PowerShell):
   ```
   $env:Path += ";C:\Windows\System32;C:\Windows"
   npm run deploy
   ```
   Yeh `shopify.app.toml` ka naam "Reorder Desk" aur handle `reorder-desk` Shopify pe bhej deta hai.
   Agar handle ka error aaye (taken), to batayein: dusra handle rakhenge.
3. Dev store pe app kholo: sidebar mein "Reorder Desk" dikhna chahiye.

## 2. Distribution: Public (2 min, ek baar ka faisla)

Partner Dashboard > Apps > Reorder Desk > **Distribution** > **Public distribution** (Shopify App Store).
**Custom distribution mat chunna**: woh permanent hai, fir App Store aur Managed Pricing kabhi nahi chalenge.
Public chunne ke baad review pass hone tak app sirf development stores pe install hoti hai; live store pe
App Store se install hogi (step 9).

## 3. Pricing: Managed Pricing (10 min)  -> yahi "Upgrade" ka 404 theek karega

Distribution > App Store listing > **Pricing** > "Manage pricing" / Managed pricing chuno. Plans:

| Plan name (exact) | Price | Trial |
|---|---|---|
| Free | $0 | - |
| Pro | $29 / month (aap badal sakte ho; badle to Claude ko batao, app ke Plans page pe bhi badlega) | 14 days |

Naam mein "Free" aur "Pro" shabd hone chahiye: app plan isi naam se pehchanta hai.
Check: dev store > Reorder Desk > Plans > Upgrade: ab Shopify ka plan page khulna chahiye (dev store pe charge
test hota hai, paisa nahi katta). Pro lene ke baad Plans page pe "Pro (your plan)" dikhna chahiye.

## 4. Orders ki permission (aaj hi, approval mein din/hafte lag sakte hain)

Partner Dashboard > Reorder Desk > **API access** > **Protected customer data access**:
- "Orders" data chuno, reason: inventory forecasting / purchase orders. Level 1 (customer name, email, address
  **nahi** chahiye).
- Data protection ke sawalon ke jawab: data encrypted (Railway Postgres), sirf daily totals rakhte hain, uninstall
  pe sab delete, staff access sirf owner.
- Same page pe **read_all_orders** request karo (reason: "forecasts need one year of sales for seasonality").
  Approve hone ke baad Claude `shopify.app.toml` ke scopes mein jod dega.

## 5. Cloudflare R2 (15 min) - supplier sheet import ke liye

1. Cloudflare > R2 > Create bucket `restock-files`.
2. Bucket > Settings > Object lifecycle rules > delete objects after **8 days**.
3. R2 > Manage API tokens > Create **Account API token**: Object Read & Write, sirf bucket `restock-files`.
4. Railway pe **dono** services (web + worker) mein: `R2_BUCKET=restock-files`, `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

## 6. Emails: Resend (20 min + domain DNS)

1. resend.com account > Domains > apna domain add karo (jaise `mail.aapkadomain.com`), DNS records lagao,
   "Verified" hone do.
2. API Keys > create (Sending access).
3. Railway dono services: `RESEND_API_KEY`, `EMAIL_FROM="Reorder Desk <orders@mail.aapkadomain.com>"`,
   `SUPPORT_EMAIL=aapka-support@email` (privacy/support page pe dikhta hai).
4. App > Settings > "Send a test email": inbox mein aana chahiye.

## 6b. SMS + WhatsApp alerts: Twilio (Pro feature, 30 min + WhatsApp approval mein kuch din)

Pro store ko har mahine 100 messages milte hain (har number pe har message 1 ginta hai; "SMS and WhatsApp" = 2).
Limit `app/lib/plans.ts` mein `messages: 100` hai. Limit khatam = sirf email jaata hai. Kharcha aapka hai, isliye:

1. twilio.com account > billing mein paise daalo, **auto-recharge band** rakho (galti se bada bill na aaye).
2. **Messaging > Settings > Geo permissions**: sirf woh desh on karo jahan aapke merchants hain (US, CA, UK, AU...).
   Mehenge desh band = koi bhi number wahan SMS nahi bhej payega. Yahi sabse bada bachav hai.
3. **SMS**: ek number kharido (US ke liye toll-free number lo aur "Toll-free verification" bharo; 10DLC se aasaan).
   Railway dono services: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM=+1...`.
4. **WhatsApp**: Messaging > Senders > WhatsApp senders > apna Meta Business account jodo (business verification
   lagta hai), ek number register karo. Phir Content Template Builder > naya template, category **Utility**, text:
   `Reorder Desk alert for {{1}}: {{2}}. Open the reorder list: {{3}}` > WhatsApp approval ke liye bhejo.
   Approve hone ke baad Railway pe: `TWILIO_WHATSAPP_FROM=+1...`, `TWILIO_WHATSAPP_TEMPLATE=HX...`.
5. App > Settings > "SMS and WhatsApp alerts" (Pro plan pe dikhta hai) > apna number > Save > "Send a test message".
6. Har mahine Twilio ka bill dekho. Approx rate (Oct 2026): SMS US ~$0.01, UK/AU ~$0.05; WhatsApp utility US
   ~$0.008. Ek Pro store ka max kharcha ~100 x $0.05 = $5, Pro $29 hai. Rate badle to `messages` kam karo.

## 7. Dev store pe pura test (30 min)

1. 2-3 products: SKU, cost per item, alag-alag stock.
2. Orders > Create order (5-8 orders) > Mark as paid.
3. App > "Sync now" > "Need ordering" list + "Why?" check.
4. Suppliers > "Create suppliers from vendors" ya "Add supplier" (apna email).
5. Reorder > tick > "Create purchase orders" > PO kholo > "Send to supplier" (email + PDF aaye) ya "Mark as sent".
6. "Receive stock" > Shopify Products mein stock badha? > "Undo" > stock wapas?
7. Dead stock, Settings, Plans (Upgrade) pages. Jo bhi galat lage, screenshot Claude ko.

## 8. Listing aur submit (1-2 ghante)

Text: `docs/LISTING.md` se copy karo. Saath mein chahiye:
- App icon 1200x1200 PNG (bina text ke simple logo).
- 3-6 screenshots 1600x900 (step 7 ke baad dev store se; list LISTING.md mein).
- Privacy URL: https://restock-app-production.up.railway.app/privacy (pehle text padh lena).
- Testing instructions: LISTING.md ka reviewer block; dev store pe orders hone chahiye, reviewer ke liye staff
  account / collaborator access.
- Emergency contact, support email.
Phir Distribution > **Submit for review**. Review 1-4 hafte; jo issue aaye, Claude ko bhejo.

## 9. Approve hone ke baad: live store pe

App Store pe "Reorder Desk" search karo (ya listing link) > **Install** apne live store pe. Pehla sync khud chalega.
Pro chahiye to app > Plans > Upgrade.

## Review se pehle live store pe chahiye? (optional)

Partner Dashboard mein **alag** app banao ("Reorder Desk Private"), use **Custom distribution** do, sirf apne live
store ka domain daalo. Claude uski alag config (`shopify.app.private.toml`) aur Railway env bana dega; code same
rahega. Main "Reorder Desk" app ko custom mat karna.
