# Voice Employees

Status (Phase 13): **designed, not built.** No phone number, call, speech recognition, speech synthesis or recording exists in Nexefiy. The **Voice Receptionist** template is shown as *Not available yet* and can't be used (`telephony` is `planned` in `src/modules/employees/domain/capabilities.ts`; voice skills are not seeded). Do not advertise voice employees until the checklist in §11 is done.

The configuration below was **selected from vendor documentation** (read through search excerpts on 2026-10-19 — the vendor sites couldn't be opened directly from this environment). It has **not been verified with a live call**. Recheck every vendor fact before building.

## 1. Selected configuration

| Part | Choice | Why |
|---|---|---|
| Carrier, numbers, call control | **Twilio Programmable Voice** | Number search and purchase API in many countries, regulatory bundles, `<Dial>` transfers, recording API with deletion, fallback URLs on voice webhooks. |
| Voice layer (speech ↔ text, turn-taking, barge-in) | **Twilio ConversationRelay** (`<Connect><ConversationRelay>`) | Twilio does speech recognition, speech synthesis and interruption, and exchanges **text** with our server over a WebSocket. Our runtime keeps deciding every reply and every tool call, so permissions, approvals and audit stay in Nexefiy. |
| Brain | **The shared employee runtime** (`runEmployee`) in a new *call* mode, Claude via the model gateway | Same configuration, tools, policies and executor as every other employee. No separate voice product or code path. |
| Hosting | **Vercel** for HTTP webhooks (incoming call TwiML, `<Connect action>`, status and recording callbacks) + **one small long-lived Node service** (the *voice relay*) for the ConversationRelay WebSocket | ConversationRelay needs a `wss://` endpoint for the whole call and **does not reconnect** if the socket drops (the call ends as failed). Vercel WebSockets are in public beta and close when the function reaches its maximum duration (300 s by default, up to 800 s, 1,800 s in beta), which would cut long calls off. |
| Second carrier (later) | **Telnyx** | Offers a Conversation Relay with nearly the same messages (`setup`, `prompt`, `interrupt`, `dtmf`, `error` in; `text`, `play`, `sendDigits`, `language`, `end` out), numbers in 100+ countries, call-control webhooks with a failover URL. The relay service can support both behind one interface. |

**Considered and not chosen:**

- **Twilio Media Streams** (raw 8 kHz μ-law audio over WebSocket): we would build speech recognition, speech synthesis, end-of-turn detection and barge-in ourselves. Use only if we need full audio control.
- **Vapi** (custom LLM endpoint, OpenAI-compatible, plain HTTP that could run on Vercel): Vapi owns turn-taking and conversation state. How our own tool calls would map onto its tool flow is unconfirmed. Its free numbers are US-only and inbound-only.
- **Retell AI** (custom LLM over WebSocket): only cold transfer is available with a custom LLM, and it sells US/Canada numbers only (others need SIP trunking).

## 2. Compatibility with Nexefiy's architecture

| Nexefiy requirement | How the selected configuration meets it | Checked |
|---|---|---|
| Model output is never authorization | The relay passes caller text into the runtime; tool calls go through `requestAction` with the employee actor, exactly as tasks do. Twilio never calls tools. | Design only |
| No privileged credentials in the browser | Twilio credentials are server-only: Vercel webhooks and the relay service. | Design only |
| Organization from verified context | The organization and employee come from the **called number** (looked up server-side) and signed `<Parameter>`s, never from caller speech. | Design only |
| Webhook authenticity | Validate `X-Twilio-Signature` on every webhook and on the WebSocket handshake. | Vendor docs |
| Persist long-running state | Calls are short and real-time. Durable state (call record, transcript, summary, follow-up work) is written to Postgres as the call progresses. Anything that needs approval becomes a task after the call (§7). | Design only |
| Audit without hoarding | Store the call record, a redacted transcript and the summary. Recordings stay off by default and are deleted on a schedule (§5). | Design only |
| Latency | Stream reply tokens to ConversationRelay as they arrive. Twilio quotes about 0.5 s median and 0.7 s p95 for its own part; these are vendor figures, not measured. Use the *fast* or *balanced* tier with low effort for calls. | Vendor docs |

## 3. Call flow (planned)

```
Caller ──PSTN──▶ Twilio number
  Twilio ──POST /api/voice/incoming (Vercel, signature checked)──▶ Nexefiy
     looks up number → organization, voice employee (active version), opening hours
     returns TwiML:
       <Start><Recording …/></Start>             (only if recording is enabled and consent is collected)
       <Connect action="/api/voice/after-relay">
         <ConversationRelay url="wss://voice-relay…/calls" welcomeGreeting="…AI disclosure…">
           <Parameter name="callToken" value="(signed, short-lived)"/>
  Twilio ⇄ voice relay (WebSocket): prompt / interrupt / dtmf  ⇄  text tokens / end
     relay → runEmployee(call mode) → tools via requestAction → reply text streamed back
  relay sends {type: "end", handoffData: {...}} to transfer or finish
  Twilio ──POST /api/voice/after-relay──▶ Nexefiy returns <Dial> (transfer), <Say>/<Record> (message) or <Hangup>
  Twilio ──status / recording callbacks──▶ Nexefiy stores the outcome, summary task, recording handling
```

## 4. Phone-number provisioning

- **Search and buy** through Twilio's AvailablePhoneNumbers (Local, Mobile, TollFree per country) and `POST /IncomingPhoneNumbers`.
- **Regulated countries** (for example the UK, Germany and much of the EU) require an **address** and/or a **regulatory bundle** (end user plus supporting documents, such as government ID and proof of address for UK individuals). Without one, the purchase fails (Twilio errors 21631 and 21649). Nexefiy will guide an **owner** through creating the bundle; documents go straight to Twilio, not into Nexefiy storage.
- **Ownership model:** one Twilio subaccount per Nexefiy organization (isolation, separate usage and billing). Credentials are stored encrypted (`encryptCredential`, ADR-014).
- **Who may provision:** owners and admins only, with typed confirmation, because numbers cost money every month. Releasing a number is a separate, confirmed admin action.
- **Bring your own number:** port it to Twilio, or point an existing Twilio number at Nexefiy's webhooks.
- **Outbound calling is out of scope** (§8). If it is ever added, it needs a Trust Hub business profile and SHAKEN/STIR attestation, and CNAM / Voice Integrity to avoid spam labelling.

## 5. Recording and consent

- **Off by default.** An admin turns recording on per voice employee and picks the consent rule. The rule is enforced in code, not left to the prompt.
- **Disclosure first:** the `welcomeGreeting` always says the caller is talking to an AI assistant for the business, says whether the call is recorded, and gives the purpose. It is non-interruptible.
- **Consent:**
  - Where all parties must consent, or the caller's location is unknown, recording starts only after the caller says yes. Twilio's Recordings API can start, pause and stop a recording mid-call.
  - If the caller declines, the call continues **without** recording.
  - Card numbers and other sensitive data pause the recording, and never go in `handoffData`.
- **Storage and retention:**
  - Twilio stores recordings, dual-channel by default.
  - Nexefiy downloads each finished recording to private Supabase Storage scoped by organization, then deletes it from Twilio (`DELETE` on the Recording resource). Twilio keeps metadata about 40 days, and full removal can take up to 30 days.
  - The retention period is set per organization and enforced by a purge job.
- **Transcripts** are stored redacted; the summary is the primary record.

## 6. Call transfer behavior

- **When:** the caller asks for a person; the call matches an escalation rule (complaint, emergency, legal, payment issue); the employee can't help; or the runtime fails (§9).
- **How:**
  1. The relay sends `end` with `handoffData` (reason, destination key, short summary).
  2. Twilio calls the `<Connect action>` URL.
  3. Nexefiy returns `<Dial timeout="20">` to the destination, which comes from the admin-configured list; the model chooses only the *key*, never a number.
  4. A whisper (`<Number url>`) gives the person the summary before the caller is connected.
- **Cold transfer** is the first release. **Warm transfer** (conference with the AI briefing the person) is later: Twilio documents conferences, but using them together with ConversationRelay isn't a documented pattern.
- **No answer, busy or failed** (`DialCallStatus`): the caller is offered a message (`<Record>`, with consent) or a call-back. A follow-up task is created, and the destination's team is notified once notifications exist.
- **Outside opening hours:** transfer destinations are skipped, and the caller is offered a message or call-back.

## 7. Tools and approvals during a call

- A call can't wait hours for an approval. In call mode, the employee may use only tools whose decision is **allow** (reads such as knowledge search and HubSpot contact lookup).
- Every write is handled like this: the employee collects the details, confirms them with the caller, and creates a follow-up **task** after the call. The task goes through the normal approval path. The caller is told what will happen next, never that it already happened.
- **Appointment booking** needs a calendar integration (`calendar` is planned). Until then the employee collects preferred times for a person to confirm.

## 8. Legal restrictions (summary, not legal advice — get counsel per country before launch)

- **AI disclosure:**
  - EU AI Act Article 50(1) requires that people are told they are interacting with an AI system at the latest at the first interaction. It applies from **2 August 2026**.
  - The always-on disclosure in the greeting covers this everywhere.
- **US recording consent:**
  - About a dozen states, including California (Penal Code §632, and §632.7 for cell and cordless phones), require all parties to consent.
  - Nexefiy therefore asks for consent on every recorded call rather than tracking state law.
- **US outbound calls:**
  - FCC Declaratory Ruling 24-17 (February 2024) treats AI-generated voices as "artificial" under the TCPA, so they need prior express consent.
  - Outbound calling is **not planned** for the first voice release.
- **GDPR and UK GDPR:**
  - Identify a lawful basis before processing.
  - Tell callers the purposes, legal basis, retention and their rights (Article 13). The greeting gives a short notice and points to the full privacy notice.
  - Recordings and transcripts are personal data, so retention limits and deletion apply.
- **UK PECR:** automated marketing calls with recorded material need specific prior consent. Whether an AI voice counts as "recorded material" is unconfirmed, and it is another reason not to make outbound calls.
- **Emergency calls:** the greeting and the escalation rules tell callers to hang up and dial the local emergency number. A Nexefiy number is not an emergency service.

## 9. Fallback behavior

| Failure | Behavior |
|---|---|
| Nexefiy's incoming-call webhook errors or exceeds its timeout (Twilio caps call webhooks at 15 s; use connection overrides to fail over faster) | Twilio's **fallback URL** returns static TwiML from a separate, minimal endpoint. It apologizes, then offers a voicemail with consent or dials the organization's fallback number. |
| The relay WebSocket drops (ConversationRelay does not reconnect) | The call ends as failed. The status callback records it and creates a follow-up task with whatever was collected, and the call is marked for call-back. |
| Model or runtime error, timeout or budget limit mid-call | The relay sends a short apology, then `end` with `handoffData.reason = "runtime_failure"`. The action URL transfers to the fallback destination, or takes a message. |
| The voice employee is paused, archived or out of budget | Incoming calls get the fallback TwiML straight away; the employee never answers. |
| The relay sends a malformed message (Twilio error 64107) | Twilio drops the message and the call continues; after 10 in a row it closes the socket, which is handled like a dropped socket. Relay contract tests guard the message format. |

## 10. Data and configuration to add when building

- **Migration:** `voice_numbers` (organization, Twilio number SID, E.164 number, employee, status), `voice_settings` (per employee: greeting, language, recording rule, retention, opening hours, transfer destinations as keyed E.164 numbers, fallback destination), `calls` and `call_events` (status, from/to with the caller number hashed for lookup, duration, outcome, summary, task links), RLS and pgTAP like every tenant table.
- **Credentials (planned names, not in `src/lib/env` yet):** `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (platform account; subaccount credentials stored encrypted per organization), `VOICE_RELAY_URL`, `VOICE_RELAY_SIGNING_KEY`. Add them through the env catalog when the feature is built.
- **Code:** `src/modules/voice` (number provisioning, TwiML builders, webhook signature checks, settings validation), the relay service (`services/voice-relay`), a *call* mode in the shared runtime (streaming, allow-only tools, a short turn limit), connector contract tests, and Playwright tests for the settings pages.

## 11. Before calling voice employees available

1. A Twilio account, plus one purchased test number in each launch country (bundles approved).
2. Live calls tested end to end:
   - the disclosure;
   - consent yes and no;
   - an intent;
   - details collected and confirmed;
   - a transfer that is answered, and one that isn't;
   - every fallback in §9;
   - the summary and the follow-up task.
3. Recording download, deletion from Twilio and the retention purge, all verified.
4. Legal review of the disclosure, consent wording and privacy notice for each launch country.
5. Latency measured on real calls; target under 1.5 s to the first audio of a reply.
6. Only then: `telephony` → `built`, voice skills seeded by a migration, and the website capability updated with its evidence.

## Sources (checked through search on 2026-10-19)

- Twilio ConversationRelay: twilio.com/docs/voice/twiml/connect/conversationrelay, twilio.com/docs/voice/conversationrelay/websocket-messages, twilio.com/docs/voice/conversationrelay/best-practices
- Twilio voice: twilio.com/docs/voice/twiml/dial, twilio.com/docs/voice/twiml/recording, twilio.com/docs/voice/api/recording, twilio.com/docs/usage/webhooks/webhooks-connection-overrides, twilio.com/docs/usage/webhooks/webhooks-security
- Twilio numbers: twilio.com/docs/phone-numbers/api/availablephonenumber-resource, twilio.com/docs/phone-numbers/api/incomingphonenumber-resource, twilio.com/docs/phone-numbers/regulatory/api/bundles, twilio.com/docs/voice/trusted-calling-with-shakenstir
- Vercel WebSockets: vercel.com/docs/functions/websockets
- Telnyx: developers.telnyx.com/docs/voice/programmable-voice/conversation-relay, developers.telnyx.com/api-reference/call-commands/transfer-call, developers.telnyx.com/docs/numbers/phone-numbers/requirement-groups
- Vapi: docs.vapi.ai/customization/custom-llm/using-your-server; Retell: docs.retellai.com/api-references/llm-websocket
- Law:
  - FCC 24-17: docs.fcc.gov/public/attachments/FCC-24-17A1.pdf
  - California Penal Code §632: leginfo.legislature.ca.gov
  - GDPR: eur-lex.europa.eu (Regulation 2016/679)
  - EU AI Act Article 50: ai-act-service-desk.ec.europa.eu/en/ai-act/article-50
  - ICO: lawful basis and PECR telephone marketing (ico.org.uk)
