# AgentKib DeepSeek Harness bridge

First-party DeepSeek Harness (DSH) bundle for DSH **0.2.1-rc.5 or later** (`engines.dsh`
`>=0.2.1-rc.5 <0.3.0`), bridge protocol **1**, plugin **0.2.0**. It connects the sessions of a
running DSH to AgentKib on the same computer. It never starts a second executor, never writes
the session log itself and never calls a model: every action goes through DSH's own services.

## Install

Install the bundle into the profile you run, then restart DSH. AgentKib shows the exact command
with the path of the copy it ships:

```sh
dsh plugin --profile web add '<AgentKib resources>/dsh-bridge'
```

A bundle added while DSH runs takes effect on the next start. DSH Desktop's reserved `desktop`
profile is managed through DSH Desktop's own plugin page. For development, mount this directory
for one run without installing it:

```sh
dsh --profile web --patch <file containing an insert row whose name is this index.js>
```

## How it connects

While AgentKib runs, its Runtime writes `<AgentKib home>/dsh-bridge/discovery-v1.json` with mode
0600, holding a private Unix socket path and a key that rotates with every Runtime start. The
plugin reads that file (`AGENTKIB_HOME`, then `~/.agentkib`, then `~/.agentkib-dev`), registers
with every Runtime it finds, and then:

- reports DSH's own session list, and the live state of attached agents (status, open turn,
  queued prompts, streaming text);
- serves bounded history pages from `sessionQuery.observeSession`;
- runs commands from AgentKib through `sessionController`: `prompt` (queue or steer, with
  AgentKib's request ID as DSH's `requestId`, so DSH keeps it on the message and never takes
  the same request twice), `updateQueue` and `cancel` (which keeps the queue), `rename`, `fork`,
  `create`, `modelCatalog` and `selectModel`;
- archives and unarchives through the workspace controller, and follows its archive set so
  archives made in DSH's own window reach AgentKib too;
- answers verification requests from that record when a result was lost.

Only human prompts, assistant text and tool summaries leave DSH. Injected context, hidden
reasoning, system prompts and provider frames stay in DSH.

## Approvals and questions

For sessions in an AgentKib workspace, the plugin listens first on `approval/request` and
`user-questions/request`. DSH's `next()` takes no arguments, so the plugin dispatches the
request again with a signal it owns: DSH's own UI shows it as before, and AgentKib shows it
too. The first answer wins. When AgentKib answers, the plugin aborts its signal, and DSH's
gateway withdraws the card from its UI; when DSH's UI answers, AgentKib withdraws its card.
Without a connected Runtime, or for other sessions, the plugin passes the request on unchanged.

## Compatibility

`compatibility.js` is the single policy shared with the Runtime. Add a version to
`verifiedDshVersions` only after recording real-DSH acceptance evidence in QA. A newer
unverified DSH still connects; AgentKib shows the version as unverified.
