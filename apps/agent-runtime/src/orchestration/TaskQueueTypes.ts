export type QueueJobStatus =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_letter";

export type QueueJobPriority = 0 | 1 | 2 | 3 | 4 | 5;

export type QueueJob = {
  id: string;
  queue_name: string;
  job_type: string;
  payload_json: string;
  status: QueueJobStatus;
  priority: QueueJobPriority;
  attempt_count: number;
  max_attempts: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  dead_letter_reason: string | null;
  created_at: string;
  updated_at: string;
  scheduled_at: string | null;
  completed_at: string | null;
};

export type EnqueueJobInput = {
  queue_name: string;
  job_type: string;
  payload: unknown;
  priority?: QueueJobPriority;
  max_attempts?: number;
  scheduled_at?: string;
};

export type DequeueResult = {
  job: QueueJob;
  lease_id: string;
};

export type QueueMetrics = {
  queue_name: string;
  queued: number;
  leased: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
  total: number;
};

export interface ITaskQueueBackend {
  enqueue(input: EnqueueJobInput): Promise<string>;
  dequeue(queueName: string, pollTimeoutMs: number): Promise<DequeueResult | null>;
  ack(jobId: string, leaseId: string): Promise<void>;
  nack(jobId: string, leaseId: string, reason?: string): Promise<QueueJobStatus>;
  deadLetter(jobId: string, leaseId: string, reason: string): Promise<void>;
  getMetrics(queueName: string): Promise<QueueMetrics>;
  listDeadLetters(queueName: string): Promise<QueueJob[]>;
  requeueDeadLetter(jobId: string): Promise<void>;
}
