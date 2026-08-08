# Ask your server

A chat box in the dashboard: *why is the blog slow* · *restart the api* · *what broke
overnight* · *back up the shop project*. It drives the same tools
[coding agents already use](mcp.md), so anything an agent can do from your editor,
you can ask for in a sentence from the dashboard.

## Whose brain

Yours. The assistant runs on **your own key** (Anthropic or OpenAI), or on **an
Ollama running on this very box**, or anything else that speaks the OpenAI shape.
The key is encrypted at rest, is never shown again, and is sent nowhere except the
address you configured; which is also why only an owner can change that address.
Derailed ships no AI of its own and phones nothing home: no key, no assistant, no
quiet fallback.

## What it may do

The same things you may, and nothing else:

- **Reads run immediately, as you.** Every tool call is an ordinary API request made
  with your own session: the role table applies, the audit log records it, and a
  viewer's assistant sees exactly what a viewer sees. When the API refuses, the
  assistant is told the refusal, not a way around it.
- **Writes wait for your press.** Anything that would change the server, a deploy, a
  restart, a new database, a command, comes back as a card with the exact tool and
  arguments on it, and runs only when you press **Run it**. Declining is information
  too: the model is told you looked and said no.
- **An unrecognised tool counts as a write.** The list of safe reads is a list; a
  tool added next Tuesday waits behind the button until somebody says otherwise.

## The honest limits

- Answers are as good as the model behind them. The tools ground it, and the system
  prompt tells it never to invent a status it did not read, but a small local model
  will be wrong more often than a frontier one.
- The rules-based [failure explainer](troubleshooting.md) is still there and still
  free: it answers "why did this deploy fail" without any key at all. Ask is the
  version that can go look around first.
- Conversations are not stored on the server. The transcript lives in the page; a
  refresh is a new conversation.
