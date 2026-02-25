export type Dataset = {
  id: string;
  name: string;
  description: string;
  created_at: string;
};

export type DataItem = {
  id: string;
  dataset_id: string;
  name: string;
  environment_snapshot: Record<string, unknown>;
  user_input: string;
  agent_trajectory: unknown | null;
  agent_output: unknown;
  created_at: string;
};

export type Evaluator = {
  id: string;
  evaluator_key: string;
  name: string;
  prompt_template: string;
  base_url: string;
  model_name: string;
};

export type Experiment = {
  id: string;
  name: string;
  dataset_id: string;
  dataset_name: string;
  agent_version: string;
  status: string;
  created_at: string;
};

export type ExperimentRun = {
  id: string;
  experiment_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, unknown>;
};
