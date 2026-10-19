-- Built-in skills for every employee category (Phase 13).
--
-- Skills are reusable working procedures: the shared runtime adds the
-- procedure of each skill an employee has to its system prompt. The source of
-- truth is src/modules/employees/domain/skills.ts; only skills whose
-- capabilities are built are seeded here (skills that need email, calendars,
-- web research, telephony and so on stay out until those exist), and
-- tests/employees/templates.test.ts checks this file against the catalog.
--
-- A shipped skill's procedure never changes (saved employee versions refer to
-- skills by key): a new procedure gets a new key in a new migration.

-- 1. Seed and refresh the built-in rows ---------------------------------------

insert into public.skills (organization_id, key, name, description, category, instructions, tool_keys, status, created_by) values
  (null, 'knowledge.search', 'Knowledge search', 'Answer questions from the organization’s knowledge base with citations.', 'research',
   '- Search the knowledge base before answering anything about the business, its products, prices or policies.
- Cite every fact with its source marker, like [S1].
- If the search finds nothing relevant or the evidence is weak, say so instead of answering from general knowledge.',
   '{knowledge.search}', 'active', null),
  (null, 'crm.records', 'CRM record keeping', 'Find contacts in HubSpot, create or update them, and add notes.', 'sales',
   '- Search HubSpot by email before creating a contact; update the existing contact instead of creating a duplicate.
- Change only the fields the request gives you; never clear a field you weren’t asked to clear.
- Add a short note to the contact describing what changed and why.',
   '{hubspot.contacts.search,hubspot.contacts.upsert,hubspot.notes.create}', 'active', null),
  (null, 'chat.messaging', 'Team chat messaging', 'List Slack channels and post messages to them.', 'communication',
   '- Post only to the channel the request names; list the channels to find it, and ask if none is named.
- Keep messages short: what happened, what it means, and who needs to do what.',
   '{slack.channels.list,slack.messages.post}', 'active', null),
  (null, 'sales.lead_qualification', 'Lead qualification', 'Qualify a lead against the ideal-customer criteria in the knowledge base.', 'sales',
   '- Find the qualification criteria (ideal customer, budget, need, timing) in the knowledge base; if there are none, escalate instead of inventing them.
- Check the lead’s details from the request and HubSpot against each criterion.
- Give a verdict of qualified, not qualified or needs more information, with one reason per criterion and the facts it rests on.',
   '{knowledge.search,hubspot.contacts.search}', 'active', null),
  (null, 'sales.follow_up_drafting', 'Follow-up drafting', 'Prepare follow-up messages in the company’s voice for a person to review and send.', 'sales',
   '- Use the brand voice and product facts from the knowledge base and the interaction history from the request or HubSpot.
- Write the follow-up in your reply as a draft, with a subject line and a clear next step.
- Never include prices, discounts or dates that aren’t in the knowledge base, and never say the message was sent.',
   '{knowledge.search,hubspot.contacts.search}', 'active', null),
  (null, 'support.inquiry_classification', 'Inquiry classification', 'Classify a customer inquiry by topic, urgency and whether a person must handle it.', 'support',
   '- Classify the inquiry: topic (from the categories in the knowledge base if there are any), urgency (low, normal, urgent) and sentiment.
- Mark it for a person when it involves a complaint, a refund, a legal or safety issue, or a customer who asks for a person.
- Give the classification first, then one sentence explaining it.',
   '{knowledge.search}', 'active', null),
  (null, 'support.cited_answers', 'Knowledge-based answers', 'Draft customer answers only from the knowledge base, with sources.', 'support',
   '- Search the knowledge base and answer only from what you find, citing each source like [S1].
- Write the answer the customer would read, in the brand voice, and keep internal notes separate.
- If the knowledge base doesn’t answer the question, say so and escalate; never guess a policy, price or date.',
   '{knowledge.search}', 'active', null),
  (null, 'support.escalation', 'Escalation to the team', 'Hand an inquiry to the team in Slack with everything they need.', 'support',
   '- Post the escalation to the channel the request names: the customer’s question, what the knowledge base says, what is missing and how urgent it is.
- Never include passwords, payment details or other sensitive data in the message.',
   '{slack.messages.post}', 'active', null),
  (null, 'marketing.content_drafting', 'Content drafting', 'Draft posts, emails and pages in the brand voice from the knowledge base.', 'marketing',
   '- Find the brand voice, products and audience in the knowledge base before writing.
- Draft the content in your reply in the requested format and length, ready for a person to edit.
- Use only claims the knowledge base supports, cite them, and mark anything that needs checking.',
   '{knowledge.search}', 'active', null),
  (null, 'marketing.campaign_planning', 'Campaign planning', 'Plan a campaign: goal, audience, message, channels, schedule and how success is measured.', 'marketing',
   '- Start from the goals and audiences in the business context; ask if the request doesn’t say which goal the campaign serves.
- Produce a plan with: goal, audience, key message, channels, a dated schedule, budget assumptions and the measures of success.
- Mark every assumption as an assumption.',
   '{knowledge.search}', 'active', null),
  (null, 'marketing.publishing_preparation', 'Publishing preparation', 'Prepare content for publishing: final copy, checks and a hand-off note.', 'marketing',
   '- Check the copy against the brand voice and the knowledge base, and list anything unverified.
- Give the final copy per channel, its intended date and a checklist for the person who publishes it.
- Post the hand-off to Slack only when the request names a channel.',
   '{knowledge.search,slack.messages.post}', 'active', null),
  (null, 'marketing.performance_analysis', 'Performance analysis', 'Analyze campaign results provided in the request against the campaign’s goals.', 'marketing',
   '- Use only the figures given in the request or the knowledge base; say which figures are missing.
- Compare results with the goals, show each calculation, and separate what the data shows from what you suspect.',
   '{knowledge.search}', 'active', null),
  (null, 'analytics.kpi_reporting', 'KPI reporting', 'Report KPIs against their targets from approved data.', 'analytics',
   '- Use the KPI definitions and targets in the business context; use only data provided in the request or the knowledge base.
- For each KPI give the value, the target, the difference and the period, and show how each value was calculated.
- List missing or inconsistent data instead of filling it in.',
   '{knowledge.search}', 'active', null),
  (null, 'analytics.trends_and_anomalies', 'Trend and anomaly detection', 'Find trends and unusual values in data, and say how sure the finding is.', 'analytics',
   '- Describe the method you used (for example period-over-period change or distance from the average).
- Report each trend or anomaly with the data points behind it and how confident you are; small samples are low confidence.
- Post an alert to Slack only when the request names a channel and the anomaly meets the threshold it gives.',
   '{knowledge.search,slack.messages.post}', 'active', null),
  (null, 'analytics.recommendations', 'Evidence-based recommendations', 'Recommend actions, each tied to the evidence behind it.', 'analytics',
   '- Give each recommendation with the data point or source that supports it and the expected effect.
- Say what would change your recommendation, and never present a guess as a finding.',
   '{knowledge.search}', 'active', null),
  (null, 'operations.document_processing', 'Document processing', 'Extract structured fields from documents in the knowledge base or the request.', 'operations',
   '- Extract exactly the fields the request asks for; give each value with the document and passage it came from.
- Write “not found” for a field the document doesn’t contain, and flag values that look inconsistent.',
   '{knowledge.search}', 'active', null),
  (null, 'operations.record_sync', 'CRM data synchronization', 'Bring HubSpot contacts in line with records provided in the request.', 'operations',
   '- For each record, search HubSpot by email and compare field by field.
- Update only the fields that differ, never delete data, and report every record as updated, unchanged or skipped with the reason.
- Stop and escalate if more than the number of records the request allows would change.',
   '{hubspot.contacts.search,hubspot.contacts.upsert}', 'active', null),
  (null, 'operations.status_updates', 'Status updates', 'Turn notes into a status update and post it to the named channel.', 'operations',
   '- Summarize in under 150 words: what happened, what is blocked, and who needs to do what by when.
- Post it to the Slack channel the request names.',
   '{slack.channels.list,slack.messages.post}', 'active', null),
  (null, 'assistant.meeting_preparation', 'Meeting preparation', 'Prepare a meeting brief from the CRM, the knowledge base and the notes provided.', 'productivity',
   '- Gather what is known about the attendees and their company from HubSpot and the knowledge base.
- Write a one-page brief: purpose, attendees, history, open questions and the decisions needed, with sources.',
   '{knowledge.search,hubspot.contacts.search}', 'active', null),
  (null, 'assistant.summaries', 'Summaries and action items', 'Summarize notes or threads into decisions, action items and owners.', 'productivity',
   '- Separate decisions, action items (with owner and due date when given) and open questions.
- Keep names and dates exactly as written in the source; write “no owner” rather than guessing one.',
   '{}', 'active', null),
  (null, 'assistant.reminders', 'Reminders in Slack', 'Post reminders to the named Slack channel; a scheduled workflow decides when.', 'productivity',
   '- Post a short reminder with the task, the owner and the due date to the channel the request names.',
   '{slack.messages.post}', 'active', null),
  (null, 'finance.expense_classification', 'Expense classification', 'Classify expenses into the categories in the knowledge base, for a person to post.', 'finance',
   '- Use only the expense categories and rules in the knowledge base; if there are none, escalate.
- Give each expense a category, the rule that applies and a confidence; send anything below high confidence to a person.
- Never change an amount, and never mark anything as approved, paid or posted.',
   '{knowledge.search}', 'active', null),
  (null, 'finance.invoice_preparation', 'Invoice preparation', 'Prepare an invoice draft from the details provided, for a person to check and issue.', 'finance',
   '- Use only the customer, items, quantities, prices and terms given in the request or the knowledge base.
- Show each line total and the totals with the calculation; list anything missing (tax rate, terms, purchase order).
- Label the result as a draft; you can’t issue, send or record invoices.',
   '{knowledge.search}', 'active', null),
  (null, 'finance.reporting', 'Finance reporting', 'Summarize financial figures provided in the request, with every calculation shown.', 'finance',
   '- Use only the figures provided; show every calculation and the period it covers.
- Flag figures that don’t reconcile instead of adjusting them.',
   '{}', 'active', null),
  (null, 'hr.onboarding_checklist', 'Onboarding checklists', 'Build a new hire’s onboarding checklist from the documented procedures.', 'hr',
   '- Use the onboarding procedures in the knowledge base for the person’s department and role.
- Give a dated checklist with an owner for each item, citing the procedure it comes from.
- Never include salary, health or other personal data in the checklist.',
   '{knowledge.search}', 'active', null),
  (null, 'hr.policy_answers', 'Internal policy answers', 'Answer employees’ questions from internal policies, with sources.', 'hr',
   '- Answer only from the policies in the knowledge base, citing each one.
- Hand questions about pay, health, discipline, complaints or legal matters to HR instead of answering them.',
   '{knowledge.search}', 'active', null),
  (null, 'research.source_collection', 'Source collection', 'Collect the relevant sources from the knowledge base and the request, and rate them.', 'research',
   '- Search the knowledge base with several phrasings and list each relevant source with what it covers and its date.
- Say which questions no source answers.',
   '{knowledge.search}', 'active', null),
  (null, 'research.company_profile', 'Company research', 'Profile a company from HubSpot, the knowledge base and the material provided.', 'research',
   '- Gather what HubSpot and the knowledge base hold about the company and its contacts.
- Write a profile (what they do, size, relationship history, open opportunities) with a source for each fact and a list of unknowns.',
   '{knowledge.search,hubspot.contacts.search}', 'active', null),
  (null, 'research.competitive_analysis', 'Competitive analysis', 'Compare competitors on chosen criteria using the sources available.', 'research',
   '- Agree the criteria from the request; compare each competitor on each criterion in a table.
- Cite a source for every cell, and write “unknown” where no source covers it.',
   '{knowledge.search}', 'active', null),
  (null, 'research.structured_summary', 'Structured summaries', 'Summarize findings as key points, evidence, gaps and next steps.', 'research',
   '- Structure the summary as: question, key findings (each with sources), confidence, gaps and suggested next steps.
- Keep facts and interpretation separate.',
   '{}', 'active', null)
on conflict (organization_id, key) do update
set name = excluded.name,
    description = excluded.description,
    category = excluded.category,
    instructions = excluded.instructions,
    tool_keys = excluded.tool_keys,
    status = excluded.status;

-- 2. Built-in keys are reserved ------------------------------------------------
--
-- The runtime looks built-in procedures up by key, so a workspace's own skill
-- must not reuse one (it would run the built-in procedure under another name).

create function private.check_skill_key_reserved()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is not null and exists (
    select 1 from public.skills as s where s.organization_id is null and s.key = new.key
  ) then
    raise exception 'skill key % is reserved for a built-in skill', new.key using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger check_skill_key_reserved before insert or update of key, organization_id on public.skills
  for each row execute function private.check_skill_key_reserved();
