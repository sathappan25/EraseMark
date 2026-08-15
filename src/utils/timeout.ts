export class RestoreStageError extends Error {
  stage: string;

  constructor(stage: string, reason: string) {
    super(reason);
    this.name = "RestoreStageError";
    this.stage = stage;
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new RestoreStageError(
          stage,
          `Processing failed at: ${stage}. Try Manual Restore.`,
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
