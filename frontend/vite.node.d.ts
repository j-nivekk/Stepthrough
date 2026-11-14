// The little of Node that vite.config.ts uses, so that its type check needs no @types/node.
declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: { stdio?: readonly ('ignore' | 'pipe')[] },
  ): { toString(): string };
}

declare const process: { env: Record<string, string | undefined> };
