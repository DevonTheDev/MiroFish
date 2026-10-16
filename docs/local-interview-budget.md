# Local live-interview request budgets

Pinned OASIS assembles an interview by prepending a persona copy to the agent's bounded memory and appending the complete interview prompt. With the ordinary Twitter and Reddit templates, the first two messages can be identical complete system messages. The memory budget is checked before the additional persona and interview prompt are appended.

For an otherwise oversized local interview, the local adapter can remove only the first of those exact duplicates when the complete remaining request fits `LOCAL_MAX_INPUT_CHARS`. It sizes both envelopes with the gateway's actual normalization, model name, output cap and reasoning setting. An exact fit is allowed. A candidate that remains oversized follows the existing refusal path.

The change preserves every retained message object, the full question and selected conversation history, the live memory, selected agent and model, and the original prompt saved with the interview response. It preserves the inherited semaphore, context read, retries and persistence. Removing repetition can change emphasis and model output; this is not a model-quality or output-equivalence guarantee.

Eligibility is deliberately narrow: the dispatched ordinary agent and manager, the exact local model created by the factory, the same asyncio task, plain JSON message values, tools omitted, and the normal configuration containing only a positive integer `max_tokens`. The owner, system, memory and backend bindings must still match when the request is made. Nested ineligible interviews mask an outer interview's scope, and cleanup restores the scope even on cancellation or failure.

Already-fitting requests, cloud use, generic or direct calls, custom implementations, partial persona copies, tool-bearing requests and unsupported options keep their existing path. Pinned `TextPrompt` custom-template values are also unchanged: they are string subclasses outside this version's supported plain-message envelope. Exact plain-string duplicates can qualify; that does not imply support for the pinned custom-template constructor path.

The child process configuration must match the serving gateway, as before. The gateway remains authoritative. This repair establishes configured request eligibility only; it does not enlarge the model's actual context window or establish hardware, memory-use, latency or successful live-interview results.

The focused tests use retained pinned method bodies and real OpenAI/httpx serialization with an in-process transport. They do not require a full OASIS/CAMEL installation or a listening model server. This isolated seam does not replace optional full-dependency or live-simulation testing.
