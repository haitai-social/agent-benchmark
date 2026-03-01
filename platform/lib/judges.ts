import { dbQuery } from "./db";
import type { Evaluator } from "./types";

type JudgeInput = {
  trajectory: unknown;
  agentOutput: unknown;
  tools: unknown;
  userInput: string;
};

type JudgeResult = {
  score: number;
  reason: string;
};

function clampScore(score: number) {
  if (score >= 0.9) return 1;
  if (score >= 0.6) return 0.5;
  return 0;
}

function heuristicScore(key: string, input: JudgeInput): JudgeResult {
  const trajectoryText = JSON.stringify(input.trajectory);
  const outputText = JSON.stringify(input.agentOutput);
  const hasTrajectory = trajectoryText.length > 20;
  const hasOutput = outputText.length > 5;

  if (!hasTrajectory || !hasOutput) {
    return { score: 0, reason: "轨迹或输出缺失" };
  }

  switch (key) {
    case "task_success": {
      const successLike = /(success|完成|done|finished|成功)/i.test(outputText);
      return { score: successLike ? 1 : 0.5, reason: successLike ? "输出有完成信号" : "输出没有明确完成信号" };
    }
    case "trajectory_quality": {
      const stepCount = Array.isArray(input.trajectory) ? input.trajectory.length : 1;
      return { score: stepCount >= 3 ? 1 : 0.5, reason: stepCount >= 3 ? "轨迹有推进步骤" : "轨迹步骤偏少" };
    }
    case "tool_selection_quality": {
      const hasToolCall = /(tool|function|click|type|wait|call)/i.test(trajectoryText);
      return { score: hasToolCall ? 1 : 0.5, reason: hasToolCall ? "存在工具调用痕迹" : "未识别明确工具调用" };
    }
    case "tool_params": {
      const hasParams = /\{.*\}/s.test(trajectoryText);
      return { score: hasParams ? 0.5 : 0, reason: hasParams ? "检测到参数结构，建议接入真实 LLM 评估" : "缺少参数结构" };
    }
    default:
      return { score: 0.5, reason: "未知评估器，使用默认中性分" };
  }
}

async function openAiJudge(evaluator: Evaluator, input: JudgeInput): Promise<JudgeResult | null> {
  const apiKey = evaluator.api_key || process.env.OPENAI_API_KEY;
  const model = evaluator.model_name || process.env.JUDGE_MODEL || "gpt-4.1-mini";
  const baseUrl = (evaluator.base_url || "https://api.openai.com/v1").trim();
  if (!apiKey) return null;

  try {
    const prompt = evaluator.prompt_template
      .replace("{{trajectory}}", JSON.stringify(input.trajectory, null, 2))
      .replace("{{agent_output}}", JSON.stringify(input.agentOutput, null, 2))
      .replace("{{tools}}", JSON.stringify(input.tools, null, 2));

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: "你是严谨的评测员。只输出 JSON: {\"score\":0|0.5|1,\"reason\":\"...\"}" },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { score?: number; reason?: string };
    const score = parsed.score === 1 || parsed.score === 0.5 || parsed.score === 0 ? parsed.score : clampScore(Number(parsed.score ?? 0));
    return { score, reason: parsed.reason ?? "LLM judge returned score" };
  } catch {
    return null;
  }
}

export async function listEvaluatorsForExperiment(experimentId: number) {
  const { rows } = await dbQuery<Evaluator>(
    `SELECT ev.id, ev.evaluator_key, ev.name, ev.prompt_template, ev.base_url, ev.model_name, ev.api_style, ev.api_key
     FROM experiment_evaluators ee
     JOIN evaluators ev ON ev.id = ee.evaluator_id
     JOIN experiments e ON e.id = ee.experiment_id
     WHERE ee.experiment_id = $1
       AND e.deleted_at IS NULL
       AND ev.deleted_at IS NULL
     ORDER BY ev.created_at ASC`,
    [experimentId]
  );
  return rows;
}

export async function scoreByEvaluatorList(
  evaluators: Evaluator[],
  input: JudgeInput
): Promise<{ results: Array<{ evaluatorId: number; key: string; name: string; score: number; reason: string; raw: Record<string, unknown> }>; finalScore: number }> {
  const results: Array<{ evaluatorId: number; key: string; name: string; score: number; reason: string; raw: Record<string, unknown> }> = [];

  for (const evaluator of evaluators) {
    const llmResult = await openAiJudge(evaluator, input);
    const result = llmResult ?? heuristicScore(evaluator.evaluator_key, input);
    results.push({
      evaluatorId: evaluator.id,
      key: evaluator.evaluator_key,
      name: evaluator.name,
      score: result.score,
      reason: result.reason,
      raw: { source: llmResult ? "llm" : "heuristic" }
    });
  }

  const avgScore = results.length > 0 ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0;
  return {
    results,
    finalScore: Number(avgScore.toFixed(3))
  };
}
