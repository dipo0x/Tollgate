# Bring your own agent

An agent in Tollgate is a **chat room with a name** and a **budget**. Somebody has to answer it. There are two ways, and you choose when you
make the chat in the app (**Agents → New chat → Who answers**) or change it later (**the agent's page → Answered by**).

| | Who answers | What you set up | Keys live |
| --- | --- | --- | --- |
| **A brain on your computer** | `pnpm live:app` (the agent host) | nothing, once the brain is in `.env` | on your computer only |
| **My own agent** | a program you run (Claude, Grok, ChatGPT, a script, an agent on localhost) | copy the key the app shows once | in your program |

Either way the agent **cannot spend by itself**. It can only ask Tollgate to pay. The twelve checks run, and for an agent made on the phone
every payment then waits for your yes (hold, then Face ID). A reply is only words.

## A. A brain on your computer

1. Put the key for the brain you want in `.env` (see `.env.example`):

   | Brain | Set | Notes |
   | --- | --- | --- |
   | Claude | `ANTHROPIC_API_KEY` | model `AGENT_MODEL` |
   | Local model | nothing, if Ollama is running | model `AGENT_OLLAMA_MODEL` |
   | Grok | `XAI_API_KEY` | model `XAI_MODEL` (default `grok-4`: set the one your account has) |
   | ChatGPT | `OPENAI_API_KEY` | model `OPENAI_MODEL` |
   | NEAR AI Cloud | `NEARAI_API_KEY` and `NEARAI_MODEL` | no default model |
   | Any OpenAI-compatible server | `AGENT_BRAINS` | LM Studio, vLLM, llama.cpp, a script on localhost |

   A server of your own, with or without a key:

   ```
   AGENT_BRAINS=[{"id":"mine","label":"My agent","baseUrl":"http://localhost:8000/v1","model":"my-model","keyEnv":"MINE_KEY"}]
   MINE_KEY=...
   ```

   `keyEnv` is the **name** of the variable that holds the key, so no secret is written in the list. It must speak the OpenAI "chat completions"
   API with tool calling (`POST {baseUrl}/chat/completions`).

2. `pnpm live:app`. It prints `Brains  Claude (...), Grok (...)` and any setting it could not use, with the reason.
3. In the app: **Agents → New chat**. The brains you set up are listed under **Who answers**. Pick one, set a budget, **Start chat**.

The phone is only ever told a brain's id, its label and its model name. Keys and addresses never leave your computer.

## B. My own agent

Choose **My own agent** when you make the chat. The app shows a key **once** and three things to copy:

- **Instructions for an AI agent**: paste into Claude, Grok, ChatGPT or your own agent and it knows the whole protocol.
- **Starter program**: Node 22, no packages. Replace one function with your agent.
- **Two web requests**: to try it by hand.

The protocol is four calls, all with `Authorization: Bearer <key>`:

```
POST /v1/tasks/next                 -> { "task": null }  or  { "task": { "id", "messages": [{ "from", "text" }] } }
POST /v1/tasks/<id>/reply           { "text": "...", "status": "done" | "working" | "failed" }
POST /v1/tasks/<id>/alive           (every 20 s while a job runs, or the chat shows it as stalled after 90 s)
GET  /v1/tasks/history              the whole chat of this agent's name, for context
```

To pay: `GET /v1/services/planner` lists the shops you may pay (structured fields only), then `POST /v1/authorize` with the shop's bill; the
answer is `ALLOW`, `NEEDS_APPROVAL` or `DENY`. With `ALLOW`, `POST /v1/payments/<decisionId>/sign`. The TypeScript SDK (`trytollgate`) does
this for you: `createTollgate({ gatewayUrl, agentToken, mandateId, payer, rail }).fetch(url)`.

It works from anywhere your phone's gateway address reaches: a script on the same computer (use the address the app shows), a server, or an
agent platform that can make web requests. A lost key: **the agent's page → Get a new key**. The old one stops at once.

### Check it by hand

```
curl -s -X POST http://YOUR-COMPUTER.local:8796/v1/tasks/next -H "Authorization: Bearer <key>"
```

You should see `{"task":null}` until you send a message from the chat, then the message.

## What this does not do

- Tollgate cannot make your own agent honest. It can only refuse what the mandate and the twelve checks refuse, and ask you first.
- A brain from your computer answers in words and uses the same few tools as any other. It cannot pay, change its budget or its rules.
- If your computer is off, hosted chats wait: the app says **Computer offline**, and your messages are answered when it is back on.
