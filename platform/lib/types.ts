export type Dataset = {
  id: number;
  name: string;
  description: string;
  created_at: string;
};

export type DataItem = {
  id: number;
  dataset_id: number;
  session_jsonl: string;
  user_input: string;
  reference_output: unknown;
  trace_id: string | null;
  reference_trajectory: unknown | null;
  created_at: string;
};

export type Evaluator = {
  id: number;
  evaluator_key: string;
  name: string;
  prompt_template: string;
  base_url: string;
  model_name: string;
};

export type Agent = {
  id: number;
  agent_key: string;
  version: string;
  name: string;
  description: string;
  runtime_spec_json: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
};

export type Experiment = {
  id: number;
  name: string;
  dataset_id: number;
  dataset_name: string;
  agent_id: number;
  agent_key: string;
  agent_version: string;
  queue_message_id: string | null;
  queued_at: string | null;
  queue_status: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type RunCase = {
  id: number;
  experiment_id: number;
  data_item_id: number;
  agent_id: number;
  attempt_no: number;
  is_latest: boolean;
  status: string;
  final_score: number | null;
  agent_trajectory: unknown | null;
  agent_output: unknown | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_message: string | null;
  logs: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type EvaluateResult = {
  id: number;
  run_case_id: number;
  evaluator_id: number;
  evaluator_key: string;
  evaluator_name: string;
  score: number;
  reason: string;
  raw_result: Record<string, unknown>;
  created_at: string;
};

export type ExperimentEvaluator = {
  id: number;
  experiment_id: number;
  evaluator_id: number;
};
