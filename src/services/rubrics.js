// Track generation progress per task (taskId -> { step, message })
export const generationProgress = new Map();

export async function generateRubrics(taskData, trajectories, taskId) {
  const progress = (step, message) => {
    if (taskId) generationProgress.set(taskId, { step, total: 3, message, ts: Date.now() });
  };
  const baseURL = (process.env.LITELLM_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
  const apiKey = process.env.LITELLM_API_KEY;
  const generatorModel = process.env.LITELLM_MODEL || 'claude-opus-4-6';
  const criticModel = process.env.LITELLM_CRITIC_MODEL || 'gpt-5.4';

  // ─── Build shared context ───────────────────────────────────
  const milestoneIds = [];
  const rawMilestones = taskData.milestones || (taskData.user_intent && taskData.user_intent.milestones) || [];
  const milestones = rawMilestones.map((ms, i) => {
    const id = ms.milestone_id || ms.id || ms.name || `M${i+1}`;
    milestoneIds.push(id);
    let text = `Milestone: ${id}`;
    if (ms.prompt) text += `\n  Prompt: ${ms.prompt.slice(0, 500)}`;
    if (ms.continuation_criteria) text += `\n  Continuation criteria: ${ms.continuation_criteria.slice(0, 500)}`;
    if (ms.expected_completion || ms.completion) text += `\n  Expected completion: ${(ms.expected_completion || ms.completion).slice(0, 500)}`;
    if (ms.planned_interactions_list && ms.planned_interactions_list.length) {
      text += '\n  Planned interactions:';
      ms.planned_interactions_list.forEach((pi, j) => {
        const trigger = pi.trigger || '';
        const reaction = pi.reaction || '';
        text += `\n    ${j+1}. Trigger: ${trigger.slice(0, 200)}`;
        if (reaction) text += `\n       Reaction: ${reaction.slice(0, 200)}`;
      });
    }
    return text;
  }).join('\n\n');

  const guardrails = taskData.guardrails || (taskData.user_intent && taskData.user_intent.guardrails);
  const guardrailsText = guardrails
    ? Object.entries(guardrails).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : 'None specified';

  const taskDescription = taskData.description || taskData.task_description || taskData.name || taskData.task_title || 'No description';
  const problemStatement = taskData.problem_statement || '';

  // Build trajectory data
  const trajData = trajectories.map(t => {
    let turns = [];
    if (t.trajectory_json) {
      const traj = JSON.parse(t.trajectory_json);
      turns = Array.isArray(traj) ? traj : (traj.turns || traj.messages || []);
    }

    let ocTurns = [];
    if (t.opencode_json) {
      const oc = JSON.parse(t.opencode_json);
      if (oc && oc.messages) {
        oc.messages.forEach(msg => {
          const role = (msg.info && msg.info.role) || msg.role;
          if (role !== 'user' && role !== 'assistant') return;
          let text = '';
          (msg.parts || []).forEach(p => {
            if (p.type === 'text' && p.text) text += p.text + '\n';
            else if (p.type === 'tool') {
              const tn = p.tool || 'tool';
              const st = p.state || {};
              const inp = st.input || {};
              if (tn === 'bash') text += `[Tool: bash] $ ${(inp.command || '').slice(0, 200)}\n`;
              else if (tn === 'edit' || tn === 'apply_patch') text += `[Tool: ${tn}] ${(inp.filePath || inp.file_path || inp.path || '').slice(0, 150)}\n`;
              else if (tn === 'read') text += `[Tool: read] ${(inp.filePath || inp.file_path || inp.path || '').slice(0, 150)}\n`;
              else text += `[Tool: ${tn}]\n`;
            }
          });
          ocTurns.push({ role, content: text.trim() });
        });
      }
    }

    const useTurns = ocTurns.length ? ocTurns : turns;

    const turnSummaries = useTurns.map((turn, i) => {
      const role = turn.role || 'unknown';
      const content = (turn.content || '').slice(0, 600);
      return `  [${role}] ${content}`;
    }).join('\n');

    let msProgress = '';
    if (t.milestone_progress) {
      const raw = typeof t.milestone_progress === 'string' ? t.milestone_progress : JSON.stringify(t.milestone_progress);
      if (raw.includes('{')) {
        const lines = raw.trim().split('\n');
        const statuses = {};
        lines.forEach(line => {
          try { const rec = JSON.parse(line); statuses[rec.milestone_id] = rec.status; } catch(e) {}
        });
        if (Object.keys(statuses).length) {
          msProgress = '\n  Milestone progress: ' + Object.entries(statuses).map(([k,v]) => `${k}=${v}`).join(', ');
        }
      }
    }

    return `### Model: ${t.model_name} (${useTurns.length} turns)${msProgress}\n${turnSummaries}`;
  }).join('\n\n');

  // Shared task context block (reused across all 3 steps)
  const taskContext = `## Task Description
${taskDescription}
${problemStatement ? `\n## Problem Statement\n${problemStatement.slice(0, 2000)}` : ''}

## Milestones
${milestones}

## Guardrails
${guardrailsText}

## Trajectory Data
${trajData}

Milestone IDs available: ${milestoneIds.join(', ')}`;

  // ─── Helper: call LiteLLM ──────────────────────────────────
  const usageLog = [];
  async function llmCall(step, model, messages, maxTokens = 8192) {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(Object.assign({
        model,
        messages,
        max_tokens: maxTokens,
      }, model.includes('gpt-5') ? {} : { temperature: 0.3 })),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LiteLLM (${model}) returned ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const u = data.usage || {};
    console.log(`[Rubrics]   ${model} — ${u.prompt_tokens || '?'} in / ${u.completion_tokens || '?'} out / ${u.total_tokens || '?'} total tokens`);
    usageLog.push({ step, model, prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0 });
    return data.choices[0].message.content.trim();
  }

  function parseJSON(content) {
    let jsonStr = content;
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    return JSON.parse(jsonStr);
  }

  // ─── STEP 1: Opus generates initial rubrics ────────────────
  progress(1, 'Generating initial rubrics...');
  console.log('[Rubrics] Step 1: Generating initial rubrics with', generatorModel);

  const step1Prompt = `You are an expert evaluator creating binary PASS/FAIL rubrics for assessing AI coding agent trajectories.

${taskContext}

## Rubric Types

Generate rubrics across these four types:
- **correctness**: Whether the agent produced the correct output, made the right code changes, and met the functional requirements. These should be concrete and testable - they should help an agentic grader understand what to verify in the final environment or final answer.
- **communication**: Quality of agent-user interaction, including clarifying questions, intermediate updates, explanations, final summaries, and requested usage guidance.
- **agent_behavior**: Workflow quality, such as planning, exploration, reproduction of issues, verification before claiming success, recovery from errors, and effective tool usage.
- **code_style**: Specific and relevant code quality concerns for this task. Avoid generic filler like "follows best practices."

## Rubric-Writing Rules

- Use milestone structure heavily. Most rubrics MUST target a single milestone. Every milestone must have at least one rubric.
- Use milestone requirements, planned interactions, continuation criteria, and expected behaviors to decide what should be graded.
- Use the trajectory to identify where the model succeeded, failed, needed correction, communicated well or poorly, verified appropriately or inappropriately, or chose a good or bad workflow.
- If the trajectory shows the user had to provide hints, corrections, retries, or clarifications, it is valid to create rubrics that reward not needing them or penalize requiring them, but only if supported by the milestone definition.
- Avoid vague wording. Be specific.
- Avoid duplicate rubrics.
- Avoid multi-part criteria joined by too many "and" or "or" conditions. Each rubric should be atomic.
- Avoid harness-specific wording. The rubrics should apply regardless of whether the agent used OpenCode or another coding harness.
- Can this rubric apply to any other task? If yes, it is not a good rubric. Every rubric must be specific to THIS task.

## Output Format

For each rubric, provide:
- criterion: A clear, specific statement that can be evaluated as true/false
- type: One of "correctness", "communication", "agent_behavior", "code_style"
- milestone_id: The milestone this relates to (use the milestone id from above; use null ONLY for rubrics that genuinely span the entire task)
- is_positive: true if PASS means the criterion IS met, false if PASS means the criterion is NOT met
- importance: "MUST_FOLLOW" for critical requirements, "GOOD_TO_HAVE" for nice-to-haves
- rationale: Brief explanation of why this rubric matters

## Type Distribution (STRICT)

You MUST follow this distribution across the 20 rubrics:
- **correctness**: 10-14 rubrics (50-70%)
- **agent_behavior**: 3-5 rubrics
- **communication**: 2-4 rubrics
- **code_style**: 1-3 rubrics

Do NOT make all rubrics correctness. The non-correctness rubrics are just as important for distinguishing strong vs weak trajectories.

Generate exactly 20 rubrics. Respond with ONLY a JSON array. No markdown fences, no explanation.`;

  const step1Raw = await llmCall('generate', generatorModel, [{ role: 'user', content: step1Prompt }]);
  const step1Rubrics = parseJSON(step1Raw);
  console.log('[Rubrics] Step 1 complete:', step1Rubrics.length, 'rubrics generated');

  // ─── STEP 2: GPT 5.4 critiques the rubrics ────────────────
  progress(2, 'Critiquing rubrics...');
  console.log('[Rubrics] Step 2: Critiquing rubrics with', criticModel);

  const step2Prompt = `You are a senior evaluation specialist reviewing a set of rubrics that were generated for grading AI coding agent trajectories. Your job is to provide a thorough, structured critique.

${taskContext}

## Generated Rubrics to Review
${JSON.stringify(step1Rubrics, null, 2)}

## Your Critique Should Cover

1. **Coverage gaps**: Are there important aspects of the task or milestones that no rubric addresses? List specific missing rubrics.
2. **Redundancies**: Are any rubrics duplicative or testing the same thing in different words? Identify pairs.
3. **Vague criteria**: Which rubrics are too vague to be consistently evaluated as PASS/FAIL by different graders? Suggest how to sharpen them.
4. **Specificity**: Which rubrics are generic enough to apply to any task? These need to be rewritten to be task-specific.
5. **Milestone coverage**: Does every milestone have at least one rubric? Are the rubrics well-distributed or clustered on just a few milestones?
6. **Type balance**: Is there a reasonable spread across correctness, communication, agent_behavior, and code_style? Or is it too heavily weighted toward one type?
7. **Atomic violations**: Which rubrics try to test multiple things at once and should be split?
8. **Suggested additions**: Propose up to 5 new rubrics that would meaningfully improve the evaluation, with full details (criterion, type, milestone_id, is_positive, importance, rationale).
9. **Suggested removals**: Which rubrics are the weakest and should be dropped to make room?

Be specific and reference rubrics by their criterion text. Provide actionable feedback, not vague praise.`;

  const step2Critique = await llmCall('critique', criticModel, [{ role: 'user', content: step2Prompt }], 4096);
  console.log('[Rubrics] Step 2 complete: critique received');

  // ─── STEP 3: Opus judges and finalizes ─────────────────────
  progress(3, 'Finalizing rubrics...');
  console.log('[Rubrics] Step 3: Finalizing rubrics with', generatorModel);

  const step3Prompt = `You are the final judge in a rubric generation pipeline. You previously generated a set of rubrics for evaluating AI coding agent trajectories. An independent critic has reviewed them. Your job is to produce the final, refined set of exactly 20 rubrics.

${taskContext}

## Your Original Rubrics
${JSON.stringify(step1Rubrics, null, 2)}

## Independent Critique
${step2Critique}

## Your Task

Produce the final set of exactly 20 rubrics by:
1. Addressing valid points from the critique — fix vague criteria, improve specificity, fill coverage gaps, remove redundancies.
2. Dismissing critique points that are wrong or unhelpful — the critic may have misunderstood the task or milestones.
3. Incorporating suggested additions if they genuinely improve the evaluation.
4. Dropping the weakest rubrics to stay at exactly 20.
5. Ensuring every milestone has at least one rubric.
6. STRICTLY enforcing this type distribution:
   - correctness: 10-14 rubrics (50-70%)
   - agent_behavior: 3-5 rubrics
   - communication: 2-4 rubrics
   - code_style: 1-3 rubrics

For each rubric, provide:
- criterion: A clear, specific statement that can be evaluated as true/false
- type: One of "correctness", "communication", "agent_behavior", "code_style"
- milestone_id: The milestone this relates to (use null ONLY for rubrics that genuinely span the entire task)
- is_positive: true if PASS means the criterion IS met, false if PASS means the criterion is NOT met
- importance: "MUST_FOLLOW" for critical requirements, "GOOD_TO_HAVE" for nice-to-haves
- rationale: Brief explanation of why this rubric matters

Respond with ONLY a JSON array of exactly 20 rubrics. No markdown fences, no explanation.`;

  const step3Raw = await llmCall('finalize', generatorModel, [{ role: 'user', content: step3Prompt }]);
  const finalRubrics = parseJSON(step3Raw);
  console.log('[Rubrics] Step 3 complete:', finalRubrics.length, 'final rubrics');

  if (!Array.isArray(finalRubrics)) throw new Error('Final step did not return an array');

  // ─── Normalize and validate ────────────────────────────────
  const validTypes = ['correctness', 'communication', 'agent_behavior', 'code_style'];

  const rubrics = finalRubrics.slice(0, 20).map(r => ({
    criterion: r.criterion || r.description || '',
    type: validTypes.includes(r.type) ? r.type : 'correctness',
    milestone_id: r.milestone_id || null,
    is_positive: r.is_positive !== false,
    importance: ['MUST_FOLLOW', 'GOOD_TO_HAVE', 'UNIVERSAL'].includes(r.importance) ? r.importance : 'MUST_FOLLOW',
    rationale: r.rationale || '',
  })).filter(r => r.criterion);

  // Compute usage summary
  const totalIn = usageLog.reduce((s, u) => s + u.prompt_tokens, 0);
  const totalOut = usageLog.reduce((s, u) => s + u.completion_tokens, 0);
  // Pricing: Opus $15/$75 per 1M, GPT 5.4 estimate $10/$30 per 1M
  const cost = usageLog.reduce((s, u) => {
    const isOpus = u.model.includes('claude');
    const inRate = isOpus ? 15 : 10;
    const outRate = isOpus ? 75 : 30;
    return s + (u.prompt_tokens * inRate + u.completion_tokens * outRate) / 1_000_000;
  }, 0);

  if (taskId) generationProgress.delete(taskId);

  return {
    rubrics,
    usage: {
      steps: usageLog,
      total_input: totalIn,
      total_output: totalOut,
      total_tokens: totalIn + totalOut,
      estimated_cost: Math.round(cost * 1000) / 1000,
    }
  };
}
