/**
 * "Connect your own agent": everything an outside agent needs, as text to copy. It works for any agent that can make web requests:
 * Claude, Grok, ChatGPT, something built from scratch, a script on localhost, an agent on the NEAR AI Agent Market's side.
 *
 * The agent never gets more than its mandate: the key lets it collect this chat's messages, answer them, and ASK to pay. Every payment
 * goes through Tollgate's twelve checks, and the owner's yes on the phone, before anything is signed. A reply is only words.
 */
export type KitInput = { url: string; key: string; name: string; mandateId: string }
export type Kit = { prompt: string; curl: string; code: string }

export function connectKit({ url, key, name, mandateId }: KitInput): Kit {
  const base = url.replace(/\/+$/, '')
  const prompt = `You are "${name}", an agent that answers one chat in Tollgate and may ask Tollgate to pay for things. Tollgate is a payment gateway: you never hold money or keys, and nothing is paid unless Tollgate allows it and the owner approves on their phone.

Gateway: ${base}
Key: ${key}   (send it as the header  Authorization: Bearer <key>  on every call)
Your mandate id: ${mandateId}

Work in a loop:
1. POST ${base}/v1/tasks/next  (no body). The answer is {"task": null} when nothing is waiting (wait a second, ask again), or {"task": {"id": "...", "messages": [{"from": "owner", "text": "..."}]}}.
2. Work out your reply to the owner's latest message. Earlier messages of this chat: GET ${base}/v1/tasks/history.
3. Answer: POST ${base}/v1/tasks/<id>/reply  with JSON {"text": "your words", "status": "done"}. Use "status": "working" for progress notes and "failed" if you could not do it. While a job takes longer than 20 seconds, POST ${base}/v1/tasks/<id>/alive every 20 seconds.
4. Shops you may pay: GET ${base}/v1/services/planner. To pay one, POST ${base}/v1/authorize with {"mandateId": "${mandateId}", "host": "<shop host>", "purpose": "<why>", "challenge": <the shop's 402 body>, "payer": "<payer address>"}. The answer is ALLOW (then sign with POST ${base}/v1/payments/<decisionId>/sign), NEEDS_APPROVAL (the owner decides on their phone; ask again every few seconds) or DENY (do not pay; tell the owner why in one sentence).

Rules: only say something was paid when Tollgate's answer says so. Never put the key in a message. You cannot change your own budget or rules.`
  const curl = `# 1. Ask for the next message
curl -s -X POST ${base}/v1/tasks/next -H "Authorization: Bearer ${key}"

# 2. Answer it (use the task id from step 1)
curl -s -X POST ${base}/v1/tasks/TASK_ID/reply \\
  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
  -d '{"text":"Hello! What can I get for you?","status":"done"}'`
  const code = `// Node 22+, no packages. Answers every message with a fixed line: replace answer() with your agent.
const GW = '${base}', KEY = '${key}'
const call = (path, body) => fetch(GW + path, { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json())
const answer = async messages => 'You said: ' + messages.at(-1).text
for (;;) {
  const { task } = await call('/v1/tasks/next')
  if (!task) { await new Promise(r => setTimeout(r, 1000)); continue }
  await call('/v1/tasks/' + task.id + '/reply', { text: await answer(task.messages), status: 'done' })
}`
  return { prompt, curl, code }
}
