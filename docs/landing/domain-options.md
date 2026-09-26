# Delegatus landing: domain options

Status: research only. Nothing was bought, reserved or put on hold. Every
check below is a read: registry RDAP and WHOIS lookups, published price lists,
and one availability query to the Cloudflare API that was refused.

## The requirement

Paraphrased from the operator's dictated request to the orchestrator seat on
2026-09-26 (the full paraphrase is at the top of `concept-opus.md`): look at a
domain for the landing, probably bought on Cloudflare; through the API if a key
in the secrets allows it, otherwise give the links and exactly what to enter.
The lane's specification adds: 8–12 candidates with availability and yearly
price, a recommendation, and the steps; never buy or reserve anything.

## How the checks were run (2026-09-26, about 08:20 Kyiv)

1. **Cloudflare Registrar API.** The operator's secrets hold one Cloudflare
   API token, scoped to the zone of an existing site. The token verifies as
   active, but it sees no accounts, and a
   `POST /accounts/{id}/registrar/domain-check` for `delegatus.dev` and
   `delegatus.app` came back `success: false`, code 10000, "Authentication
   error": the token has no Registrar permission. The endpoint itself exists
   and returns availability and price per name
   ([API reference](https://developers.cloudflare.com/api/resources/registrar/methods/check/),
   [Registrar API docs](https://developers.cloudflare.com/registrar/registrar-api/),
   beta since April 2026 per [Cloudflare's blog](https://blog.cloudflare.com/registrar-api-beta/)).
   No secret was printed or written anywhere.
2. **Availability** from each registry's own RDAP server, as listed in the
   [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json): Verisign for
   `.com`/`.net`, Google Registry for `.dev`/`.app`/`.page`, Identity Digital
   for `.ai`/`.run`/`.tools`, Public Interest Registry for `.org`, CentralNic
   for `.build`/`.xyz`. RDAP 404 means no registration exists. Country codes
   without RDAP (`.sh`, `.io`, `.so`, `.co`, `.to`, `.us`) were checked with
   `whois` against the registry. A 404 does not reveal whether a registry
   prices a name as premium; the registrar's checkout shows that.
3. **Prices.** Cloudflare sells at cost; its per-TLD prices come from
   [cfdomainpricing.com](https://cfdomainpricing.com/) (page states "Updated
   2026-09-25"), because Cloudflare's own
   [TLD policies page](https://www.cloudflare.com/tld-policies/) lists which
   TLDs are supported but renders no prices. Porkbun's public pricing API
   (`POST https://api.porkbun.com/api/json/v3/pricing/get`, no key needed)
   is the second source, for first-year and renewal prices at a registrar
   with promotions.

## Candidates

Prices in USD per year. "CF" is Cloudflare Registrar, registration = renewal
unless two numbers are shown. "PB" is Porkbun, first year / renewal.

| # | domain | status | evidence | CF | PB | note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `delegatus.dev` | **registered 2026-09-24** | Google Registry RDAP: created 2026-09-24 05:33 UTC at Namecheap, expires 2027-09-24, nameservers on Cloudflare; the site answers Cloudflare error 522 (no origin) | 12.20 | 8.75 / 12.87 | Free on 2026-09-23 per `docs/brand/naming-round-2.md`. See the recommendation. |
| 2 | `delegatus.app` | free | Google Registry RDAP 404 | 14.20 | 8.75 / 14.93 | HTTPS-only TLD (HSTS preloaded, see [get.app](https://get.app/)), which a static site on Cloudflare Pages serves anyway |
| 3 | `delegatus.ai` | free | Identity Digital RDAP 404 | 80.00 | 82.70 / 82.70 | Registry requires a 2-year minimum, so 160.00 up front at Cloudflare ([Cloudflare .ai page](https://www.cloudflare.com/application-services/products/registrar/buy-ai-domains/), [Wikipedia](https://en.wikipedia.org/wiki/.ai)) |
| 4 | `delegatus.sh` | free | Identity Digital WHOIS "Domain not found" | 45.00 | 31.20 / 46.65 | Cloudflare's policy page did not list `.sh` when checked; confirm at checkout or buy at Porkbun |
| 5 | `dlg.sh` | free | Identity Digital WHOIS "Domain not found" | 45.00 if standard | 31.20 / 46.65 if standard | Matches the `dlg` alias. A three-letter name is often registry-premium; the price is known only at checkout |
| 6 | `getdelegatus.com` | free | Verisign RDAP 404 | 10.46 | 11.08 / 11.08 | The usual `.com` fallback when the bare `.com` is taken |
| 7 | `usedelegatus.com` | free | Verisign RDAP 404 | 10.46 | 11.08 / 11.08 | Same, weaker verb |
| 8 | `delegatus.run` | free | Identity Digital RDAP 404 | 21.20 | 4.12 / 22.14 | Reads well as an action ("delegatus, run") |
| 9 | `delegatus.tools` | free | Identity Digital RDAP 404 | 28.20 | 9.78 / 29.35 | Generic |
| 10 | `delegatus.org` | free | PIR RDAP 404 | 8.50 / 11.20 | 7.98 / 11.84 | Cheapest; suits an open-source project, reads as a foundation |
| 11 | `delegatus.co` | free | .co WHOIS "DOMAIN NOT FOUND" | 30.00 | 15.76 / 31.20 | Easily mistyped as `.com`, which someone else owns |
| 12 | `delegatus.com` | registered since 2000 | Verisign RDAP: joker.com; the naming study found it serves nothing | — | — | Not for sale through a registrar |

Also checked: `delegatus.io` is registered (created 2026-07-09 at Hostinger);
`delegat.us` is registered (2026-04-02, Spaceship). Free but not
recommended: `delegatus.net`, `delegatus.xyz`, `delegatus.page`,
`delegatus.build`, `delegatus.software`, `delegatus.team`, `delegatus.codes`,
`getdelegatus.dev`, `delegatus.so` and `delegatus.to` (the last two are not
sold by Cloudflare).

## Recommendation

**Step 0: find out whether `delegatus.dev` is already yours.** It was
registered on 2026-09-24, the day after the naming study reported it free, at
Namecheap, and it is already on Cloudflare nameservers with Cloudflare's proxy
in front (the 522 answer). That is what a purchase by the operator followed by
adding it to Cloudflare looks like, and also what a squatter who read the
public rename documents would do. No conversation on this machine records the
purchase. Check the Namecheap account's domain list
(<https://ap.www.namecheap.com/domains/list/>) and the Cloudflare dashboard's
domain list (<https://dash.cloudflare.com/>, the account home lists every zone).

- **If it is yours:** use `delegatus.dev` for the landing and buy nothing.
  Optionally transfer it to Cloudflare Registrar after 60 days (the ICANN lock
  after a new registration) to renew at cost.
- **If it is not:** buy **`delegatus.app` at Cloudflare, 14.20 USD a year.**
  It is the exact name on a TLD that says what Delegatus is (an app you run),
  costs the same to renew as to register, lives in the same Cloudflare account
  as the Pages site the concept proposes, and is one of the TLDs Cloudflare's
  Registrar API documentation uses as an example, so a later API renewal or
  purchase works without a dashboard detour.

Why not the others: `.ai` costs 160 USD up front for a name the product does
not need; `.sh` and `dlg.sh` are clever and cost three times as much, with
Cloudflare support for `.sh` unconfirmed and `dlg.sh` possibly premium;
`getdelegatus.com` is a workaround name. A defensive `.com` redirect is
deferred below.

## How to buy `delegatus.app` on Cloudflare

Prerequisites ([Cloudflare: register a domain](https://developers.cloudflare.com/registrar/get-started/register-domain/)):
a verified account email and a payment method; contact details in ASCII only.

1. Open <https://dash.cloudflare.com/?to=/:account/registrar/register> and pick
   the account if asked.
2. Type `delegatus.app` in the search box and select **Search**.
3. Check the price shows **14.20 USD / year** (standard tier). If it shows a
   premium price, stop and choose again.
4. Select **Purchase**. Cloudflare runs a final availability check.
5. In **Payment option**, choose **1 year**. Auto-renew is on by default;
   leave it on.
6. Fill in the contact details (name, email, phone, address, city, state,
   country, postal code). Cloudflare redacts them from public WHOIS where the
   TLD allows.
7. Pick the payment method, accept the Domain Registration Agreement, the
   Self-serve Subscription Agreement and the Privacy Policy.
8. Select **Complete purchase** (up to 30 seconds). The domain appears as a
   zone in the same account.

Then, when the landing prototype exists: **Workers & Pages** → the landing
project → **Custom domains** → **Set up a custom domain** → `delegatus.app`.
Cloudflare creates the DNS record and the certificate itself.

**If you want the API route later.** The token in the secrets file cannot do
this. Create a new token at <https://dash.cloudflare.com/profile/api-tokens>
with the account permission **Registrar: Edit**, scoped to this account only,
and store it beside the existing one. With it,
`POST /accounts/{account_id}/registrar/domain-check` confirms availability
and price, and the register call buys; registration through the API is
non-refundable, so the check comes first.

## If `delegatus.app` is gone by the time you look

In order: `delegatus.sh` (Porkbun, 31.20 first year, 46.65 renewal, if
Cloudflare still does not offer `.sh`), then `getdelegatus.com` (Cloudflare,
10.46). Both were free at the time of the checks above.

## Deferred: not currently justified

- **Defensive registrations** (`getdelegatus.com`, `delegatus.org`,
  `delegatus.ai`) to redirect to the main domain. Nobody asked for brand
  protection, and each is a yearly cost.
- **Asking the holders of `delegatus.com`, `delegatus.io` or `delegat.us` to
  sell.**
- **A `curl -fsSL dlg.sh | sh` installer.** It would be a third install path;
  the landing installs through the visitor's agent, with `bunx` as the legacy
  path.
- **Trademark searches** for Delegatus (flagged in the naming study).

## Sources

[Cloudflare Registrar API docs](https://developers.cloudflare.com/registrar/registrar-api/),
[Cloudflare API: check domain availability](https://developers.cloudflare.com/api/resources/registrar/methods/check/),
[Cloudflare blog: Registrar API beta](https://blog.cloudflare.com/registrar-api-beta/),
[Domain Name Wire on the Registrar API](https://domainnamewire.com/2026/04/15/cloudflare-launches-domain-registration-api/),
[Cloudflare: register a domain](https://developers.cloudflare.com/registrar/get-started/register-domain/),
[Cloudflare TLD policies](https://www.cloudflare.com/tld-policies/),
[Cloudflare: buy .ai domains](https://www.cloudflare.com/application-services/products/registrar/buy-ai-domains/),
[cfdomainpricing.com](https://cfdomainpricing.com/),
[Porkbun pricing API](https://porkbun.com/api/json/v3/documentation),
[IANA RDAP bootstrap for DNS](https://data.iana.org/rdap/dns.json),
[.ai on Wikipedia](https://en.wikipedia.org/wiki/.ai),
[get.app](https://get.app/).
