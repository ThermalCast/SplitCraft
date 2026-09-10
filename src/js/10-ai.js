  // 10-ai.js — Provider-agnostic AI client (aiChat), plan status log
  function clearPlanStatusLog() {
    document.getElementById('plan-status-log').innerHTML = '';
    document.getElementById('plan-status-log-card').style.display = 'none';
  }
  function logPlanStatus(msg) {
    const card = document.getElementById('plan-status-log-card');
    const log = document.getElementById('plan-status-log');
    card.style.display = 'block';
    const line = document.createElement('div');
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${msg}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // =========================================================================
  // AI client — provider-agnostic, one entry point.
  //
  // Extracted so the plan request and the starting-weight request share it.
  // Duplicating it would have meant two copies of the SSE parsing, the idle
  // and hard-cap timeouts, the reasoning-vs-content distinction and the four
  // empty-response diagnoses — and the second copy is exactly where the next
  // "empty response" mystery would have come from.
  //
  // The registry below is the extension point for adding another AI service:
  // a new entry here, nothing changed in aiChat() itself. Every entry must
  // speak the OpenAI-compatible SSE frame shape aiChat() parses further down
  // (`choices[0].delta.content` / `.finish_reason`, `usage`, `data: {...}` /
  // `data: [DONE]` lines) — a provider whose stream doesn't match that shape
  // would need a `parseFrame` hook added here rather than slotting straight
  // in. OpenRouter is the only shipped provider; there is no settings UI to
  // pick another one yet, and both AI callers below pass nothing for
  // `provider`, so they get it by default.
  // =========================================================================
  const AI_PROVIDERS = {
    openrouter: {
      name: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      headers: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': location.origin, 'X-Title': 'SplitCraft' }),
      // REASONING TOKENS COUNT AGAINST max_tokens. That is the whole reason
      // callers pass a generous number: max_tokens caps *completion* tokens,
      // and on a reasoning model the thinking is completion tokens. A week's
      // plan is about 1.5k tokens of JSON, so 4000 looked generous — right up
      // until a reasoning model spent all 4000 thinking, got cut off before
      // writing a single character of answer, and reported as "the model
      // returned an empty response".
      //
      // Raising the ceiling does not raise the bill on its own: models stop
      // when they are done, and this only decides when they get guillotined.
      // The hard 240s cap and the idle timeout (below) are what stop a
      // genuinely runaway request.
      body: ({ model, system, user, maxTokens }) => ({
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      errorMap: { 400: 'Bad request — check the model name.', 401: 'Invalid API key.', 402: 'Insufficient OpenRouter credits.', 403: 'Request was flagged by moderation.' }
    }
  };
  function aiProvider(id) { return AI_PROVIDERS[id] || AI_PROVIDERS.openrouter; }

  // Returns the model's message content, already trimmed and stripped of
  // markdown fences. Throws with a specific, actionable message otherwise;
  // callers do their own JSON.parse.
  async function aiChat({ provider = 'openrouter', apiKey, model, system, user, maxTokens = 16000 }) {
    const cfg = aiProvider(provider);
    // STREAMED, and the timeout is on INACTIVITY rather than total duration.
    //
    // The previous version was a plain non-streaming fetch with a flat 60s
    // abort. `fetch` doesn't resolve until the whole body has arrived, so a
    // model that was generating perfectly well but slowly got killed at
    // exactly 60s, with the partial answer thrown away and nothing to show
    // for the wait. Reasoning models blow past 60s routinely — the reasoning
    // tokens are generation time — so "timed out" was reporting a healthy
    // request as a failure.
    //
    // Streaming fixes the diagnosis as much as the limit: progress is
    // visible, an idle connection is distinguishable from a slow one, and the
    // request is only aborted when nothing has arrived for IDLE_MS. The
    // overall cap stays as a backstop against a genuinely stuck stream.
    //
    // Note OpenRouter sends `: OPENROUTER PROCESSING` keep-alive comments
    // while a model is thinking. Those count as activity — correctly, since
    // they prove the request is alive — which is exactly why the hard cap
    // still has to exist.
    logPlanStatus('Sending request to OpenRouter\u2026');
    const controller = new AbortController();
    const HARD_CAP_MS = 240000;
    const IDLE_MS = 60000;
    const startTs = Date.now();
    let lastActivityTs = Date.now();
    let abortReason = null;
    const abortWith = (reason) => { abortReason = reason; controller.abort(); };

    const timeoutId = setTimeout(() => abortWith('cap'), HARD_CAP_MS);
    const idleCheck = setInterval(() => {
      if (Date.now() - lastActivityTs > IDLE_MS) abortWith('idle');
    }, 2000);

    let streamedChars = 0;
    // Diagnostics. Every one of these exists because "the model returned an
    // empty response" was a dead end: it named the symptom and reported
    // nothing that could distinguish its causes.
    let reasoningChars = 0;     // thinking tokens — arriving, but not the answer
    let finishReason = null;    // 'stop' | 'length' | 'content_filter' | ...
    let usage = null;           // token counts, when the provider sends them
    let lastFrame = null;       // raw JSON of the final frame, for the log
    // Three distinct states, because they were previously two and the missing
    // one was the interesting case. "Still waiting" used to cover both a dead
    // connection AND a reasoning model streaming thousands of thinking tokens
    // \u2014 so a log full of "the model may be thinking" was literally true and
    // completely useless, since it said the same thing either way.
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startTs) / 1000);
      if (streamedChars) {
        logPlanStatus(`Receiving\u2026 ${streamedChars} characters after ${secs}s.`);
      } else if (reasoningChars) {
        logPlanStatus(`Thinking\u2026 ${reasoningChars} characters of reasoning after ${secs}s, no answer yet.`);
      } else {
        logPlanStatus(`Still waiting\u2026 (${secs}s elapsed, nothing received yet)`);
      }
    }, 8000);

    let res, content = '';
    try {
      res = await fetch(cfg.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: cfg.headers(apiKey),
        body: JSON.stringify(cfg.body({ model, system, user, maxTokens }))
      });
      logPlanStatus(`Response headers: HTTP ${res.status} ${res.statusText}`);

      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.json();
          detail = (errBody && errBody.error && errBody.error.message) || JSON.stringify(errBody);
        } catch (e) { /* body wasn't JSON */ }
        if (detail) logPlanStatus(`Error detail from OpenRouter: ${detail}`);
        const label = cfg.errorMap[res.status] || `OpenRouter error (${res.status})`;
        throw new Error(detail ? `${label} \u2014 ${detail}` : label);
      }
      logPlanStatus('Streaming response\u2026');
      if (!res.body) {
        // No readable stream (very old browser, or a proxy that buffered it).
        // The response is then a normal non-streamed JSON body.
        const whole = await res.json();
        content = (whole.choices && whole.choices[0] && whole.choices[0].message && whole.choices[0].message.content) || '';
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivityTs = Date.now();
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are newline-delimited; the last fragment may be a
          // partial line, so it stays in the buffer for the next chunk.
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            // ':' prefixed lines are SSE comments (OpenRouter's keep-alives).
            if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const frame = JSON.parse(payload);
              if (frame.error) throw new Error(frame.error.message || 'Model returned an error mid-stream.');
              lastFrame = payload;
              if (frame.usage) usage = frame.usage;
              const choice = frame.choices && frame.choices[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta || {};
              if (delta.content) { content += delta.content; streamedChars = content.length; }
              // REASONING TOKENS ARE NOT CONTENT, and until this existed the
              // difference was invisible. A reasoning model streams its
              // thinking as `delta.reasoning` (some providers spell it
              // `reasoning_content`) and only then starts emitting
              // `delta.content`. Reading only `content`, a run that thought
              // hard and got cut off mid-thought looked identical to a model
              // that returned nothing at all: bytes arriving steadily for
              // half a minute — enough to keep the idle-abort happy — then
              // "Stream complete: 0 characters" and a shrug.
              //
              // Tracked separately rather than concatenated: this is the
              // model's scratch work, not its answer, and appending it to
              // `content` would feed prose to JSON.parse().
              const think = delta.reasoning || delta.reasoning_content;
              if (typeof think === 'string') reasoningChars += think.length;
              // Non-streaming shape arriving on a streamed endpoint. Some
              // providers (and some proxies that buffer) send the whole
              // message on the final frame instead of deltas; without this,
              // the answer was sitting right there and being dropped.
              if (choice.message && choice.message.content && !content) {
                content += choice.message.content;
                streamedChars = content.length;
              }
            } catch (e) {
              // A frame that fails to parse is a truncated keep-alive or a
              // partial line, not a failure -- but a real mid-stream error
              // above must not be swallowed.
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
      }
      logPlanStatus(`Stream complete: ${content.length} characters in ${Math.round((Date.now() - startTs) / 1000)}s`
        + `${reasoningChars ? `, plus ${reasoningChars} characters of reasoning` : ''}`
        + `${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
      if (usage) {
        const r = usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens;
        logPlanStatus(`Tokens: ${usage.prompt_tokens ?? '?'} in, ${usage.completion_tokens ?? '?'} out`
          + `${r != null ? ` (${r} of them reasoning)` : ''}.`);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        const secs = Math.round((Date.now() - startTs) / 1000);
        if (abortReason === 'idle') {
          logPlanStatus(`Aborted: nothing received for ${IDLE_MS / 1000}s (${secs}s total, ${streamedChars} characters).`);
          throw new Error(`OpenRouter stopped responding \u2014 nothing arrived for ${IDLE_MS / 1000}s. The connection may have dropped, or the model may be overloaded. Try again.`);
        }
        logPlanStatus(`Aborted at the ${HARD_CAP_MS / 1000}s cap (${streamedChars} characters received).`);
        throw new Error(`The model was still going after ${HARD_CAP_MS / 1000}s (${streamedChars} characters received) \u2014 it's likely a slow reasoning model. Pick a faster one in Settings, or try again.`);
      }
      if (err instanceof TypeError) {
        logPlanStatus(`Network error: ${err.message}`);
        throw new Error(`Could not reach OpenRouter (${err.message}). Check your internet connection, or whether an ad-blocker/extension is blocking requests to openrouter.ai.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      clearInterval(idleCheck);
      clearInterval(heartbeat);
    }

    // `content` was accumulated from the stream above.
    content = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();

    // AN EMPTY ANSWER HAS SEVERAL CAUSES AND THEY NEED DIFFERENT ACTIONS.
    //
    // This used to be one sentence \u2014 "try again, or try a different model" \u2014
    // which is advice for the one cause where retrying helps, given
    // indiscriminately for all of them. Retrying a model that burned its whole
    // token budget thinking will do exactly the same thing the second time,
    // which is precisely what "twice in a row" looks like.
    if (!content) {
      if (lastFrame) logPlanStatus(`Last frame received: ${lastFrame.slice(0, 300)}`);
      const spent = usage && usage.completion_tokens;
      const thought = reasoningChars || (usage && usage.completion_tokens_details
        && usage.completion_tokens_details.reasoning_tokens);

      // Truncated. The giveaway is finish_reason 'length': the model was
      // still going when it hit the ceiling.
      if (finishReason === 'length') {
        throw new Error(
          `The model hit the ${maxTokens}-token limit before it wrote any answer`
          + `${thought ? `, spending it all on reasoning (${thought} characters of it)` : ''}. `
          + `This is a reasoning model working through the problem out loud and running out of room. `
          + `Pick a non-reasoning model in Settings \u2014 for structured JSON like this, a fast instruct model is both cheaper and more reliable.`);
      }
      // Finished cleanly, thought a lot, said nothing. Retrying is a coin flip
      // at best, so don't suggest it as though it were a fix.
      if (thought) {
        throw new Error(
          `The model produced ${thought} characters of reasoning and then finished without writing an answer`
          + `${finishReason ? ` (finish_reason: ${finishReason})` : ''}. `
          + `Some reasoning models don't reliably emit content after thinking. Try a non-reasoning model in Settings.`);
      }
      if (finishReason === 'content_filter') {
        throw new Error('The response was blocked by the provider\u2019s content filter. Try a different model.');
      }
      throw new Error(
        `The model returned nothing at all`
        + `${finishReason ? ` (finish_reason: ${finishReason})` : ''}`
        + `${spent ? `, after ${spent} completion tokens` : ''}. `
        + `Check the model name in Settings against openrouter.ai/models, or try a different model.`);
    }

    return content;
  }
