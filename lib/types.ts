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
  docker_image: string;
  openapi_spec: Record<string, unknown>;
  status: string;
  metadata: Record<string, unknown>;
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
  status: string;
  created_at: string;
};

export type ExperimentRun = {
  id: number;
  experiment_id: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, unknown>;
};
