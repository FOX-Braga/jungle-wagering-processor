export type DependencyStatus = "up" | "down";

export class DependencyProbe {
  private active: Promise<DependencyStatus> | undefined;

  constructor(
    private readonly probe: () => Promise<void>,
    private readonly timeoutMs = 2_000,
  ) {}

  async check(): Promise<DependencyStatus> {
    this.active ??= Promise.resolve()
      .then(this.probe)
      .then(
        () => "up" as const,
        () => "down" as const,
      )
      .finally(() => {
        this.active = undefined;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<DependencyStatus>((resolve) => {
        timer = setTimeout(resolve, this.timeoutMs, "down");
      });
      return await Promise.race([this.active, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
