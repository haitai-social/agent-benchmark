export type Dataset = {
  id: number;
  name: string;
  description: string;
  created_at: string;
};

export type DataItem = {
  id: number;
  dataset_id: number;
  environment_snapshot: Record<string, unknown>;
  user_input: string;
  agent_trajectory: unknown | null;
  agent_output: unknown;
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

export type Experiment = {
  id: number;
  name: string;
  dataset_id: number;
  dataset_name: string;
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
