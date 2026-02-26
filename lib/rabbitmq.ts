import { randomUUID } from "node:crypto";

type QueueDispatchPayload = {
  experiment_id: number;
  dataset: {
    id: number;
    name: string;
  };
  agent: {
    id: number;
    name: string;
    agent_key: string;
    version: string;
    docker_image: string;
    openapi_spec: unknown;
    metadata: unknown;
  };
  evaluators: Array<{
    id: number;
    evaluator_key: string;
    name: string;
    prompt_template: string;
    base_url: string;
    model_name: string;
  }>;
  run_cases: Array<{
    run_case_id: number;
    data_item_id: number;
    attempt_no: number;
    session_jsonl: string;
    user_input: string;
    trace_id: string | null;
    reference_trajectory: unknown;
    reference_output: unknown;
  }>;
  triggered_by: string;
};

function mustEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function toRabbitUrl() {
  const host = mustEnv("RABBITMQ_HOST");
  const port = mustEnv("RABBITMQ_PORT");
  const user = encodeURIComponent(mustEnv("RABBITMQ_USER"));
  const password = encodeURIComponent(mustEnv("RABBITMQ_PASSWORD"));
  const rawVhost = mustEnv("RABBITMQ_VHOST");
  const vhost = rawVhost === "/" ? "%2F" : encodeURIComponent(rawVhost);
  return `amqp://${user}:${password}@${host}:${port}/${vhost}`;
}

export async function publishExperimentRunRequested(payload: QueueDispatchPayload) {
  const amqplib = await import("amqplib");
  const queueName = process.env.RABBITMQ_EXPERIMENT_QUEUE || "haitai.agent.benchmark.experiment";
  const url = toRabbitUrl();
  const connection = await amqplib.connect(url);

  try {
    const channel = await connection.createConfirmChannel();
    try {
      await channel.assertQueue(queueName, { durable: true });
      const messageId = randomUUID();
      const message = {
        message_type: "experiment.run.requested",
        schema_version: "v1",
        message_id: messageId,
        produced_at: new Date().toISOString(),
        source: {
          service: "arcloop-agent-benchmark",
          queue: queueName
        },
        experiment: {
          id: payload.experiment_id,
          triggered_by: payload.triggered_by
        },
        dataset: payload.dataset,
        agent: payload.agent,
        evaluators: payload.evaluators,
        run_cases: payload.run_cases,
        consumer_hints: {
          should_start_agent_container: true,
          should_emit_case_trajectory: true,
          should_emit_case_output: true,
          should_persist_evaluate_results: true
        }
      };

      channel.sendToQueue(queueName, Buffer.from(JSON.stringify(message), "utf-8"), {
        persistent: true,
        contentType: "application/json",
        messageId
      });
      await channel.waitForConfirms();
      return { messageId, queueName };
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
}
